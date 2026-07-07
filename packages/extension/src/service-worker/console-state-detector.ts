/**
 * SW 側コンソール状態補正オーケストレーション（task 5.3, design.md ConsoleStateDetector 3.1/8.1）。
 *
 * 静的 content_scripts の対象外である `console.aws.amazon.com` に対し、`SessionRecord`（storage.ts の
 * `loadSessionRecords`）を対象として、対象タブが現在も有効な console.aws.amazon.com タブかを確認し、
 * 有効なら検出ロジックを注入して結果を取得し、`chrome.storage.local` の `SessionRecord.state`
 * （および矛盾時の `accountId`）を補正する（requirements 3.1 陳腐化対策）。
 *
 * 注入方式の選定（func vs files）と理由:
 * `chrome.scripting.executeScript` は `func` を渡すと Chrome がその関数を toString() で
 * シリアライズし対象ページの孤立ワールド（isolated world）で評価する。この機構はモジュールの外部
 * import（selectors.ts の `pickFirstMatch` 等）や外側スコープの変数参照を一切解決できない
 * （シリアライズはソースコード文字列のみを対象とし、クロージャや import 解決は保持されない）。
 * 一方 `files` 方式は `@crxjs/vite-plugin` が対象ファイルを `web_accessible_resources` 経由で
 * dist へバンドルする挙動に依存し、実際のビルド出力を確認しない限り成否が不確実である
 * （manifest.config.ts の旧 TODO が指摘していた通り）。
 * 本モジュールは **func 方式** を採用する: 検出ロジック（`console-detector-content-script.ts` の
 * `isConsoleReady` + `extractVisibleAccountId` 相当）を外部 import に依存しない自己完結関数
 * `injectableDetectConsoleState` として本ファイル内に再実装し、`args` でデータ（SelectorSet・
 * 識別セレクタ一覧）のみを渡す（`args` は構造化クローンされる単純データであり、関数コードとは異なり
 * シリアライズ制約を受けないため、ここでは通常の import で得た値を安全に渡せる）。この方式は
 * ビルド配線（vite.config.ts のエントリ追加・manifest の web_accessible_resources 配線）を一切
 * 必要とせず、`npm run build -w @acs/extension` の成功に追加要件を課さない。
 */
import { type SelectorSet, type SessionRecord } from "@acs/shared";
import { loadSessionRecords, saveSessionRecord, type StorageArea } from "./storage.js";
import {
  type ConsoleDetectionResult,
  CONSOLE_ACCOUNT_IDENTITY_SELECTORS,
} from "../content-scripts/console-detector-content-script.js";

/**
 * ログイン後コンソールの URL 接頭辞。tab-watchers.ts の `CONSOLE_URL_PREFIX` と同一由来の値だが、
 * 両モジュールは意図的に疎結合（DI 抽象を共有しない最小面）を保つため、既存の小さなローカル定数の
 * 重複パターン（flow-alarms.ts の `FLOW_ALARM_PREFIX` 等）に倣いここでも個別に定義する。
 */
const CONSOLE_URL_PREFIX = "https://console.aws.amazon.com/";

/** URL が現行ログイン後コンソール（`console.aws.amazon.com`）のものか判定する純粋関数。 */
export function isConsoleTabUrl(url: string | undefined): boolean {
  return url !== undefined && url.startsWith(CONSOLE_URL_PREFIX);
}

/**
 * `chrome.tabs` から本モジュールが必要とするメソッドのみを切り出した抽象
 * （既存の `TabsApi` / `AlarmsApi` と同じ DI スタイル）。
 *
 * 前提（フォールバック検知の根拠, session-manager.ts の `SessionTabsApi.update` と同様の契約）:
 * `chrome.tabs.get` は**閉鎖済み/存在しない tabId に対して Promise を reject する**
 * （"No tab with id: N."）。本実装は reject を「タブ無効」と見なし控えめに扱う（3.1）。
 */
export interface ConsoleDetectorTabsApi {
  get(tabId: number): Promise<{ readonly id?: number; readonly url?: string }>;
}

/**
 * `chrome.scripting` から本モジュールが必要とするメソッドのみを切り出した抽象。
 * 実 `chrome.scripting.executeScript` はオーバーロードを持つが、本モジュールが用いる
 * `func` + `args` 形のみを最小限切り出す（実行時の注入は composition root で
 * `as unknown as` して橋渡しする、既存の DI 境界規約と同じ）。
 */
export interface ScriptingApi {
  executeScript(details: {
    readonly target: { readonly tabId: number };
    readonly func: (
      selectors: SelectorSet,
      identitySelectors: readonly string[],
    ) => ConsoleDetectionResult;
    readonly args: readonly [SelectorSet, readonly string[]];
  }): Promise<ReadonlyArray<{ readonly result?: ConsoleDetectionResult }>>;
}

/** `correctSessionStates` が依存する外部リソース。 */
export interface ConsoleStateDetectorDeps {
  readonly storage: StorageArea;
  readonly tabs: ConsoleDetectorTabsApi;
  readonly scripting: ScriptingApi;
  /** 適用する SelectorSet（現状は呼び出し側が同梱既定値 `DEFAULT_SELECTOR_SET` を渡す想定）。 */
  readonly selectors: SelectorSet;
}

/**
 * `chrome.scripting.executeScript` の `func` として対象タブへ注入する自己完結関数。
 *
 * **自己完結の絶対条件**: この関数は Chrome によりシリアライズされ対象ページの孤立ワールドで
 * 実行されるため、外部モジュールの import・本ファイルの他の関数/定数・クロージャ変数を一切
 * 参照してはならない。`console-detector-content-script.ts` の `isConsoleReady` /
 * `extractVisibleAccountId`（`selectors.ts` の `pickFirstMatch` に依存）と同等のロジックを、
 * ここでは意図的に重複実装する（func 方式を選んだことの直接の対価。整合性は
 * `console-state-detector.test.ts` のパリティ検証テストで担保する）。
 * 型（`SelectorSet` / `ConsoleDetectionResult`）は型のみの参照であり、コンパイル後に消去されるため
 * ランタイムの自己完結性を損なわない。
 *
 * IMPORTANT（バンドラー変換への耐性）: 上記の自己完結性は `packages/extension/vite.config.ts` の
 * `build.target`（現在 `"esnext"`）に依存する。`packages/extension/tsconfig.json` は
 * `noEmit: true`（tsc は型チェックのみで JS を一切出力しない）なので、実際に本関数を注入する JS を
 * 生成するのは Vite/esbuild のみであり、tsconfig の `target` は本件と無関係である。`"esnext"` の
 * 通り構文の下位変換（downleveling）が一切発生しないうちは、本関数のソースはほぼそのままバンドルされ
 * 自己完結性を損なわない。ただし将来 `vite.config.ts` の `target` を `es2017` 等へ下げた場合、
 * esbuild が `async`・spread 演算子・generator 等をダウンレベルする際にモジュールスコープへ共有ヘルパー
 * （`__async` / `__spreadValues` 等）を注入することがあり、本関数がそれらを参照すると自己完結性が壊れる
 * リスクがある（現在のコードが意図的に for...of / Optional Chaining のみを用い async/spread/generator
 * を避けているのもこのためである）。回帰検出は `console-state-detector.test.ts` の自己完結性ガードテスト
 * （`injectableDetectConsoleState.toString()` に `__` 始まりの共有ヘルパー呼び出しが含まれないことを
 * 検証する）で行う。
 */
export function injectableDetectConsoleState(
  selectors: SelectorSet,
  identitySelectors: readonly string[],
): ConsoleDetectionResult {
  function pickFirst(list: readonly string[]): Element | null {
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (element !== null) {
        return element;
      }
    }
    return null;
  }

  const ready = pickFirst(selectors.consoleReadyMarker) !== null;
  const identityElement = pickFirst(identitySelectors);
  const text = identityElement?.textContent;
  if (text === null || text === undefined) {
    return { ready };
  }
  const matched = /\d{4}-?\d{4}-?\d{4}/.exec(text);
  const full = matched?.[0];
  if (full === undefined) {
    return { ready };
  }
  const digits = full.replace(/\D/g, "");
  return digits.length === 12 ? { ready, accountId: digits } : { ready };
}

/**
 * 検出結果を既存 `SessionRecord` へ適用し、補正後の `SessionRecord` を返す純粋関数。
 * `ready: false`（未ロード等で不確定）の場合は早計な判定を避けるため `null`（補正なし）を返す
 * （`buildConsoleStateMessage` の `null` 相当のロジックを踏襲, requirements 3.1）。
 *
 * - 検出 accountId が記録と一致 → `state: "active"`。
 * - 検出 accountId が記録と明確に異なる → 実態へ `accountId` を補正しつつ、確証度としては
 *   `state: "unknown"`（誤って「ログイン済み」と表示しない, 3.1 の保守的方針）。
 * - `ready: true` だが accountId が取得できない → `state: "unknown"`（`accountId` は変更しない）。
 */
export function applyDetectionResult(
  session: SessionRecord,
  detection: ConsoleDetectionResult,
): SessionRecord | null {
  if (!detection.ready) {
    return null;
  }
  if (detection.accountId === session.accountId) {
    return { ...session, state: "active" };
  }
  return detection.accountId === undefined
    ? { ...session, state: "unknown" }
    : { ...session, accountId: detection.accountId, state: "unknown" };
}

/**
 * 1 件の `SessionRecord` を対象に、タブ有効性確認 → 検出注入 → 補正保存までを行う。
 */
async function correctSingleSession(
  deps: ConsoleStateDetectorDeps,
  session: SessionRecord,
): Promise<void> {
  let tab: { readonly url?: string };
  try {
    tab = await deps.tabs.get(session.tabId);
  } catch {
    // タブ無効（閉鎖済み/存在しない）: 確証が得られないため控えめに unknown とする（3.1）。
    // レコード自体を削除するかは SessionManager/recordSession の責務であり、本関数は state 補正のみ担う。
    await saveSessionRecord(deps.storage, { ...session, state: "unknown" });
    return;
  }
  if (!isConsoleTabUrl(tab.url)) {
    // console.aws.amazon.com 以外（ナビゲーション済み等）では検出できず確証が得られない。
    await saveSessionRecord(deps.storage, { ...session, state: "unknown" });
    return;
  }

  const results = await deps.scripting.executeScript({
    target: { tabId: session.tabId },
    func: injectableDetectConsoleState,
    args: [deps.selectors, CONSOLE_ACCOUNT_IDENTITY_SELECTORS],
  });
  const detection = results[0]?.result;
  if (detection === undefined) {
    // 実行結果が得られない（フレーム未応答等）: 早計な判定をしない。
    return;
  }
  const corrected = applyDetectionResult(session, detection);
  if (corrected !== null) {
    await saveSessionRecord(deps.storage, corrected);
  }
}

/**
 * 全 `SessionRecord` を対象にコンソール状態補正を行う（SW オーケストレーション本体）。
 * `listAccounts` / `syncAccounts`（message-router.ts）の応答構築前に呼び出す想定
 * （design.md 8.1「Vault アンロック解除後の初回アクセス時に同期を再実行する」の精神）。
 */
export async function correctSessionStates(
  deps: ConsoleStateDetectorDeps,
): Promise<void> {
  const sessions = await loadSessionRecords(deps.storage);
  // 各 SessionRecord の補正は相互に依存しない（異なる tabId を読み、異なる storage キー
  // `session:{uuid}` にしか書かない）ため、並列実行で安全に listAccounts/syncAccounts の
  // 応答遷延を押しとどめる（code review：直列 for...of だと tabs.get + executeScript の往復が
  // セッション数分連続して積算する）。
  await Promise.all(
    sessions.map((session) => correctSingleSession(deps, session)),
  );
}

/**
 * Content Script が能動的に送出した `consoleState` メッセージ（`ExtMessage` の一員）を用いて
 * 該当タブの `SessionRecord` を補正する（push 経路。`correctSessionStates` の pull/注入経路とは
 * 対をなす）。`buildConsoleStateMessage`（content-script）は `ready` のときのみメッセージを
 * 送出するため、呼び出し側は常に `ready: true` の `detection` を渡す契約とする。
 * 対応する `SessionRecord` が無い（無関係タブ・クリーンアップ済み等）場合は no-op。
 */
export async function correctSessionFromReport(
  deps: Pick<ConsoleStateDetectorDeps, "storage">,
  tabId: number,
  detection: ConsoleDetectionResult,
): Promise<void> {
  const sessions = await loadSessionRecords(deps.storage);
  const session = sessions.find((s) => s.tabId === tabId);
  if (session === undefined) {
    return;
  }
  const corrected = applyDetectionResult(session, detection);
  if (corrected !== null) {
    await saveSessionRecord(deps.storage, corrected);
  }
}
