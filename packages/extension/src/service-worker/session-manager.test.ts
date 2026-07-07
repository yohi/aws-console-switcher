/**
 * SessionManager のユニットテスト（task 6.1 / 6.2, design.md「Ports（将来 SSO 対応の抽象, 4.2）」,
 * requirements 3.2.1）。
 *
 * 検証観点:
 * - switchTo: 既存セッションの前面化（tabs.update + windows.update + lastAccessedAt 更新）
 * - switchTo: タブ閉鎖（tabs.update reject）→ 新規ログインへフォールバック
 * - switchTo: 対象 UUID のセッション不在 → 新規ログインへフォールバック
 * - evictIfNeeded: 5 未満は無退避 / ちょうど 5 で最古（lastAccessedAt 昇順）を 1 件退避
 * - switchTo 新規ログイン経路: 上限時は onNewLoginRequired の前に退避する
 * - TOCTOU: 並行 switchTo（count=4）が直列化され同時上限 5 を超えない
 * - onActivated: 追跡中セッションの tabId 一致時のみ lastAccessedAt を更新
 */
import { describe, expect, it } from "vitest";
import { type SessionRecord } from "@acs/shared";
import {
  type StorageArea,
  loadSessionRecords,
  saveSessionRecord,
} from "./storage.js";
import {
  MAX_CONCURRENT_SESSIONS,
  type SessionManagerDeps,
  type SessionTabsApi,
  type SessionWindowsApi,
  createSessionManager,
} from "./session-manager.js";

/** 十分に古い基準時刻（現在時刻での更新と字句比較で確実に区別できる）。 */
const ANCIENT = "2000-01-01T00:00:00.000Z";

function makeSession(
  uuid: string,
  tabId: number,
  lastAccessedAt: string,
): SessionRecord {
  return {
    uuid,
    accountId: "123456789012",
    tabId,
    signedInAt: lastAccessedAt,
    lastAccessedAt,
    state: "active",
  };
}

interface FakeStorage {
  readonly storage: StorageArea;
  /** `remove` に渡された全キー（退避回数の観測用）。 */
  readonly removeCalls: string[];
}

/**
 * `chrome.storage.local` を模した非同期フェイク。
 * get/set/remove の各所で `await Promise.resolve()`（マイクロタスク境界）を挟むことで、
 * 直列化が欠落していれば実際に競合が観測される現実的な非同期ティックを再現する
 * （TOCTOU テストの race 可視化に必須）。
 */
function createFakeStorage(): FakeStorage {
  const data = new Map<string, unknown>();
  const removeCalls: string[] = [];
  const storage: StorageArea = {
    get: async (keys) => {
      await Promise.resolve();
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
    set: async (items) => {
      await Promise.resolve();
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
    remove: async (keys) => {
      await Promise.resolve();
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const key of keyList) {
        removeCalls.push(key);
        data.delete(key);
      }
    },
  };
  return { storage, removeCalls };
}

interface FakeTabs {
  readonly tabs: SessionTabsApi;
  readonly updateCalls: Array<{ tabId: number; props: { active?: boolean } }>;
  /** 登録済み onActivated リスナーを発火し、その完了まで待機する。 */
  readonly triggerActivated: (tabId: number) => Promise<void>;
}

function createFakeTabs(
  updateImpl?: (
    tabId: number,
    props: { active?: boolean },
  ) => Promise<{ id?: number; windowId?: number } | undefined>,
): FakeTabs {
  const updateCalls: Array<{ tabId: number; props: { active?: boolean } }> = [];
  const listeners: Array<
    (activeInfo: { tabId: number }) => void | Promise<void>
  > = [];
  const impl =
    updateImpl ??
    (async (tabId: number) => ({ id: tabId, windowId: tabId * 10 }));
  const tabs: SessionTabsApi = {
    update: async (tabId, props) => {
      updateCalls.push({ tabId, props });
      return impl(tabId, props);
    },
    onActivated: {
      addListener: (callback) => {
        listeners.push(callback);
      },
    },
  };
  return {
    tabs,
    updateCalls,
    triggerActivated: async (tabId) => {
      for (const cb of listeners) {
        await cb({ tabId });
      }
    },
  };
}

interface FakeWindows {
  readonly windows: SessionWindowsApi;
  readonly updateCalls: Array<{ windowId: number; props: { focused?: boolean } }>;
}

function createFakeWindows(
  updateImpl?: (
    windowId: number,
    props: { focused?: boolean },
  ) => Promise<unknown>,
): FakeWindows {
  const updateCalls: Array<{ windowId: number; props: { focused?: boolean } }> =
    [];
  const impl = updateImpl ?? (async () => undefined);
  const windows: SessionWindowsApi = {
    update: async (windowId, props) => {
      updateCalls.push({ windowId, props });
      return impl(windowId, props);
    },
  };
  return { windows, updateCalls };
}

describe("SessionManager.switchTo（前面化, task 6.1）", () => {
  it("既存セッションを前面化し lastAccessedAt を更新する", async () => {
    const { storage } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("a", 10, ANCIENT));
    const { tabs, updateCalls } = createFakeTabs();
    const { windows, updateCalls: windowsUpdateCalls } = createFakeWindows();
    const newLoginCalls: string[] = [];
    const deps: SessionManagerDeps = {
      storage,
      tabs,
      windows,
      onNewLoginRequired: (uuid) => {
        newLoginCalls.push(uuid);
      },
    };
    const manager = createSessionManager(deps);

    const result = await manager.switchTo("a");

    expect(result.ok).toBe(true);
    expect(updateCalls).toEqual([{ tabId: 10, props: { active: true } }]);
    expect(windowsUpdateCalls).toEqual([
      { windowId: 100, props: { focused: true } },
    ]);
    expect(newLoginCalls).toEqual([]);
    const [stored] = await loadSessionRecords(storage);
    expect(stored !== undefined && stored.lastAccessedAt > ANCIENT).toBe(true);
  });

  it("タブ閉鎖（tabs.update reject）時は新規ログインへフォールバックする", async () => {
    const { storage } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("a", 10, ANCIENT));
    const { tabs } = createFakeTabs(async () => {
      throw new Error("No tab with id: 10.");
    });
    const { windows, updateCalls: windowsUpdateCalls } = createFakeWindows();
    const newLoginCalls: string[] = [];
    const deps: SessionManagerDeps = {
      storage,
      tabs,
      windows,
      onNewLoginRequired: (uuid) => {
        newLoginCalls.push(uuid);
      },
    };
    const manager = createSessionManager(deps);

    const result = await manager.switchTo("a");

    expect(result.ok).toBe(true);
    expect(newLoginCalls).toEqual(["a"]);
    expect(windowsUpdateCalls).toEqual([]);
  });

  it("タブ閉鎖（tabs.update reject）時は新規ログインフォールバック前に stale な SessionRecord を削除する（message-router.ts の startLogin が古い tabId を誤返ししないようにする）", async () => {
    const { storage } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("a", 10, ANCIENT));
    const { tabs } = createFakeTabs(async () => {
      throw new Error("No tab with id: 10.");
    });
    const { windows } = createFakeWindows();
    const deps: SessionManagerDeps = {
      storage,
      tabs,
      windows,
      onNewLoginRequired: () => {
        // 新規ログインは本テストの関心外（recordSession は done 遷移時に別経路で実行される）。
      },
    };
    const manager = createSessionManager(deps);

    const result = await manager.switchTo("a");

    expect(result.ok).toBe(true);
    const sessions = await loadSessionRecords(storage);
    expect(sessions.find((s) => s.uuid === "a")).toBeUndefined();
  });

  it("windows.update が失敗してもタブは有効なので前面化を継続する", async () => {
    const { storage } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("a", 10, ANCIENT));
    const { tabs, updateCalls } = createFakeTabs();
    const { windows } = createFakeWindows(async () => {
      throw new Error("No window with id: 100.");
    });
    const newLoginCalls: string[] = [];
    const deps: SessionManagerDeps = {
      storage,
      tabs,
      windows,
      onNewLoginRequired: (uuid) => {
        newLoginCalls.push(uuid);
      },
    };
    const manager = createSessionManager(deps);

    const result = await manager.switchTo("a");

    expect(result.ok).toBe(true);
    expect(updateCalls).toEqual([{ tabId: 10, props: { active: true } }]);
    expect(newLoginCalls).toEqual([]);
    const [stored] = await loadSessionRecords(storage);
    expect(stored !== undefined && stored.lastAccessedAt > ANCIENT).toBe(true);
  });

  it("onNewLoginRequired が例外を投げても switchTo は reject せずエラー Result を返す", async () => {
    const { storage } = createFakeStorage();
    const { tabs } = createFakeTabs();
    const { windows } = createFakeWindows();
    const deps: SessionManagerDeps = {
      storage,
      tabs,
      windows,
      onNewLoginRequired: () => {
        throw new Error("failed to open sign-in tab");
      },
    };
    const manager = createSessionManager(deps);

    const result = await manager.switchTo("missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_configuration");
      expect(result.error.message).toContain("failed to open sign-in tab");
    }
  });

  it("対象 UUID のセッションが存在しない場合は新規ログインへフォールバックする", async () => {
    const { storage } = createFakeStorage();
    const { tabs, updateCalls } = createFakeTabs();
    const { windows, updateCalls: windowsUpdateCalls } = createFakeWindows();
    const newLoginCalls: string[] = [];
    const deps: SessionManagerDeps = {
      storage,
      tabs,
      windows,
      onNewLoginRequired: (uuid) => {
        newLoginCalls.push(uuid);
      },
    };
    const manager = createSessionManager(deps);

    const result = await manager.switchTo("missing");

    expect(result.ok).toBe(true);
    expect(newLoginCalls).toEqual(["missing"]);
    expect(updateCalls).toEqual([]);
    expect(windowsUpdateCalls).toEqual([]);
  });
});

describe("SessionManager.evictIfNeeded（LRU 退避, task 6.2）", () => {
  it("セッション数が 5 未満のときは何も退避しない", async () => {
    const { storage, removeCalls } = createFakeStorage();
    for (let i = 0; i < 4; i += 1) {
      await saveSessionRecord(
        storage,
        makeSession(`s${i}`, i, `2020-01-0${i + 1}T00:00:00.000Z`),
      );
    }
    const { tabs } = createFakeTabs();
    const { windows } = createFakeWindows();
    const manager = createSessionManager({
      storage,
      tabs,
      windows,
      onNewLoginRequired: () => {},
    });

    await manager.evictIfNeeded();

    expect(removeCalls.filter((k) => k.startsWith("session:"))).toEqual([]);
    expect(await loadSessionRecords(storage)).toHaveLength(4);
  });

  it("ちょうど 5 のとき lastAccessedAt 最古の 1 件のみ退避する", async () => {
    const { storage, removeCalls } = createFakeStorage();
    // oldest = "old"（2019）。他は 2020 以降。
    await saveSessionRecord(storage, makeSession("old", 1, "2019-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s2", 2, "2020-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s3", 3, "2021-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s4", 4, "2022-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s5", 5, "2023-01-01T00:00:00.000Z"));
    const { tabs } = createFakeTabs();
    const { windows } = createFakeWindows();
    const manager = createSessionManager({
      storage,
      tabs,
      windows,
      onNewLoginRequired: () => {},
    });

    await manager.evictIfNeeded();

    const remaining = await loadSessionRecords(storage);
    expect(remaining).toHaveLength(4);
    expect(remaining.map((s) => s.uuid).sort()).toEqual(["s2", "s3", "s4", "s5"]);
    expect(removeCalls.filter((k) => k.startsWith("session:"))).toEqual([
      "session:old",
    ]);
  });
});

describe("SessionManager.switchTo 新規ログイン経路の退避（task 6.2）", () => {
  it("上限（5）時は onNewLoginRequired の前に最古を退避する", async () => {
    const { storage, removeCalls } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("old", 1, "2019-01-01T00:00:00.000Z"));
    for (let i = 2; i <= 5; i += 1) {
      await saveSessionRecord(
        storage,
        makeSession(`s${i}`, i, `20${18 + i}-01-01T00:00:00.000Z`),
      );
    }
    const { tabs } = createFakeTabs();
    const { windows } = createFakeWindows();
    const countAtNewLogin: number[] = [];
    const newLoginCalls: string[] = [];
    const manager = createSessionManager({
      storage,
      tabs,
      windows,
      onNewLoginRequired: async (uuid) => {
        newLoginCalls.push(uuid);
        // onNewLoginRequired 到達時点で退避済み＝残り 4 件であること。
        countAtNewLogin.push((await loadSessionRecords(storage)).length);
        // 新規セッション追加をシミュレート（最新時刻なので次回の退避対象にならない）。
        await saveSessionRecord(
          storage,
          makeSession(uuid, 900, new Date().toISOString()),
        );
      },
    });

    const result = await manager.switchTo("new");

    expect(result.ok).toBe(true);
    expect(newLoginCalls).toEqual(["new"]);
    expect(countAtNewLogin).toEqual([4]);
    expect(removeCalls.filter((k) => k.startsWith("session:"))).toEqual([
      "session:old",
    ]);
    // 退避 1 + 追加 1 = 上限 5 を維持。
    expect(await loadSessionRecords(storage)).toHaveLength(MAX_CONCURRENT_SESSIONS);
  });

  it("TOCTOU: count=4 での並行 switchTo が直列化され上限 5 を超えない", async () => {
    const { storage, removeCalls } = createFakeStorage();
    // 古い順の 4 セッション（退避対象は常にこの中の最古）。
    await saveSessionRecord(storage, makeSession("s1", 1, "2019-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s2", 2, "2020-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s3", 3, "2021-01-01T00:00:00.000Z"));
    await saveSessionRecord(storage, makeSession("s4", 4, "2022-01-01T00:00:00.000Z"));
    const { tabs } = createFakeTabs();
    const { windows } = createFakeWindows();
    const newLoginCalls: string[] = [];
    let addCounter = 0;
    const manager = createSessionManager({
      storage,
      tabs,
      windows,
      onNewLoginRequired: async (uuid) => {
        newLoginCalls.push(uuid);
        addCounter += 1;
        // 新規セッション追加を最新時刻でシミュレート。
        await saveSessionRecord(
          storage,
          makeSession(uuid, 900 + addCounter, new Date().toISOString()),
        );
      },
    });

    // 2 つの未サインイン UUID を await を挟まず同時発火する。
    await Promise.all([manager.switchTo("n1"), manager.switchTo("n2")]);

    // 直列化されていれば: n1 追加→5、n2 は 5 を観測し 1 件退避→4→追加→5。
    // 直列化が無ければ両者が count=4 を通過し退避 0・追加 2 で 6 件になる。
    expect(await loadSessionRecords(storage)).toHaveLength(MAX_CONCURRENT_SESSIONS);
    expect(removeCalls.filter((k) => k.startsWith("session:"))).toHaveLength(1);
    expect(newLoginCalls.sort()).toEqual(["n1", "n2"]);
  });
});

describe("SessionManager onActivated（最終アクセス時刻の追跡, task 6.2）", () => {
  it("活性化タブが追跡中セッションと一致したら lastAccessedAt を更新する", async () => {
    const { storage } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("a", 10, ANCIENT));
    const { tabs, triggerActivated } = createFakeTabs();
    const { windows } = createFakeWindows();
    createSessionManager({
      storage,
      tabs,
      windows,
      onNewLoginRequired: () => {},
    });

    await triggerActivated(10);

    const [stored] = await loadSessionRecords(storage);
    expect(stored !== undefined && stored.lastAccessedAt > ANCIENT).toBe(true);
  });

  it("追跡外タブの活性化は無視する（更新も例外もなし）", async () => {
    const { storage } = createFakeStorage();
    await saveSessionRecord(storage, makeSession("a", 10, ANCIENT));
    const { tabs, triggerActivated } = createFakeTabs();
    const { windows } = createFakeWindows();
    createSessionManager({
      storage,
      tabs,
      windows,
      onNewLoginRequired: () => {},
    });

    await triggerActivated(999);

    const [stored] = await loadSessionRecords(storage);
    expect(stored?.lastAccessedAt).toBe(ANCIENT);
  });
});
