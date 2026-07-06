/**
 * グローバルタブ監視・アラームによるタイムアウト計測・クリーンアップ単一経路（task 4.3 / 4.4）。
 *
 * `chrome.tabs.onUpdated` で console URL 遷移を検知し `done` 遷移を駆動、
 * `chrome.tabs.onRemoved` でフロー進行中タブの閉鎖を検知して即時クリーンアップする（task 4.3）。
 * `chrome.alarms.onAlarm` で `flowTimeout:{tabId}` の満了を検知し、ステップに応じて dom_timeout
 * 失敗、または awaiting_mfa の TOTP 再発行（上限まで）で回復する（task 4.4, design.md 2.2）。
 */
import {
  type FlowContext,
  type FlowError,
  type SessionRecord,
  makeFlowError,
} from "@acs/shared";
import {
  type StorageArea,
  loadFlowContext,
  removeFlowContext,
  saveFlowContext,
} from "./storage.js";
import { type CredentialProvider } from "../secrets/bitwarden-credential-provider.js";
import { type LoginMessenger } from "./login-state-machine.js";
import {
  type AlarmsApi,
  MFA_RETRY_LIMIT,
  flowAlarmName,
  parseFlowAlarmName,
  scheduleFlowTimeout,
} from "./flow-alarms.js";

// 既存テスト（tab-watchers.test.ts）が import('./tab-watchers.js').AlarmsApi を参照するため再エクスポートする。
export type { AlarmsApi };

const CONSOLE_URL_PATTERN = /^https:\/\/console\.aws\.amazon\.com\//;

/**
 * タブ監視に必要な Chrome API の抽象。
 */
export interface TabsApi {
  onUpdated: {
    addListener(
      callback: (
        tabId: number,
        changeInfo: { url?: string },
        tab: { url?: string },
      ) => void | Promise<void>,
    ): void;
  };
  onRemoved: {
    addListener(callback: (tabId: number) => void | Promise<void>): void;
  };
}

export interface TabWatchersDeps {
  readonly storage: StorageArea;
  readonly tabs: TabsApi;
  readonly alarms: AlarmsApi;
  readonly onConsoleDetected?: (
    tabId: number,
    ctx: FlowContext,
  ) => Promise<void> | void;
  /** dom_timeout / MFA 再試行上限超過などでフローが失敗した際の通知（task 4.4）。呼び出し側が失敗を観測できるようにする。 */
  readonly onFlowFailed?: (
    tabId: number,
    ctx: FlowContext,
    error: FlowError,
  ) => Promise<void> | void;
  /** awaiting_mfa 延長窓満了時の TOTP 再発行に用いる（task 4.4）。 */
  readonly credentialProvider?: CredentialProvider;
  /** awaiting_mfa 再試行時の TOTP 注入に用いる（task 4.4）。 */
  readonly messenger?: LoginMessenger;
}

/**
 * グローバルスコープでタブリスナーを登録する。
 * MV3 Service Worker 再起動時もイベントで起床し、フロー復元に繋がる。
 */
export function startTabWatchers(deps: TabWatchersDeps): void {
  deps.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    return (async () => {
      const url = changeInfo.url ?? tab.url;
      if (!url || !CONSOLE_URL_PATTERN.test(url)) {
        return;
      }
      const ctx = await loadFlowContext(deps.storage, tabId);
      if (!ctx) {
        return;
      }
      await cleanupFlow(deps.storage, deps.alarms, tabId);
      if (deps.onConsoleDetected) {
        await deps.onConsoleDetected(tabId, ctx);
      }
    })();
  });

  deps.tabs.onRemoved.addListener((tabId) => {
    return (async () => {
      const ctx = await loadFlowContext(deps.storage, tabId);
      if (!ctx) {
        return;
      }
      await cleanupFlow(deps.storage, deps.alarms, tabId);
    })();
  });

  // グローバルスコープでアラーム発火ハンドラを登録する。SW が終了していても発火で起床する（Issue 1）。
  deps.alarms.onAlarm.addListener((alarm) => {
    return handleFlowTimeout(deps, alarm.name);
  });
}

/**
 * フロー状態のクリーンアップ単一経路（task 4.3, design.md 単一クリーンアップ経路要件）。
 *
 * `FlowContext` 削除とフロー固有アラーム解除を 1 箇所へ集約する。tab-watchers（onUpdated /
 * onRemoved / アラーム失敗）と message-router（signinDomEvent の失敗遷移）の双方から呼び出され、
 * done / failed / cancel / tab-closed のすべての終端で同一経路を通す（二重実装を作らない）。
 */
export async function cleanupFlow(
  storage: StorageArea,
  alarms: AlarmsApi,
  tabId: number,
): Promise<void> {
  await removeFlowContext(storage, tabId);
  alarms.clear(flowAlarmName(tabId));
}

/**
 * 完了時にセッション記録を作成するヘルパー。
 */
export async function recordSession(
  storage: StorageArea,
  ctx: FlowContext,
): Promise<void> {
  const now = new Date().toISOString();
  const account = await storage.get(`account:${ctx.uuid}`);
  const accountId = account[`account:${ctx.uuid}`] as string | undefined;
  const record: SessionRecord = {
    uuid: ctx.uuid,
    accountId: accountId ?? "unknown",
    tabId: ctx.tabId,
    signedInAt: now,
    lastAccessedAt: now,
    state: "active",
  };
  await storage.set({ [`session:${ctx.uuid}`]: record });
}

/**
 * `flowTimeout:{tabId}` アラーム発火時の回復処理（task 4.4, design.md 2.2）。
 *
 * アラーム名から `tabId` を解析して該当 `FlowContext` を引き（他タブのフローと衝突しない）、
 * `step` に応じて回復する。`FlowContext` が無ければ既にクリーンアップ済み（done/failed/cancel/
 * tab-closed）とみなし何もしない。retry 回数・状態は module-level 変数ではなく必ず `FlowContext`
 * （storage）を経由して読み書きし、SW 再起動をまたいで一貫させる。
 */
async function handleFlowTimeout(
  deps: TabWatchersDeps,
  alarmName: string,
): Promise<void> {
  const tabId = parseFlowAlarmName(alarmName);
  if (tabId === undefined) {
    return;
  }
  const ctx = await loadFlowContext(deps.storage, tabId);
  if (!ctx) {
    // 既にクリーンアップ済み。stale なアラーム発火は無視する。
    return;
  }
  if (ctx.step === "awaiting_mfa") {
    await handleMfaTimeout(deps, ctx);
    return;
  }
  // routing / awaiting_account_id / awaiting_credentials:
  // 監視窓内に次の DOM イベントを観測できなかった = dom_timeout。
  // コードは page_not_rendered に一本化する（selector_not_found はページ描画済みで特定セレクタのみ
  // 欠落した場合を含意するが、アラームハンドラからは DOM 往復なしに両者を区別できないため、描画未達を
  // 表す page_not_rendered を用いる。login-state-machine の domTimeout 処理とも整合）。
  const error = makeFlowError(
    "page_not_rendered",
    "Sign-in step did not progress before the timeout window elapsed.",
  );
  await failFlow(deps, ctx, error);
}

/**
 * awaiting_mfa 延長窓満了時の回復（task 4.4, design.md 2.2 / Issue 2）。
 *
 * `mfaRetryCount` が上限（既定 1）未満、かつ TOTP 再発行に必要なポートが注入されている場合のみ、
 * `getTotp` → `injectTotp` で再送し、`mfaRetryCount` をインクリメントして `FlowContext` に永続化して
 * から新しい 35 秒窓を張り直す（SW 再起動をまたいで上限を判定）。
 *
 * 簡略化（design.md 2.2 の caveat）: 「MFA フォーム存続」の確認は content-script への同期往復を要し、
 * アラームハンドラからはライブネスを同期検証できない。ここでは DOM 往復を行わず、`getTotp`/`injectTotp`
 * の成否で回復可否を判定する（ホスト側 TOTP 待機中のポート切断も同一失敗経路で回復, Issue 2）。
 * 上限超過・ポート未注入時は dom_timeout として失敗させる。
 */
async function handleMfaTimeout(
  deps: TabWatchersDeps,
  ctx: FlowContext,
): Promise<void> {
  if (
    ctx.mfaRetryCount < MFA_RETRY_LIMIT &&
    deps.credentialProvider &&
    deps.messenger
  ) {
    const totp = await deps.credentialProvider.getTotp(ctx.uuid);
    if (!totp.ok) {
      await failFlow(deps, ctx, totp.error);
      return;
    }
    const injected = await deps.messenger.injectTotp(ctx.tabId, totp.value.code);
    if (!injected.ok) {
      await failFlow(deps, ctx, injected.error);
      return;
    }
    const updated: FlowContext = {
      ...ctx,
      mfaRetryCount: ctx.mfaRetryCount + 1,
    };
    await saveFlowContext(deps.storage, updated);
    scheduleFlowTimeout(deps.alarms, updated);
    return;
  }
  const error = makeFlowError(
    "page_not_rendered",
    "MFA was not completed within the retry limit.",
  );
  await failFlow(deps, ctx, error);
}

/**
 * 失敗時の終端処理。task 4.3 のクリーンアップ単一経路（`cleanupFlow`）を必ず通し、
 * `onFlowFailed` で呼び出し側へ失敗を通知する（失敗を握り潰さない）。
 */
async function failFlow(
  deps: TabWatchersDeps,
  ctx: FlowContext,
  error: FlowError,
): Promise<void> {
  await cleanupFlow(deps.storage, deps.alarms, ctx.tabId);
  if (deps.onFlowFailed) {
    await deps.onFlowFailed(ctx.tabId, ctx, error);
  }
}
