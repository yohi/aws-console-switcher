/**
 * フロー・タイムアウト用アラームの共通ヘルパー（task 4.4）。
 *
 * design.md「フロー状態の復元（SW 再起動耐性, 2.2）」に基づく:
 * - フロー開始・各ステップ遷移時にフロー固有名 `flowTimeout:{tabId}` で `chrome.alarms.create` を登録する。
 *   同一 `tabId` の旧アラームは同名 create で上書きされ単一化される（並行フロー間で衝突しない）。
 * - 監視窓は状態依存とし、通常ステップ（routing / awaiting_account_id / awaiting_credentials）は
 *   既定 10 秒、awaiting_mfa はホスト TOTP 待機窓（最大 30 秒）に注入・送信マージンを加えた
 *   延長窓（既定 35 秒）とする。
 * - `setTimeout` は MV3 SW 終了後に発火しないため、計測は必ず `chrome.alarms` で行う（Issue 1）。
 *
 * 本モジュールは message-router（アラーム登録側）と tab-watchers（アラーム発火ハンドラ側）の
 * 双方から参照される最小の共有面であり、副作用を持たない純粋ヘルパーのみを公開する。
 */
import { type FlowContext, type FlowStep } from "@acs/shared";

/** 通常ステップの dom_timeout 監視窓（ミリ秒, design.md 既定 10 秒）。 */
export const DOM_TIMEOUT_MS = 10_000;

/**
 * awaiting_mfa の延長監視窓（ミリ秒, design.md 既定 35 秒）。
 * ホスト側 TOTP 待機（最大 30 秒）＋注入・送信マージン。
 */
export const MFA_TIMEOUT_MS = 35_000;

/**
 * awaiting_mfa の getTotp 再発行上限（design.md 既定 1）。
 * `mfaRetryCount` が本値未満のときのみ再試行し、到達後は dom_timeout として失敗させる（Issue 2）。
 */
export const MFA_RETRY_LIMIT = 1;

/** フロー固有アラーム名の接頭辞。 */
const FLOW_ALARM_PREFIX = "flowTimeout:";

/**
 * `chrome.alarms` からフロー計測に必要なメソッドのみを切り出した抽象。
 * グローバルスコープに置く発火ハンドラ登録（`onAlarm`）と、状態遷移ごとの登録/解除を担う。
 */
export interface AlarmsApi {
  onAlarm: {
    addListener(
      callback: (alarm: { name: string }) => void | Promise<void>,
    ): void;
  };
  create(name: string, alarmInfo: { when?: number }): void;
  clear(name: string): void;
}

/** フロー固有アラーム名 `flowTimeout:{tabId}` を組み立てる。 */
export function flowAlarmName(tabId: number): string {
  return `${FLOW_ALARM_PREFIX}${tabId}`;
}

/**
 * アラーム名から `tabId` を解析する。フロー計測アラームでない、または
 * 整数の `tabId` を含まない名前は `undefined` を返す（他タブ・他用途のアラームと衝突しない）。
 */
export function parseFlowAlarmName(name: string): number | undefined {
  if (!name.startsWith(FLOW_ALARM_PREFIX)) {
    return undefined;
  }
  const raw = name.slice(FLOW_ALARM_PREFIX.length);
  if (raw === "") {
    return undefined;
  }
  const tabId = Number(raw);
  if (!Number.isInteger(tabId)) {
    return undefined;
  }
  return tabId;
}

/** ステップ依存の監視窓（ミリ秒）を返す。awaiting_mfa のみ延長窓。 */
export function timeoutWindowForStep(step: FlowStep): number {
  return step === "awaiting_mfa" ? MFA_TIMEOUT_MS : DOM_TIMEOUT_MS;
}

/**
 * FlowContext の現在ステップに応じた監視窓で `flowTimeout:{tabId}` を (再)登録する。
 * 同名 create で旧アラームは上書きされ単一化される（design.md 2.2）。
 */
export function scheduleFlowTimeout(alarms: AlarmsApi, ctx: FlowContext): void {
  alarms.create(flowAlarmName(ctx.tabId), {
    when: Date.now() + timeoutWindowForStep(ctx.step),
  });
}
