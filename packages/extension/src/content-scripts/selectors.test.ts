/**
 * セレクタ集合・順序付きフォールバック・動的更新機構のユニットテスト（task 5.1）。
 */
import { describe, expect, it, vi } from "vitest";
import { type SelectorSet } from "@acs/shared";
import {
  DEFAULT_SELECTOR_SET,
  compareSemver,
  pickFirstMatch,
  resolveSelectorSet,
} from "./selectors.js";

/** 妥当な semver か（DEFAULT_SELECTOR_SET の健全性検査用）。 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/** テスト用に version だけ差し替えた SelectorSet を作る。 */
function withVersion(version: string): SelectorSet {
  return { ...DEFAULT_SELECTOR_SET, version };
}

describe("compareSemver", () => {
  it("returns negative when a < b (patch)", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
  });

  it("returns positive when a > b (minor dominates patch)", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("returns zero when equal", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("sorts malformed lower than any well-formed version", () => {
    expect(compareSemver("abc", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "abc")).toBeGreaterThan(0);
  });

  it("treats two malformed versions as equal (both lowest)", () => {
    expect(compareSemver("abc", "x.y.z")).toBe(0);
  });

  it("does not throw on malformed input", () => {
    expect(() => compareSemver("", "1")).not.toThrow();
  });

  it("orders by minor version when major is equal (minor dominates patch)", () => {
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("1.1.9", "1.2.0")).toBeLessThan(0);
  });
});

describe("resolveSelectorSet", () => {
  it("returns bundled when no override provided", () => {
    const bundled = withVersion("1.2.3");
    expect(resolveSelectorSet(bundled)).toBe(bundled);
    expect(resolveSelectorSet(bundled, null)).toBe(bundled);
  });

  it("prefers override when its version is higher", () => {
    const bundled = withVersion("1.0.0");
    const override = withVersion("1.0.1");
    expect(resolveSelectorSet(bundled, override)).toBe(override);
  });

  it("prefers bundled when override version is lower", () => {
    const bundled = withVersion("2.0.0");
    const override = withVersion("1.9.9");
    expect(resolveSelectorSet(bundled, override)).toBe(bundled);
  });

  it("prefers override on version tie (explicit user config wins)", () => {
    const bundled = withVersion("1.0.0");
    const override = withVersion("1.0.0");
    expect(resolveSelectorSet(bundled, override)).toBe(override);
  });

  it("falls back to bundled defensively when override version is malformed", () => {
    const bundled = withVersion("1.0.0");
    const override = withVersion("not-semver");
    expect(resolveSelectorSet(bundled, override)).toBe(bundled);
  });
});

describe("pickFirstMatch", () => {
  it("returns the first selector whose query matches (skips non-matching)", () => {
    const el = {} as unknown as Element;
    const query = vi.fn((selector: string): Element | null =>
      selector === "#second" ? el : null,
    );
    const result = pickFirstMatch(["#first", "#second", "#third"], query);
    expect(result).toBe(el);
  });

  it("returns null when no selector matches", () => {
    const query = vi.fn((): Element | null => null);
    expect(pickFirstMatch(["#a", "#b"], query)).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns null on an empty selector list without querying", () => {
    const query = vi.fn((): Element | null => null);
    expect(pickFirstMatch([], query)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("stops at the first match without querying later selectors", () => {
    const el = {} as unknown as Element;
    const query = vi.fn((selector: string): Element | null =>
      selector === "#first" ? el : null,
    );
    const result = pickFirstMatch(["#first", "#second"], query);
    expect(result).toBe(el);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("#first");
  });
});

describe("DEFAULT_SELECTOR_SET", () => {
  it("has a valid semver version", () => {
    expect(SEMVER_PATTERN.test(DEFAULT_SELECTOR_SET.version)).toBe(true);
    // 自前の comparator でも妥当（malformed 扱いされない）ことを確認。
    expect(compareSemver(DEFAULT_SELECTOR_SET.version, "0.0.0")).toBeGreaterThan(
      0,
    );
  });

  it("provides non-empty ordered fallback lists for every field", () => {
    const fields: readonly (readonly string[])[] = [
      DEFAULT_SELECTOR_SET.accountIdInput,
      DEFAULT_SELECTOR_SET.usernameInput,
      DEFAULT_SELECTOR_SET.passwordInput,
      DEFAULT_SELECTOR_SET.mfaInput,
      DEFAULT_SELECTOR_SET.submitButton,
      DEFAULT_SELECTOR_SET.authErrorMarker,
      DEFAULT_SELECTOR_SET.consoleReadyMarker,
    ];
    for (const list of fields) {
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const selector of list) {
        expect(typeof selector).toBe("string");
        expect(selector.length).toBeGreaterThan(0);
      }
    }
  });
});
