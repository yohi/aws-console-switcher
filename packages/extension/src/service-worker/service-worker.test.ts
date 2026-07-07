/**
 * Service Worker bootstrap のユニットテスト（task 4 / 6.1 の実 chrome.* 結線）。
 *
 * 既存の message-router / tab-watchers / session-manager テストと同じ DI モックパターン
 * （vi.fn() でチェーンした chrome.* API のフェイク）で、bootstrapServiceWorker が
 * リスナー登録・メッセージルーティング・応答返却・タブ監視登録・アラーム監視登録・
 * SessionManager 構築・Native Messaging アダプタ接続を行うことを検証する。
 */
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapServiceWorker,
  type ServiceWorkerApis,
} from "./service-worker.js";
import { NATIVE_HOST_NAME } from "../native-host-name.js";
import { type StorageArea } from "./storage.js";
import { type ChromeRuntimePort } from "../secrets/native-messaging-adapter.js";
import { type AccountMeta } from "@acs/shared";

/** 保留中のマイクロ/マクロタスクを完了させる（handleMessage の非同期応答待ち）。 */
const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

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

function createFakeTabs() {
  return {
    create: vi.fn(async (_props: { url: string; active?: boolean }) => ({
      id: 42,
      windowId: 1,
    })),
    update: vi.fn(async (tabId: number, _props: object) => ({
      id: tabId,
      windowId: 1,
    })),
    query: vi.fn(async (_queryInfo: object) => []),
    sendMessage: vi.fn(async (_tabId: number, _message: unknown) => undefined),
    onUpdated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
    get: vi.fn(async (_tabId: number) => ({
      url: "https://console.aws.amazon.com/console/home",
    })),
  };
}

function createFakePort(): ChromeRuntimePort {
  const listeners = new Set<(message: unknown) => void>();
  return {
    name: NATIVE_HOST_NAME,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn) => {
        listeners.add(fn);
      },
      removeListener: (fn) => {
        listeners.delete(fn);
      },
    },
    onDisconnect: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  };
}

/** onMessage リスナーの最小形状（MV3: sendResponse + return true で非同期応答）。 */
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

function createFakeRuntime() {
  const port = createFakePort();
  let captured: MessageListener | undefined;
  return {
    connectNative: vi.fn((_name: string) => port),
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn((callback: MessageListener) => {
        captured = callback;
      }),
    },
    getMessageListener: (): MessageListener | undefined => captured,
  };
}

function createFakeAlarms() {
  return {
    onAlarm: { addListener: vi.fn() },
    create: vi.fn(),
    clear: vi.fn(),
  };
}

function createFakeWindows() {
  return { update: vi.fn(async () => undefined) };
}

function createFakeScripting() {
  return { executeScript: vi.fn(async () => []) };
}

interface HarnessFakes {
  readonly storage: StorageArea;
  readonly tabs: ReturnType<typeof createFakeTabs>;
  readonly runtime: ReturnType<typeof createFakeRuntime>;
  readonly alarms: ReturnType<typeof createFakeAlarms>;
  readonly windows: ReturnType<typeof createFakeWindows>;
  readonly scripting: ReturnType<typeof createFakeScripting>;
}

/** フェイクを構築し bootstrap へ注入する（境界で `as unknown as` して実 chrome 型へ整合させる）。 */
function bootstrapWithFakes(storage: StorageArea = createFakeStorage()): HarnessFakes {
  const tabs = createFakeTabs();
  const runtime = createFakeRuntime();
  const alarms = createFakeAlarms();
  const windows = createFakeWindows();
  const scripting = createFakeScripting();
  bootstrapServiceWorker({
    storage,
    tabs: tabs as unknown as ServiceWorkerApis["tabs"],
    runtime: runtime as unknown as ServiceWorkerApis["runtime"],
    alarms: alarms as unknown as ServiceWorkerApis["alarms"],
    windows: windows as unknown as ServiceWorkerApis["windows"],
    scripting: scripting as unknown as ServiceWorkerApis["scripting"],
  });
  return { storage, tabs, runtime, alarms, windows, scripting };
}

describe("bootstrapServiceWorker", () => {
  it("registers exactly one runtime.onMessage listener that returns true (MV3 async response)", () => {
    const { runtime } = bootstrapWithFakes();

    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    const listener = runtime.getMessageListener();
    expect(listener).toBeDefined();
    const returned = listener?.({ kind: "listAccounts" }, {}, vi.fn());
    expect(returned).toBe(true);
  });

  it("routes inbound messages through handleMessage and replies via sendResponse (PopupResponse shape)", async () => {
    const storage = createFakeStorage();
    const meta: AccountMeta = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      alias: "prod",
      username: "admin",
      mfaEnabled: true,
    };
    // メタデータキャッシュを事前投入し、ホスト往復なしに listAccounts を解決させる。
    await storage.set({ "cache:accounts": [meta] });
    const { runtime } = bootstrapWithFakes(storage);

    const sendResponse = vi.fn();
    const listener = runtime.getMessageListener();
    listener?.({ kind: "listAccounts" }, {}, sendResponse);
    await flushAsync();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const response = sendResponse.mock.calls[0]?.[0];
    expect(response).toMatchObject({ ok: true, value: { accounts: [meta] } });
  });

  it("registers global tab watchers (onUpdated/onRemoved) and the alarm handler (onAlarm)", () => {
    const { tabs, alarms } = bootstrapWithFakes();

    expect(tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
  });

  it("constructs a SessionManager that subscribes to tabs.onActivated", () => {
    const { tabs } = bootstrapWithFakes();

    expect(tabs.onActivated.addListener).toHaveBeenCalledTimes(1);
  });

  it("connects the Native Messaging adapter using the production host name on the first host request", () => {
    const { runtime } = bootstrapWithFakes();
    const listener = runtime.getMessageListener();

    // lock はホスト往復を伴うため、送信時に connectNative(NATIVE_HOST_NAME) が同期的に呼ばれる。
    listener?.({ kind: "lock" }, {}, vi.fn());

    expect(runtime.connectNative).toHaveBeenCalledWith(NATIVE_HOST_NAME);
  });
});
