/**
 * SW 側コンソール状態補正オーケストレーションのユニットテスト（task 5.3, design.md
 * ConsoleStateDetector / requirements 3.1 陳腐化対策）。
 *
 * `chrome.tabs.get` / `chrome.scripting.executeScript` を抽象化した DI フェイクで、
 * タブ有効/無効・検出 ready/not-ready・accountId 一致/不一致/取得不能の各分岐を検証する。
 */
import { describe, expect, it, vi } from "vitest";
import { type SessionRecord } from "@acs/shared";
import { DEFAULT_SELECTOR_SET } from "../content-scripts/selectors.js";
import { type ConsoleDetectionResult } from "../content-scripts/console-detector-content-script.js";
import {
  type ConsoleDetectorTabsApi,
  type ConsoleStateDetectorDeps,
  type ScriptingApi,
  applyDetectionResult,
  correctSessionFromReport,
  correctSessionStates,
  injectableDetectConsoleState,
  isConsoleTabUrl,
} from "./console-state-detector.js";
import { loadSessionRecords, saveSessionRecord, type StorageArea } from "./storage.js";

function createFakeStorage(): StorageArea {
  const data = new Map<string, unknown>();
  return {
    get: async (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null) {
        return Object.fromEntries(data);
      }
      const keyList = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : Object.keys(keys);
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (data.has(key)) {
          result[key] = data.get(key);
        }
      }
      return result;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
    remove: async (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const key of keyList) {
        data.delete(key);
      }
    },
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    accountId: "123456789012",
    tabId: 42,
    signedInAt: "2024-01-01T00:00:00.000Z",
    lastAccessedAt: "2024-01-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
}

function createFakeTabs(
  impl?: ConsoleDetectorTabsApi["get"],
): ConsoleDetectorTabsApi {
  return {
    get: vi.fn(
      impl ??
        (async () => ({ url: "https://console.aws.amazon.com/console/home" })),
    ),
  };
}

function createFakeScripting(
  impl?: ScriptingApi["executeScript"],
): ScriptingApi {
  return {
    executeScript: vi.fn(
      impl ?? (async () => [{ result: { ready: true } }]),
    ) as ScriptingApi["executeScript"],
  };
}

function createDeps(
  overrides: Partial<ConsoleStateDetectorDeps> = {},
): ConsoleStateDetectorDeps {
  return {
    storage: overrides.storage ?? createFakeStorage(),
    tabs: overrides.tabs ?? createFakeTabs(),
    scripting: overrides.scripting ?? createFakeScripting(),
    selectors: overrides.selectors ?? DEFAULT_SELECTOR_SET,
  };
}

describe("isConsoleTabUrl", () => {
  it("returns true for a console.aws.amazon.com URL", () => {
    expect(
      isConsoleTabUrl("https://console.aws.amazon.com/console/home"),
    ).toBe(true);
  });

  it("returns false for a non-console URL", () => {
    expect(isConsoleTabUrl("https://example.com/")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isConsoleTabUrl(undefined)).toBe(false);
  });
});

describe("applyDetectionResult", () => {
  it("returns null (no correction) when not ready (avoid premature judgement, 3.1)", () => {
    const session = makeSession({ state: "unknown" });
    expect(applyDetectionResult(session, { ready: false })).toBeNull();
  });

  it("marks active when the detected accountId matches the record", () => {
    const session = makeSession({ state: "unknown" });
    const corrected = applyDetectionResult(session, {
      ready: true,
      accountId: "123456789012",
    });
    expect(corrected).toMatchObject({
      state: "active",
      accountId: "123456789012",
    });
  });

  it("conservatively marks unknown and corrects accountId when a different accountId is detected", () => {
    const session = makeSession({ state: "active", accountId: "123456789012" });
    const corrected = applyDetectionResult(session, {
      ready: true,
      accountId: "999999999999",
    });
    expect(corrected).toMatchObject({
      state: "unknown",
      accountId: "999999999999",
    });
  });

  it("conservatively marks unknown without changing accountId when ready but no accountId was extracted", () => {
    const session = makeSession({ state: "active", accountId: "123456789012" });
    const corrected = applyDetectionResult(session, { ready: true });
    expect(corrected).toMatchObject({
      state: "unknown",
      accountId: "123456789012",
    });
  });
});

describe("correctSessionStates", () => {
  it("marks the session unknown when the tab is invalid/closed (chrome.tabs.get rejects)", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "active" }));
    const tabs = createFakeTabs(async () => {
      throw new Error("No tab with id: 42.");
    });
    const deps = createDeps({ storage, tabs });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("unknown");
  });

  it("marks the session unknown when the tab exists but is not a console.aws.amazon.com tab", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "active" }));
    const tabs = createFakeTabs(async () => ({ url: "https://example.com/" }));
    const scripting = createFakeScripting();
    const deps = createDeps({ storage, tabs, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("unknown");
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it("does not correct the session when the console page is not ready (ready: false)", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "active" }));
    const scripting = createFakeScripting(async () => [
      { result: { ready: false } },
    ]);
    const deps = createDeps({ storage, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    // 未ロード等で不確定な場合は早計な判定をせず、既存状態を維持する（3.1）。
    expect(sessions[0]?.state).toBe("active");
  });

  it("marks the session active when the detected accountId matches the record", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "unknown" }));
    const scripting = createFakeScripting(async () => [
      { result: { ready: true, accountId: "123456789012" } },
    ]);
    const deps = createDeps({ storage, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("active");
  });

  it("marks the session unknown and corrects accountId when a different accountId is detected", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(
      storage,
      makeSession({ state: "active", accountId: "123456789012" }),
    );
    const scripting = createFakeScripting(async () => [
      { result: { ready: true, accountId: "999999999999" } },
    ]);
    const deps = createDeps({ storage, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]).toMatchObject({
      state: "unknown",
      accountId: "999999999999",
    });
  });

  it("marks the session unknown when ready but no accountId could be extracted", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "active" }));
    const scripting = createFakeScripting(async () => [{ result: { ready: true } }]);
    const deps = createDeps({ storage, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("unknown");
  });

  it("skips correction without throwing when executeScript returns no result", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "active" }));
    const scripting = createFakeScripting(async () => []);
    const deps = createDeps({ storage, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("active");
  });

  it("processes multiple sessions independently", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(
      storage,
      makeSession({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tabId: 1, state: "unknown" }),
    );
    await saveSessionRecord(
      storage,
      makeSession({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", tabId: 2, state: "unknown" }),
    );
    const tabs = createFakeTabs(async (tabId: number) =>
      tabId === 1
        ? { url: "https://console.aws.amazon.com/console/home" }
        : Promise.reject(new Error("No tab with id: 2.")),
    );
    const scripting = createFakeScripting(async () => [
      { result: { ready: true, accountId: "123456789012" } },
    ]);
    const deps = createDeps({ storage, tabs, scripting });

    await correctSessionStates(deps);

    const sessions = await loadSessionRecords(storage);
    const byUuid = new Map(sessions.map((s) => [s.uuid, s]));
    expect(byUuid.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")?.state).toBe("active");
    expect(byUuid.get("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")?.state).toBe("unknown");
  });

  it("corrects sessions concurrently rather than sequentially (avoid cumulative round-trip latency)", async () => {
    // 5件の SessionRecord（MAX_CONCURRENT_SESSIONS）を直列処理すると listAccounts/syncAccounts の
    // 応答遷延が積算する。各 SessionRecord は相互依存がないため並列化できるはず（code review）。
    // ガード: 実行中の executeScript 呼び出し数の最大並行数を計測し、直列（1件ずつ）ではありえない
    // 2以上の同時実行を検出できないと失敗する（Promise.all 化の回帰ガード）。
    const storage = createFakeStorage();
    await saveSessionRecord(
      storage,
      makeSession({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tabId: 1 }),
    );
    await saveSessionRecord(
      storage,
      makeSession({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", tabId: 2 }),
    );
    let inFlightCalls = 0;
    let maxObservedConcurrency = 0;
    const scripting = createFakeScripting(async () => {
      inFlightCalls += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCalls);
      // マイクロタスク境界を挟み、直列実行なら2件目の呼び出しが開始される前に
      // 1件目がここへ到達済み（かつ未 resolve）にならないことを利用して検出する。
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlightCalls -= 1;
      return [{ result: { ready: true, accountId: "123456789012" } }];
    });
    const deps = createDeps({ storage, scripting });

    await correctSessionStates(deps);

    expect(maxObservedConcurrency).toBeGreaterThan(1);
  });
});

describe("correctSessionFromReport (content-script push path, consoleState message)", () => {
  it("corrects the matching session when the reported tabId and accountId match", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "unknown", tabId: 42 }));

    await correctSessionFromReport({ storage }, 42, {
      ready: true,
      accountId: "123456789012",
    });

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("active");
  });

  it("no-ops when no SessionRecord matches the reported tabId", async () => {
    const storage = createFakeStorage();
    await saveSessionRecord(storage, makeSession({ state: "active", tabId: 42 }));

    await correctSessionFromReport({ storage }, 999, { ready: true });

    const sessions = await loadSessionRecords(storage);
    expect(sessions[0]?.state).toBe("active");
  });
});

describe("injectableDetectConsoleState (func 方式で注入する自己完結関数)", () => {
  /** textContent だけを備えた擬似 Element（console-detector-content-script.test.ts と同じ方針）。 */
  function fakeElement(textContent: string | null): Element {
    return { textContent } as unknown as Element;
  }

  function fakeDocument(
    entries: Readonly<Record<string, string | null>>,
  ): Document {
    return {
      querySelector(selector: string): Element | null {
        return Object.prototype.hasOwnProperty.call(entries, selector)
          ? fakeElement(entries[selector] ?? null)
          : null;
      },
    } as unknown as Document;
  }

  const identitySelectors = ["#nav-usernameMenu"];

  it("is self-contained: it does not throw ReferenceError for undeclared outer bindings when document is stubbed", () => {
    vi.stubGlobal(
      "document",
      fakeDocument({ "#awsc-nav-header": "AWS Management Console" }),
    );
    expect(() =>
      injectableDetectConsoleState(DEFAULT_SELECTOR_SET, identitySelectors),
    ).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("reports ready with a normalized accountId, matching detectConsoleState's behavior", () => {
    vi.stubGlobal(
      "document",
      fakeDocument({
        "#awsc-nav-header": "AWS Management Console",
        "#nav-usernameMenu": "Account: 1234-5678-9012",
      }),
    );
    const result: ConsoleDetectionResult = injectableDetectConsoleState(
      DEFAULT_SELECTOR_SET,
      identitySelectors,
    );
    expect(result).toEqual({ ready: true, accountId: "123456789012" });
    vi.unstubAllGlobals();
  });

  it("reports not ready when no console marker is present", () => {
    vi.stubGlobal("document", fakeDocument({}));
    const result = injectableDetectConsoleState(
      DEFAULT_SELECTOR_SET,
      identitySelectors,
    );
    expect(result.ready).toBe(false);
    vi.unstubAllGlobals();
  });

  it("reports ready without accountId when identity text has no matching pattern", () => {
    vi.stubGlobal(
      "document",
      fakeDocument({
        "#awsc-nav-header": "AWS Management Console",
        "#nav-usernameMenu": "no-account-id-here",
      }),
    );
    const result = injectableDetectConsoleState(
      DEFAULT_SELECTOR_SET,
      identitySelectors,
    );
    expect(result).toEqual({ ready: true });
    vi.unstubAllGlobals();
  });

  it("remains self-contained after bundling: source contains no shared bundler-helper references (regression guard, code review)", () => {
    // 本関数は Chrome の func 方式で toString() され対象ページの孤立ワールドで評価されるため、
    // esbuild 等のバンドラーが async/spread/generator のダウンレベル時に注入する
    // 共有ヘルパー（`__async` / `__spreadValues` 等、いずれも `__` 始まり）を参照していないことを
    // ソース文字列レベルで検証する。現在は vite.config.ts の build.target: "esnext" により
    // 下位変換が発生しないためガードは常に通るが、target 変更や構文追加による自己完結性の
    // 回帰を将来検出できる（ファイル先頭コメントの IMPORTANT 注記と対をなす）。
    const source = injectableDetectConsoleState.toString();
    expect(source).not.toMatch(/\b__[a-zA-Z]+\(/);
  });
});
