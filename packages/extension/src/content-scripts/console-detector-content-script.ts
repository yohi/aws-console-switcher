/**
 * Console 状態検出スクリプト（task 5.3, design.md ConsoleStateDetector /
 * requirements 3.1「陳腐化対策」）。
 *
 * 静的 content_scripts の対象外である `console.aws.amazon.com` に対し、Service Worker が
 * `chrome.tabs.query` で対象タブを判定後 `chrome.scripting.executeScript` で動的注入する想定の
 * スクリプト（S-2）。本モジュールは **DOM/ブラウザ非依存の純粋ロジック**として実装し、DOM 検索は
 * 呼び出し側が渡す `ParentNode` に委譲する（selectors.ts と同方針。jsdom を要さずユニットテスト可能）。
 *
 * 検出結果から現ログイン識別情報（12 桁 AWS アカウント ID）を読み取り、`chrome.storage.local` の
 * 記録を SW 側で補正する。確証が得られない状態（識別情報が読めない・ページ未ロード）は「不確定」
 * として控えめに扱い、誤った「ログイン済み」表示や早計なメッセージ送出を避ける（3.1）。
 */
import { type ExtMessage, type SelectorSet } from "@acs/shared";
import { DEFAULT_SELECTOR_SET, pickFirstMatch } from "./selectors.js";

/**
 * 現ログイン中アカウントの表示位置（AWS コンソール ナビバー等）を指す best-effort セレクタ集合。
 * 順序付きフォールバックで適用する。`SelectorSet` には専用フィールドが無いため本モジュール固有に定義する。
 * 具体値は DEFAULT_SELECTOR_SET と同様 PoC #4/#5 で実 DOM に基づき確定する暫定値。
 */
export const CONSOLE_ACCOUNT_IDENTITY_SELECTORS: readonly string[] = [
  '[data-testid="awsc-account-detail-menu"]',
  "#awsc-login-display-name-account",
  "#nav-usernameMenu",
];

/**
 * ナビバー等のテキストから 12 桁 AWS アカウント ID を抜き出すパターン（ハイフン区切り許容）。
 * 例: `1234-5678-9012` / `123456789012`。抽出後は非数字を除去して 12 桁に正規化する。
 */
const ACCOUNT_ID_IN_TEXT_PATTERN = /\d{4}-?\d{4}-?\d{4}/;

/** アカウント ID の桁数（12 桁固定）。 */
const AWS_ACCOUNT_ID_LENGTH = 12;

/** コンソール状態検出の結果（`ready` はページ準備完了、`accountId` は読み取れた場合のみ）。 */
export interface ConsoleDetectionResult {
  readonly ready: boolean;
  readonly accountId?: string;
}

/**
 * 現ログイン識別情報を表示する要素を順序付きフォールバックで探し、テキストから 12 桁アカウント ID を
 * 抽出して正規化する。要素が無い／テキストが空／ID パターン不一致のいずれも `undefined` を返す
 * （確証が得られない状態は「不確定」として控えめに扱う, 3.1）。
 */
export function extractVisibleAccountId(
  doc: ParentNode,
  selectors: readonly string[],
): string | undefined {
  const element = pickFirstMatch(selectors, (selector) =>
    doc.querySelector(selector),
  );
  const text = element?.textContent;
  if (text === null || text === undefined) {
    return undefined;
  }
  const matched = ACCOUNT_ID_IN_TEXT_PATTERN.exec(text);
  const full = matched?.[0];
  if (full === undefined) {
    return undefined;
  }
  const digits = full.replace(/\D/g, "");
  return digits.length === AWS_ACCOUNT_ID_LENGTH ? digits : undefined;
}

/**
 * コンソールページがロード済み（ナビ等の検出マーカーが存在）か判定する。
 * `SelectorSet.consoleReadyMarker` を順序付きフォールバックで適用する。
 */
export function isConsoleReady(doc: ParentNode, selectors: SelectorSet): boolean {
  return (
    pickFirstMatch(selectors.consoleReadyMarker, (selector) =>
      doc.querySelector(selector),
    ) !== null
  );
}

/**
 * コンソール状態検出のコアロジック（`isConsoleReady` と `extractVisibleAccountId` の合成）。
 * 純粋関数として `doc` / `selectors` を受け取り、実ブラウザでは `chrome.scripting.executeScript` が
 * この検出を評価して結果を SW へ返す（executeScript のシリアライズ機構は SW 側の統合上の関心事）。
 */
export function detectConsoleState(
  doc: ParentNode,
  selectors: SelectorSet,
): ConsoleDetectionResult {
  const ready = isConsoleReady(doc, selectors);
  const accountId = extractVisibleAccountId(
    doc,
    CONSOLE_ACCOUNT_IDENTITY_SELECTORS,
  );
  // exactOptionalPropertyTypes: 未取得時は accountId キーを付与しない（undefined を明示代入しない）。
  return accountId === undefined ? { ready } : { ready, accountId };
}

/**
 * 検出結果を SW への `consoleState` メッセージへ整形する。`ready` でない（＝ページ未ロード等で不確定）
 * 場合は早計・誤解を招く報告を避けるため `null` を返す。`accountId` は抽出できた場合のみ付与する
 * （SW の `handleConsoleState` は `accountId?` を許容）。
 */
export function buildConsoleStateMessage(
  tabId: number,
  state: ConsoleDetectionResult,
): Extract<ExtMessage, { kind: "consoleState" }> | null {
  if (!state.ready) {
    return null;
  }
  return state.accountId === undefined
    ? { kind: "consoleState", tabId }
    : { kind: "consoleState", tabId, accountId: state.accountId };
}

// ---------------------------------------------------------------------------
// 動的注入用ブートストラップ（最小・実配線は後続タスク）。
//
// 本ファイルは静的 content_scripts ではなく、SW が `chrome.tabs.query` で
// `https://console.aws.amazon.com/*` タブを特定し `chrome.scripting.executeScript` で
// 動的注入する成果物として用いる（design.md S-2, requirements 3.1 陳腐化対策）。tabId は注入元の
// SW が保持するため、`buildConsoleStateMessage` による tabId 付与と `chrome.storage.local` 補正は
// SW 側オーケストレーション（後続タスク）の責務であり本タスクの対象外。実運用では設定から解決した
// SelectorSet を executeScript の引数で渡す。ここでは注入時に検出ロジックを評価可能なことのみ保証する。
if (typeof document !== "undefined") {
  void detectConsoleState(document, DEFAULT_SELECTOR_SET);
}
