/**
 * タブ監視とクリーンアップのユニットテスト（task 4.3）。
 */
import { describe, expect, it, vi } from "vitest";
import { type StorageArea } from "./storage.js";
import { startTabWatchers } from "./tab-watchers.js";
import { makeFlowError } from "@acs/shared";
import { type CredentialProvider } from "../secrets/bitwarden-credential-provider.js";
import { type LoginMessenger } from "./login-state-machine.js";

function createFakeStorage(): StorageArea {
  const data = new Map<string, unknown>();
  const storage: StorageArea = {
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
  return storage;
}

function createFakeChromeTabs() {
  const updatedListeners = new Set<(
    tabId: number,
    changeInfo: { url?: string },
    tab: { url?: string },
  ) => void>();
  const removedListeners = new Set<(tabId: number) => void>();

  return {
    onUpdated: {
      addListener: (fn: typeof updatedListeners extends Set<infer T> ? T : never) =>
        updatedListeners.add(fn),
    },
    onRemoved: {
      addListener: (fn: typeof removedListeners extends Set<infer T> ? T : never) =>
        removedListeners.add(fn),
    },
    _updatedListeners: updatedListeners,
    _removedListeners: removedListeners,
  };
}

function createFakeAlarms() {
  const alarmListeners = new Set<(alarm: { name: string }) => void | Promise<void>>();
  const created = new Map<string, { when?: number }>();
  return {
    onAlarm: {
      addListener: (fn: typeof alarmListeners extends Set<infer T> ? T : never) =>
        alarmListeners.add(fn),
    },
    create: vi.fn((name: string, info: { when?: number }) => {
      created.set(name, info);
    }),
    clear: vi.fn((name: string) => {
      created.delete(name);
    }),
    _alarmListeners: alarmListeners,
    _created: created,
  };
}

describe("startTabWatchers", () => {
  it("cleans up FlowContext when console URL is detected", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected: vi.fn(),
    });

    const listener = Array.from(tabs._updatedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    await Promise.resolve();
    await listener(42, { url: "https://console.aws.amazon.com/console/home" }, {
      url: "https://console.aws.amazon.com/console/home",
    });

    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
  });

  it("cleans up FlowContext when the flow tab is removed", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected: vi.fn(),
    });

    const listener = Array.from(tabs._removedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    await Promise.resolve();
    await Promise.resolve();
    await listener(42);

    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
  });
});

function fakeProviderWithTotp(
  getTotp: CredentialProvider["getTotp"],
): CredentialProvider {
  return {
    listAccounts: vi.fn(async () => ({ ok: true as const, value: [] })),
    getCredentials: vi.fn(async () => ({
      ok: true as const,
      value: { username: "admin", password: "secret" },
    })),
    getTotp,
  };
}

function fakeMessengerWithTotp(
  injectTotp: LoginMessenger["injectTotp"],
): LoginMessenger {
  return {
    injectAccountId: vi.fn(async () => ({ ok: true as const, value: undefined })),
    injectCredentials: vi.fn(async () => ({ ok: true as const, value: undefined })),
    injectTotp,
  };
}

describe("startTabWatchers alarm handler (task 4.4)", () => {
  it("fails the flow via dom_timeout when a non-MFA step times out", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onFlowFailed = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onFlowFailed,
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "flowTimeout:42" });

    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
    expect(onFlowFailed).toHaveBeenCalledTimes(1);
    const call = onFlowFailed.mock.calls[0];
    expect(call?.[0]).toBe(42);
    expect((call?.[2] as { category: string }).category).toBe("dom_timeout");
    expect((call?.[2] as { code: string }).code).toBe("page_not_rendered");
  });

  it("no-ops when no FlowContext exists for the alarm's tabId", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onFlowFailed = vi.fn();

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onFlowFailed,
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "flowTimeout:404" });

    expect(onFlowFailed).not.toHaveBeenCalled();
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it("ignores alarms whose name is not a flow-timeout alarm", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onFlowFailed = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onFlowFailed,
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "idleLock" });

    expect(onFlowFailed).not.toHaveBeenCalled();
    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeDefined();
  });

  it("re-issues TOTP and reschedules on the first awaiting_mfa timeout", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const getTotp = vi.fn(async () => ({
      ok: true as const,
      value: { code: "654321", remainingSeconds: 30 },
    }));
    const injectTotp = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const onFlowFailed = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      credentialProvider: fakeProviderWithTotp(getTotp),
      messenger: fakeMessengerWithTotp(injectTotp),
      onFlowFailed,
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "flowTimeout:42" });

    expect(getTotp).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(injectTotp).toHaveBeenCalledWith(42, "654321");
    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeDefined();
    expect((remaining["flow:42"] as { mfaRetryCount: number }).mfaRetryCount).toBe(1);
    expect((remaining["flow:42"] as { step: string }).step).toBe("awaiting_mfa");
    expect(alarms.create).toHaveBeenCalledWith("flowTimeout:42", {
      when: expect.any(Number),
    });
    expect(onFlowFailed).not.toHaveBeenCalled();
  });

  it("fails via dom_timeout once the awaiting_mfa retry limit is reached", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const getTotp = vi.fn(async () => ({
      ok: true as const,
      value: { code: "654321", remainingSeconds: 30 },
    }));
    const onFlowFailed = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 1,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      credentialProvider: fakeProviderWithTotp(getTotp),
      messenger: fakeMessengerWithTotp(
        vi.fn(async () => ({ ok: true as const, value: undefined })),
      ),
      onFlowFailed,
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "flowTimeout:42" });

    expect(getTotp).not.toHaveBeenCalled();
    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
    expect(onFlowFailed).toHaveBeenCalledTimes(1);
    expect((onFlowFailed.mock.calls[0]?.[2] as { category: string }).category).toBe(
      "dom_timeout",
    );
  });

  it("fails and cleans up when TOTP re-issue errors during an awaiting_mfa retry", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const getTotp = vi.fn(async () => ({
      ok: false as const,
      error: makeFlowError(
        "host_disconnected",
        "Native host port closed during TOTP wait.",
      ),
    }));
    const onFlowFailed = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      credentialProvider: fakeProviderWithTotp(getTotp),
      messenger: fakeMessengerWithTotp(
        vi.fn(async () => ({ ok: true as const, value: undefined })),
      ),
      onFlowFailed,
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "flowTimeout:42" });

    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
    expect(onFlowFailed).toHaveBeenCalledTimes(1);
    expect((onFlowFailed.mock.calls[0]?.[2] as { code: string }).code).toBe(
      "host_disconnected",
    );
  });
});

describe("startTabWatchers flow-state restoration & guard branches (task 10.1)", () => {
  it("ignores a non-console URL update and leaves the FlowContext intact", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onConsoleDetected = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected,
    });

    const listener = Array.from(tabs._updatedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    await listener(42, { url: "https://signin.aws.amazon.com/" }, {
      url: "https://signin.aws.amazon.com/",
    });

    expect(onConsoleDetected).not.toHaveBeenCalled();
    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeDefined();
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it("no-ops on a console URL update when no FlowContext exists for the tab", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onConsoleDetected = vi.fn();

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected,
    });

    const listener = Array.from(tabs._updatedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    await listener(99, { url: "https://console.aws.amazon.com/console/home" }, {
      url: "https://console.aws.amazon.com/console/home",
    });

    expect(onConsoleDetected).not.toHaveBeenCalled();
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it("no-ops when a tab without a FlowContext is removed", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected: vi.fn(),
    });

    const listener = Array.from(tabs._removedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    await listener(99);

    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it("falls back to tab.url when changeInfo carries no url on console detection", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onConsoleDetected = vi.fn();

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected,
    });

    const listener = Array.from(tabs._updatedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    // changeInfo に url が無く、tab.url のみが console を指すケース。
    await listener(42, {}, { url: "https://console.aws.amazon.com/console/home" });

    expect(onConsoleDetected).toHaveBeenCalledTimes(1);
    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
  });

  it("restores the FlowContext purely from storage and hands it to onConsoleDetected on console redirect (SW restart simulation)", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const onConsoleDetected = vi.fn();

    // 直前の SW インスタンスが永続化した想定の FlowContext を storage にだけ用意する。
    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: "2026-07-03T00:00:00.000Z",
        mfaRetryCount: 1,
      },
    });

    // モジュールレベルの記憶を持たない新しい startTabWatchers（＝再起動後の SW）を張る。
    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      onConsoleDetected,
    });

    const listener = Array.from(tabs._updatedListeners)[0];
    if (!listener) throw new Error("listener not registered");
    await listener(42, { url: "https://console.aws.amazon.com/console/home" }, {
      url: "https://console.aws.amazon.com/console/home",
    });

    // storage 内容だけから復元した FlowContext が done 経路へ渡る。
    expect(onConsoleDetected).toHaveBeenCalledTimes(1);
    expect(onConsoleDetected).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        mfaRetryCount: 1,
      }),
    );
    const remaining = await storage.get("flow:42");
    expect(remaining["flow:42"]).toBeUndefined();
  });

  it("recovers an awaiting_mfa flow purely from persisted storage across a simulated SW restart, preserving identity fields", async () => {
    const storage = createFakeStorage();
    const tabs = createFakeChromeTabs();
    const alarms = createFakeAlarms();
    const getTotp = vi.fn(async () => ({
      ok: true as const,
      value: { code: "222333", remainingSeconds: 28 },
    }));
    const injectTotp = vi.fn(async () => ({ ok: true as const, value: undefined }));

    await storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: "2026-07-03T00:00:00.000Z",
        mfaRetryCount: 0,
      },
    });

    startTabWatchers({
      storage,
      tabs: tabs as unknown as import('./tab-watchers.js').TabsApi,
      alarms: alarms as unknown as import('./tab-watchers.js').AlarmsApi,
      credentialProvider: fakeProviderWithTotp(getTotp),
      messenger: fakeMessengerWithTotp(injectTotp),
      onFlowFailed: vi.fn(),
    });

    const listener = Array.from(alarms._alarmListeners)[0];
    if (!listener) throw new Error("alarm listener not registered");
    await listener({ name: "flowTimeout:42" });

    // 再起動後も storage の値だけから復元し、識別フィールドを保ったまま retry を進める。
    const remaining = await storage.get("flow:42");
    const ctx = remaining["flow:42"] as {
      uuid: string;
      startedAt: string;
      step: string;
      mfaRetryCount: number;
    };
    expect(ctx.uuid).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(ctx.startedAt).toBe("2026-07-03T00:00:00.000Z");
    expect(ctx.step).toBe("awaiting_mfa");
    expect(ctx.mfaRetryCount).toBe(1);
    expect(getTotp).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(injectTotp).toHaveBeenCalledWith(42, "222333");
  });
});
