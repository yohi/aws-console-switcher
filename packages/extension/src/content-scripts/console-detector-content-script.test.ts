/**
 * コンソール状態検出（現ログイン識別情報の抽出・準備判定・メッセージ整形）の
 * ユニットテスト（task 5.3, design.md ConsoleStateDetector / requirements 3.1 陳腐化対策）。
 *
 * selectors.ts と同様、DOM/ブラウザ非依存で検証する（jsdom を要さない）。
 * `document` の代わりに `querySelector` のみを備えた擬似 `ParentNode` を注入し、
 * 純粋関数の入出力だけを対象とする（動的注入の配線は SW 側の後続タスク）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTOR_SET } from "./selectors.js";
import {
  CONSOLE_ACCOUNT_IDENTITY_SELECTORS,
  buildConsoleStateMessage,
  detectConsoleState,
  extractVisibleAccountId,
  isConsoleReady,
} from "./console-detector-content-script.js";

/** textContent だけを備えた擬似 Element（selectors.test.ts と同じキャスト方針）。 */
function fakeElement(textContent: string | null): Element {
  return { textContent } as unknown as Element;
}

/**
 * `selector -> textContent` の対応表から `querySelector` のみを備えた擬似 ParentNode を作る。
 * 表に無いセレクタは null（＝不一致）を返し、順序付きフォールバックを検証可能にする。
 */
function fakeDoc(entries: Readonly<Record<string, string | null>>): ParentNode {
  return {
    querySelector(selector: string): Element | null {
      return Object.prototype.hasOwnProperty.call(entries, selector)
        ? fakeElement(entries[selector] ?? null)
        : null;
    },
  } as unknown as ParentNode;
}

/** 全ての識別情報セレクタに同一テキストを割り当てた対応表（識別情報の有無検証用・順序非依存）。 */
function identityEntries(text: string | null): Record<string, string | null> {
  const entries: Record<string, string | null> = {};
  for (const selector of CONSOLE_ACCOUNT_IDENTITY_SELECTORS) {
    entries[selector] = text;
  }
  return entries;
}

describe("CONSOLE_ACCOUNT_IDENTITY_SELECTORS", () => {
  it("provides a non-empty ordered best-effort selector list", () => {
    expect(Array.isArray(CONSOLE_ACCOUNT_IDENTITY_SELECTORS)).toBe(true);
    expect(CONSOLE_ACCOUNT_IDENTITY_SELECTORS.length).toBeGreaterThan(0);
    for (const selector of CONSOLE_ACCOUNT_IDENTITY_SELECTORS) {
      expect(typeof selector).toBe("string");
      expect(selector.length).toBeGreaterThan(0);
    }
  });
});

describe("extractVisibleAccountId", () => {
  it("normalizes a hyphenated 12-digit account id from nav text", () => {
    const doc = fakeDoc(identityEntries("アカウント: 1234-5678-9012 (my-alias)"));
    expect(extractVisibleAccountId(doc, CONSOLE_ACCOUNT_IDENTITY_SELECTORS)).toBe(
      "123456789012",
    );
  });

  it("extracts a plain (non-hyphenated) 12-digit account id", () => {
    const doc = fakeDoc(identityEntries("123456789012"));
    expect(extractVisibleAccountId(doc, CONSOLE_ACCOUNT_IDENTITY_SELECTORS)).toBe(
      "123456789012",
    );
  });

  it("returns undefined when the identity text has no account-id pattern", () => {
    const doc = fakeDoc(identityEntries("my-account-alias"));
    expect(
      extractVisibleAccountId(doc, CONSOLE_ACCOUNT_IDENTITY_SELECTORS),
    ).toBeUndefined();
  });

  it("returns undefined when no identity element is present", () => {
    const doc = fakeDoc({});
    expect(
      extractVisibleAccountId(doc, CONSOLE_ACCOUNT_IDENTITY_SELECTORS),
    ).toBeUndefined();
  });

  it("returns undefined when textContent is null (malformed element)", () => {
    const doc = fakeDoc(identityEntries(null));
    expect(
      extractVisibleAccountId(doc, CONSOLE_ACCOUNT_IDENTITY_SELECTORS),
    ).toBeUndefined();
  });
});

describe("isConsoleReady", () => {
  it("returns true when the primary console marker is present", () => {
    const doc = fakeDoc({ "#awsc-nav-header": "AWS Management Console" });
    expect(isConsoleReady(doc, DEFAULT_SELECTOR_SET)).toBe(true);
  });

  it("returns true using a later fallback marker (order respected)", () => {
    // 先頭 2 つは不在、3 番目のフォールバックのみ一致。
    const doc = fakeDoc({ "#awsc-navigation-container": "" });
    expect(isConsoleReady(doc, DEFAULT_SELECTOR_SET)).toBe(true);
  });

  it("returns false when no console marker is present", () => {
    const doc = fakeDoc({});
    expect(isConsoleReady(doc, DEFAULT_SELECTOR_SET)).toBe(false);
  });
});

describe("detectConsoleState", () => {
  it("reports ready with accountId when both console marker and identity resolve", () => {
    const doc = fakeDoc({
      "#awsc-nav-header": "AWS Management Console",
      ...identityEntries("Account ID: 1234-5678-9012"),
    });
    expect(detectConsoleState(doc, DEFAULT_SELECTOR_SET)).toEqual({
      ready: true,
      accountId: "123456789012",
    });
  });

  it("reports ready without accountId when identity is missing", () => {
    const doc = fakeDoc({ "#awsc-nav-header": "AWS Management Console" });
    const result = detectConsoleState(doc, DEFAULT_SELECTOR_SET);
    expect(result.ready).toBe(true);
    expect(result.accountId).toBeUndefined();
  });

  it("reports not ready when the console marker is absent", () => {
    const doc = fakeDoc(identityEntries("Account ID: 1234-5678-9012"));
    expect(detectConsoleState(doc, DEFAULT_SELECTOR_SET).ready).toBe(false);
  });
});

describe("buildConsoleStateMessage", () => {
  it("builds a consoleState message when ready with an accountId", () => {
    expect(
      buildConsoleStateMessage(42, { ready: true, accountId: "123456789012" }),
    ).toEqual({ kind: "consoleState", tabId: 42, accountId: "123456789012" });
  });

  it("builds a consoleState message (accountId undefined) when ready but identity unknown", () => {
    const message = buildConsoleStateMessage(42, { ready: true });
    expect(message).toEqual({ kind: "consoleState", tabId: 42 });
    expect(message?.accountId).toBeUndefined();
  });

  it("returns null when not ready (inconclusive; avoid premature reporting)", () => {
    expect(buildConsoleStateMessage(42, { ready: false })).toBeNull();
  });
});
