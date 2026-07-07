/**
 * Service Worker エントリ（ステートレス・プロキシの bootstrap）。
 *
 * DI スタイルでユニットテスト済みの各モジュール（message-router / tab-watchers /
 * session-manager / native-messaging-adapter / bitwarden-credential-provider /
 * flow-alarms / storage）を実 `chrome.*` API へ配線する。揮発状態はメモリに保持せず、
 * フロー状態は `FlowContext`（`chrome.storage.local`, `tabId` キー）で管理し SW 再起動後も復元する
 * （design.md「ServiceWorker」2.2 / C-1）。
 *
 * SECURITY: `unlock` メッセージの `masterPassword` は `chrome.runtime` メッセージバス上を平文で
 * 通過する（拡張の構造的制約）。SW 側はホストへ受け渡すのみで、値そのものやメッセージ全体を
 * `console.log` 等へ出力しない（tech.md「Secret Handling: Never persist password/TOTP」, 4.1.1）。
 */
import { makeFlowError } from "@acs/shared";
import { NATIVE_HOST_NAME } from "../native-host-name.js";
import { NativeMessagingAdapter } from "../secrets/native-messaging-adapter.js";
import { BitwardenCredentialProvider } from "../secrets/bitwarden-credential-provider.js";
import {
  type MessageRouterDeps,
  type TabsApi as RouterTabsApi,
  handleMessage,
  performNewLogin,
} from "./message-router.js";
import {
  type SessionWindowsApi,
  type SessionTabsApi,
  createSessionManager,
} from "./session-manager.js";
import {
  type TabsApi as WatcherTabsApi,
  recordSession,
  startTabWatchers,
} from "./tab-watchers.js";
import { createLiveLoginMessenger } from "./live-login-messenger.js";
import { logFlowError } from "./error-logging.js";
import { type StorageArea } from "./storage.js";
import { type AlarmsApi } from "./flow-alarms.js";
import { type ScriptingApi } from "./console-state-detector.js";

/**
 * bootstrap が扱う `chrome.tabs` 抽象。
 *
 * 各モジュールが要求する最小 tabs 契約（ルーターの create/update/query/sendMessage、
 * tab-watchers の onUpdated/onRemoved、SessionManager の update/onActivated）の合成。
 * 実 `chrome.tabs` は多重定義（オーバーロード）を持ち本合成へ構造的に一致しないため、
 * 実行時の注入は composition root（末尾の `bootstrapServiceWorker` 呼び出し）で
 * `as unknown as` して橋渡しする（既存テストと同じ DI 境界の規約。`as any` は使わない）。
 */
type ServiceWorkerTabsApi = RouterTabsApi & WatcherTabsApi & SessionTabsApi;

/**
 * bootstrap が注入を受ける `chrome.*` API 群。
 *
 * 実行時は本番の `chrome.*` を、テスト時は DI フェイクを（既存テストと同じく境界で
 * `as unknown as` して）渡す。個々の抽象（`StorageArea` / `AlarmsApi` /
 * `SessionWindowsApi`）は各モジュールが必要とする最小メソッドのみを要求する。
 */
export interface ServiceWorkerApis {
  readonly storage: StorageArea;
  readonly tabs: ServiceWorkerTabsApi;
  readonly runtime: typeof chrome.runtime;
  readonly alarms: AlarmsApi;
  readonly windows: SessionWindowsApi;
  /** console-state-detector.ts のコンソール状態検出注入に用いる（task 5.3）。 */
  readonly scripting: ScriptingApi;
}

/**
 * 各モジュールを実 `chrome.*` API へ配線する（task 4 / 6.1 の本番結線）。
 *
 * 副作用: `chrome.runtime.onMessage` / `chrome.tabs.onUpdated` / `chrome.tabs.onRemoved` /
 * `chrome.alarms.onAlarm` / `chrome.tabs.onActivated`（SessionManager 構築時）へリスナーを登録する。
 */
export function bootstrapServiceWorker(apis: ServiceWorkerApis): void {
  const { storage, tabs, runtime, alarms, windows, scripting } = apis;

  // Native Messaging 実インスタンス（本番ホスト名で connectNative）を 1 つ構築し、
  // BitwardenCredentialProvider へ注入する（design.md §4.2 の既定実装組み合わせ）。
  const adapter = new NativeMessagingAdapter(runtime, NATIVE_HOST_NAME);
  const credentialProvider = new BitwardenCredentialProvider(adapter);

  // SessionManager は 1 度だけ構築する（構築時に tabs.onActivated を購読し、TOCTOU 直列化キューを
  // インスタンス内に保持する）。onNewLoginRequired は新規ログイン確定時にのみ呼ばれ、message-router の
  // performNewLogin（タブ作成 + FlowContext 保存 + アラーム登録）を再利用する（二重実装しない）。
  // deps は下で構築するが、当該クロージャはメッセージ処理中にのみ呼ばれるため参照で足りる。
  let deps: MessageRouterDeps;
  const sessionManager = createSessionManager({
    storage,
    tabs,
    windows,
    onNewLoginRequired: async (uuid) => {
      const result = await performNewLogin(deps, uuid);
      if (!result.ok) {
        // switchTo（session-manager）側が例外を catch し FlowError へ写像する（Result 契約を守る）。
        throw new Error(result.error.message);
      }
    },
  });

  deps = {
    storage,
    credentialProvider,
    tabs,
    runtime,
    hostName: NATIVE_HOST_NAME,
    alarms,
    adapter,
    sessionManager,
    scripting,
  };

  // グローバルスコープでタブ/アラーム監視を登録する（MV3 SW 再起動時もイベントで起床する, task 4.3/4.4）。
  startTabWatchers({
    storage,
    tabs,
    alarms,
    // console 遷移検知（done 経路）で SessionRecord を作成する（tab-watchers.ts の recordSession）。
    onConsoleDetected: (_tabId, ctx) => recordSession(storage, ctx),
    // dom_timeout / MFA 再試行上限超過などの失敗は構造化ログへ集約する（design.md「Monitoring」, 秘匿値は出力しない）。
    onFlowFailed: (tabId, ctx, error) =>
      logFlowError(error, { tabId, uuid: ctx.uuid }),
    credentialProvider,
    messenger: createLiveLoginMessenger(tabs),
  });

  // Popup / Content Script からのメッセージを handleMessage へ委譲し、sendResponse で非同期応答する。
  // popup.ts は `chrome.runtime.sendMessage` の解決値を PopupResponse（= RouterResponse）として
  // 解釈するため、返却形状をそれに整合させる。
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(deps, message)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        // 予期しない例外も PopupResponse 互換の失敗形へ写像する（Popup が isFlowError で解釈できるように）。
        sendResponse({
          ok: false,
          error: makeFlowError(
            "host_disconnected",
            error instanceof Error
              ? error.message
              : "Unexpected Service Worker error.",
          ),
        });
      });
    // MV3: 非同期に sendResponse するため true を返し、メッセージチャネルを開いたままにする。
    return true;
  });
}

// 実 Service Worker 実行環境でのみ bootstrap する（型検査/非 SW import は素通り。popup.ts と同じ規約）。
if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage !== undefined &&
  chrome.storage?.local !== undefined
) {
  bootstrapServiceWorker({
    storage: chrome.storage.local,
    tabs: chrome.tabs as unknown as ServiceWorkerTabsApi,
    runtime: chrome.runtime,
    alarms: chrome.alarms as unknown as AlarmsApi,
    windows: chrome.windows,
    scripting: chrome.scripting as unknown as ScriptingApi,
  });
}
