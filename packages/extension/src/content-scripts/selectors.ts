/**
 * AWS サインイン各ステップ・認証エラー・コンソール検出の CSS セレクタ集合と、
 * 順序付きフォールバック／動的更新（バージョン比較）機構（task 5.1, design.md SelectorSet 5, 3.2）。
 *
 * 本モジュールは **DOM/ブラウザ非依存の純粋ロジック**として実装する。
 * `document` / `chrome.*` を直接参照せず、DOM 検索は呼び出し側が注入する `query` 関数に委譲する。
 * これにより jsdom を要さずユニットテスト可能とし、SigninContentScript（task 5.2/5.3）と
 * Popup 設定（task 7）の双方から再利用できる。
 *
 * セレクタは順序付きフォールバックで適用し（`pickFirstMatch`）、同梱既定値
 * （`DEFAULT_SELECTOR_SET`）と設定上書きを semver 比較して新しい方を採用する
 * （`resolveSelectorSet` / m-3）。具体値は PoC #4/#5 で確定する暫定既定値。
 */
import { type SelectorSet } from "@acs/shared";

/**
 * 同梱既定のセレクタ集合（暫定・best-effort）。
 * 各配列は「最も具体的／最も一致しやすい順」に並べ、順序付きフォールバックで適用する。
 * 実 DOM に基づく確定値は PoC #4/#5 で更新し version を繰り上げる。
 */
export const DEFAULT_SELECTOR_SET: SelectorSet = {
  version: "1.0.0",
  accountIdInput: ["#account", 'input[name="account"]', 'input[name="resolving_input"]'],
  usernameInput: ["#username", 'input[name="username"]', 'input[autocomplete="username"]'],
  passwordInput: ["#password", 'input[name="password"]', 'input[type="password"]'],
  mfaInput: ["#mfaCode", 'input[name="mfacode"]', 'input[name="mfaCode"]'],
  submitButton: ["#signin_button", 'button[type="submit"]', 'input[type="submit"]'],
  authErrorMarker: ["#error_message", ".error-message", '[role="alert"]'],
  consoleReadyMarker: [
    "#awsc-nav-header",
    '[data-testid="awsc-nav-header"]',
    "#awsc-navigation-container",
  ],
};

/** 数値化済み semver 3 要素。malformed の場合は `null`。 */
interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * `major.minor.patch`（各要素が非負整数）だけを妥当と見なして数値化する。
 * 形が異なる／数値でない要素を含む場合は `null`（＝malformed）を返し、例外は投げない。
 */
function parseSemver(version: string): ParsedSemver | null {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [rawMajor, rawMinor, rawPatch] = parts;
  if (
    rawMajor === undefined ||
    rawMinor === undefined ||
    rawPatch === undefined ||
    !/^\d+$/.test(rawMajor) ||
    !/^\d+$/.test(rawMinor) ||
    !/^\d+$/.test(rawPatch)
  ) {
    return null;
  }
  return {
    major: Number.parseInt(rawMajor, 10),
    minor: Number.parseInt(rawMinor, 10),
    patch: Number.parseInt(rawPatch, 10),
  };
}

/**
 * semver 文字列を `Array.prototype.sort` 互換で比較する（負/零/正）。
 * malformed な版は「最も低い版」として扱い、どの妥当な版より小さくソートする
 * （両方 malformed なら等価＝0）。例外は投げない（防御的）。
 */
export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (parsedA === null && parsedB === null) {
    return 0;
  }
  if (parsedA === null) {
    return -1;
  }
  if (parsedB === null) {
    return 1;
  }
  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor;
  }
  return parsedA.patch - parsedB.patch;
}

/**
 * 同梱既定値と設定上書きを semver 比較し、より新しい版の SelectorSet を採用する（m-3）。
 * - `override` 未指定（`undefined`/`null`）→ `bundled`。
 * - 版が高い方を採用。同版なら明示的なユーザ設定を優先し `override` を採用（タイブレーク）。
 * - `override` の版が malformed なら最も低い版として扱われ、結果的に `bundled` を採用（防御的）。
 */
export function resolveSelectorSet(
  bundled: SelectorSet,
  override?: SelectorSet | null,
): SelectorSet {
  if (override === undefined || override === null) {
    return bundled;
  }
  // bundled が厳密に高い場合のみ bundled を採用。等価・override 高は override（タイブレーク）。
  return compareSemver(bundled.version, override.version) > 0 ? bundled : override;
}

/**
 * 順序付きフォールバックの基本操作（「順序付きフォールバック」プリミティブ）。
 * `selectors` を先頭から走査し、`query(selector)` が非 null を返した最初の要素を返す。
 * いずれも一致しなければ `null`。最初に一致した時点で以降の `query` は呼ばない。
 *
 * DOM 非依存とするため検索関数を注入で受け取る。content script では
 * `(selector) => document.querySelector(selector)` を渡して用いる（task 5.2/5.3）。
 */
export function pickFirstMatch(
  selectors: readonly string[],
  query: (selector: string) => Element | null,
): Element | null {
  for (const selector of selectors) {
    const element = query(selector);
    if (element !== null) {
      return element;
    }
  }
  return null;
}
