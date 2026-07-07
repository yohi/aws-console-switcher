/**
 * Service Worker メッセージルーター（task 4.1）。
 *
 * Popup / Content Script からの `ExtMessage` を判別共用体で受理し、
 * 対応する処理へ振り分ける。揮発状態をメモリに保持せず、FlowContext は
 * `chrome.storage.local` へ永続化する。
 */
import {
  type AccountMeta,
  type ExtMessage,
  type FlowContext,
  type FlowError,
  type HostRequest,
  type SigninDomEvent,
  isExtMessage,
  makeFlowError,
} from "@acs/shared";
import {
  type StorageArea,
  loadAccountMetaCache,
  loadExtensionSettings,
  loadFlowContext,
  removeFlowContext,
  saveAccountMetaCache,
  saveExtensionSettings,
  saveFlowContext,
} from "./storage.js";
import {
  type CredentialProvider,
  type SecretSourceAdapter,
} from "../secrets/bitwarden-credential-provider.js";
import { type AlarmsApi, scheduleFlowTimeout } from "./flow-alarms.js";
import { logFlowError } from "./error-logging.js";
import {
  type LoginEvent,
  LoginStateMachine,
} from "./login-state-machine.js";
import { createLiveLoginMessenger } from "./live-login-messenger.js";
import { cleanupFlow } from "./tab-watchers.js";

/**
 * `chrome.tabs` からルーターが必要とするメソッドのみを切り出した抽象。
 */
export interface TabsApi {
  create(
    createProperties: { url: string; active?: boolean },
  ): Promise<chrome.tabs.Tab>;
  update(tabId: number, updateProperties: object): Promise<chrome.tabs.Tab>;
  query(queryInfo: object): Promise<chrome.tabs.Tab[]>;
  /** CS への値注入コマンド送信（chrome.tabs.sendMessage の抽象。LoginMessenger のライブ実装が使用）。 */
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/**
 * メッセージルーターが依存する外部リソース。
 */
export interface MessageRouterDeps {
  readonly storage: StorageArea;
  readonly credentialProvider: CredentialProvider;
  readonly tabs: TabsApi;
  readonly runtime: Pick<typeof chrome.runtime, "sendMessage">;
  readonly hostName: string;
  readonly alarms: AlarmsApi;
  readonly adapter: SecretSourceAdapter;
}

/**
 * ルーター応答。Popup 等へ返す簡易な結果型。
 */
export type RouterResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: FlowError };

/**
 * `chrome.runtime.onMessage` リスナー用の境界関数。
 * 未知メッセージは無視する。
 */
export async function handleMessage(
  deps: MessageRouterDeps,
  message: unknown,
): Promise<RouterResponse> {
  if (!isExtMessage(message)) {
    return { ok: true, value: undefined };
  }
  const response = await routeMessage(deps, message);
  if (!response.ok) {
    // design.md「Monitoring」: 失敗は category/code を構造化ログとして記録する（秘匿値は出力禁止）。
    // 全エラー返却経路を個別に計測せず、この単一境界へ集約する（message.kind は非秘匿）。
    logFlowError(response.error, { messageKind: message.kind });
  }
  return response;
}

/**
 * 判別共用体に基づきメッセージをルーティングする。
 */
export async function routeMessage(
  deps: MessageRouterDeps,
  message: ExtMessage,
): Promise<RouterResponse> {
  switch (message.kind) {
    case "listAccounts":
      return listAccounts(deps);
    case "startLogin":
      return startLogin(deps, message.uuid);
    case "cancelLogin":
    case "retryLogin":
      return resetFlow(deps, message.uuid);
    case "unlock":
      return unlock(deps, message.masterPassword);
    case "lock":
      return lock(deps);
    case "updateSettings":
      return updateSettings(deps, message);
    case "syncAccounts":
      return syncAccounts(deps);
    case "signinDomEvent":
      return handleSigninDomEvent(deps, message);
    case "consoleState":
      return handleConsoleState(message);
    default: {
      const _exhaustive: never = message;
      return { ok: true, value: _exhaustive };
    }
  }
}

/**
 * アカウント一覧を返す（task 8.1, requirements 3.4/3.1）。
 *
 * cache-then-fallback: まず `chrome.storage.local` の非秘匿メタデータキャッシュを読み、
 * 非空ならホスト往復なしで Popup へ返す（ライブ往復を毎回行わない）。
 * キャッシュが空（同期前の初回起動等）の場合のみホストから新規取得し、
 * 以降の呼び出しがキャッシュから読めるよう取得結果を保存してから返す。
 */
async function listAccounts(deps: MessageRouterDeps): Promise<RouterResponse> {
  const cached = await loadAccountMetaCache(deps.storage);
  if (cached.length > 0) {
    return { ok: true, value: { accounts: cached } };
  }
  const result = await deps.credentialProvider.listAccounts();
  if (!result.ok) {
    return result;
  }
  // 初回フォールバック取得結果をキャッシュし、次回以降はキャッシュから読む。
  await saveAccountMetaCache(deps.storage, result.value);
  return { ok: true, value: { accounts: result.value } };
}

async function startLogin(
  deps: MessageRouterDeps,
  uuid: string,
): Promise<RouterResponse> {
  const accounts = await deps.credentialProvider.listAccounts();
  if (!accounts.ok) {
    return accounts;
  }
  const account = accounts.value.find((a: AccountMeta) => a.uuid === uuid);
  if (!account) {
    return {
      ok: false,
      error: makeFlowError(
        "invalid_configuration",
        `Account ${uuid} not found in cache.`,
      ),
    };
  }

  const url = account.signInUrl ?? buildAccountUrl(account);
  const tab = await deps.tabs.create({ url, active: true });
  if (tab.id === undefined) {
    return {
      ok: false,
      error: makeFlowError(
        "host_not_running",
        "Failed to create sign-in tab.",
      ),
    };
  }

  const ctx: FlowContext = {
    tabId: tab.id,
    uuid,
    step: "routing",
    startedAt: new Date().toISOString(),
    mfaRetryCount: 0,
  };
  await saveFlowContext(deps.storage, ctx);
  // フロー開始時に dom_timeout 監視アラームを登録する（task 4.4, design.md 2.2）。
  scheduleFlowTimeout(deps.alarms, ctx);

  return { ok: true, value: { tabId: tab.id } };
}

function buildAccountUrl(account: AccountMeta): string {
  const aliasOrId = account.alias ?? account.accountId;
  return `https://${aliasOrId}.signin.aws.amazon.com/console/`;
}

async function resetFlow(
  deps: MessageRouterDeps,
  uuid: string,
): Promise<RouterResponse> {
  // UUID から tabId を特定するため storage を走査（簡易実装）。
  const all = await deps.storage.get(null);
  const flowKey = Object.keys(all).find(
    (key) =>
      key.startsWith("flow:") &&
      (all[key] as FlowContext).uuid === uuid,
  );
  if (flowKey) {
    const tabId = Number(flowKey.split(":")[1]);
    await removeFlowContext(deps.storage, tabId);
  }
  return { ok: true, value: undefined };
}

async function unlock(
  deps: MessageRouterDeps,
  masterPassword: string,
): Promise<RouterResponse> {
  const result = await deps.adapter.send({
    type: "unlock",
    masterPassword,
  } as Omit<HostRequest, "requestId">);
  if (!result.ok) {
    return result;
  }
  if (result.value.type === "error") {
    return { ok: false, error: result.value.error };
  }
  if (result.value.type !== "unlocked") {
    return {
      ok: false,
      error: makeFlowError(
        "host_disconnected",
        "Unexpected response to unlock.",
      ),
    };
  }
  // アンロック成功直後にホストへ設定を伝達する（design.md 4.1.1, requirements 4.1.1）。
  const settings = await loadExtensionSettings(deps.storage);
  const configureResult = await deps.adapter.send({
    type: "configure",
    idleLockMinutes: settings.idleLockMinutes,
    totpMinRemainingSeconds: settings.totpMinRemainingSeconds,
  } as Omit<HostRequest, "requestId">);
  // configure は best-effort: unlock 自体は成功しているため失敗しても unlock 全体は失敗させない（design.md 4.1.1）。
  const configured =
    configureResult.ok && configureResult.value.type === "configured";
  // アンロック解除後の初回アクセスでメタデータを再同期する（design.md 8.1 の起点）。
  const accountsResult = await deps.credentialProvider.listAccounts();
  return {
    ok: true,
    value: {
      unlocked: true,
      configured,
      accounts: accountsResult.ok ? accountsResult.value : [],
    },
  };
}

async function lock(deps: MessageRouterDeps): Promise<RouterResponse> {
  const result = await deps.adapter.send({ type: "lock" } as Omit<
    HostRequest,
    "requestId"
  >);
  if (!result.ok) {
    return result;
  }
  if (result.value.type === "error") {
    return { ok: false, error: result.value.error };
  }
  if (result.value.type !== "locked") {
    return {
      ok: false,
      error: makeFlowError(
        "host_disconnected",
        "Unexpected response to lock.",
      ),
    };
  }
  return { ok: true, value: undefined };
}

/**
 * 設定変更時にホストへ設定（アイドルロック分数・TOTP 最小残秒数）を伝達し、
 * ホストが受領（configured）した場合のみ拡張側へ永続化する（design.md 4.1.1）。
 */
async function updateSettings(
  deps: MessageRouterDeps,
  message: Extract<ExtMessage, { kind: "updateSettings" }>,
): Promise<RouterResponse> {
  const current = await loadExtensionSettings(deps.storage);
  const next = {
    idleLockMinutes: message.idleLockMinutes ?? current.idleLockMinutes,
    totpMinRemainingSeconds:
      message.totpMinRemainingSeconds ?? current.totpMinRemainingSeconds,
  };
  const configureResult = await deps.adapter.send({
    type: "configure",
    ...next,
  } as Omit<HostRequest, "requestId">);
  if (!configureResult.ok) {
    return configureResult;
  }
  if (configureResult.value.type !== "configured") {
    return {
      ok: false,
      error:
        configureResult.value.type === "error"
          ? configureResult.value.error
          : makeFlowError(
              "host_disconnected",
              "Unexpected response to configure.",
            ),
    };
  }
  await saveExtensionSettings(deps.storage, next);
  return { ok: true, value: undefined };
}

/**
 * メタデータを再同期する（task 8.1, requirements 3.4 (b)）。
 *
 * ホストから新規列挙し、成功時にキャッシュを上書き更新（write-on-sync）してから返す。
 * 手動「同期」操作（3.4 (b)）の明示的な再同期経路であり、キャッシュを永続化する唇一の基準とする。
 */
async function syncAccounts(
  deps: MessageRouterDeps,
): Promise<RouterResponse> {
  const result = await deps.credentialProvider.listAccounts();
  if (!result.ok) {
    return result;
  }
  await saveAccountMetaCache(deps.storage, result.value);
  return { ok: true, value: { accounts: result.value } };
}

async function handleSigninDomEvent(
  deps: MessageRouterDeps,
  message: Extract<ExtMessage, { kind: "signinDomEvent" }>,
): Promise<RouterResponse> {
  const ctx = await loadFlowContext(deps.storage, message.tabId);
  if (!ctx || ctx.uuid !== message.uuid) {
    return { ok: true, value: undefined };
  }

  // LoginStateMachine（task 4.2）を本経路へライブ配線する（tasks 4.2/5.2/8.2 の結線: 値注入と
  // totp_rejected の自動再試行をライブ駆動）。ステートマシンはステートレスなため、`scheduleFlowTimeout`
  // 同様に「小さな部品を都度合成」する方針で要求ごとに生成し、MessageRouterDeps を不必要に広げない。
  const stateMachine = new LoginStateMachine(
    deps.credentialProvider,
    createLiveLoginMessenger(deps.tabs),
    deps.storage,
  );
  const action = await stateMachine.handleEvent(
    ctx,
    signinDomEventToLoginEvent(message.event),
  );

  if (action.step === "failed") {
    // 失敗遷移: クリーンアップ単一経路（tab-watchers.ts の cleanupFlow）を通し、構造化ログを
    // 記録してから失敗を呼び出し側へ伝搬する（design.md「Monitoring」/ 単一クリーンアップ経路）。
    await cleanupFlow(deps.storage, deps.alarms, ctx.tabId);
    logFlowError(action.error, { tabId: ctx.tabId, uuid: ctx.uuid });
    return { ok: false, error: action.error };
  }
  if (action.step === "done") {
    // `done` は console 遷移（consoleRedirect）でのみ到達し、それは tabs.onUpdated（tab-watchers.ts）が
    // 単一の done 経路として担う。本経路は CS 由来イベントのみを渡し consoleRedirect を含まないため
    // 到達しないが、型の網羅性のため同一クリーンアップ経路で安全に閉じる（recordSession は done 経路側の責務）。
    await cleanupFlow(deps.storage, deps.alarms, ctx.tabId);
    return { ok: true, value: undefined };
  }

  // in-flight 遷移（awaiting_account_id / awaiting_credentials / awaiting_mfa）:
  // ステートマシンが載せた ctx 上書き（例: totp 再試行の mfaRetryCount, task 9.1）を反映しつつ、
  // 新ステップを永続化し、状態依存の監視窓でアラームを (再)登録する（design.md 2.2）。
  const updated: FlowContext = {
    ...ctx,
    ...(action.ctx ?? {}),
    step: action.step,
  };
  await saveFlowContext(deps.storage, updated);
  scheduleFlowTimeout(deps.alarms, updated);
  return { ok: true, value: undefined };
}

/**
 * `SigninDomEvent`（@acs/shared, CS 由来）を LoginStateMachine の `LoginEvent` へ 1:1 写像する。
 * 両者は構造的に近いが別定義であり、`SigninDomEvent` は SW 内部専用の `consoleRedirect`（C-2）を
 * 含まない。共有 5 メンバのみを写像する（`consoleRedirect` は tabs.onUpdated が別経路で扱う）。
 */
function signinDomEventToLoginEvent(event: SigninDomEvent): LoginEvent {
  switch (event) {
    case "accountIdFieldShown":
      return { event: "accountIdFieldShown" };
    case "credentialFieldShown":
      return { event: "credentialFieldShown" };
    case "mfaScreenShown":
      return { event: "mfaScreenShown" };
    case "authError":
      return { event: "authError" };
    case "domTimeout":
      return { event: "domTimeout" };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

async function handleConsoleState(
  _message: Extract<ExtMessage, { kind: "consoleState" }>,
): Promise<RouterResponse> {
  // task 5.3 / 8.1 でセッション補正を実装する。
  return { ok: true, value: undefined };
}
