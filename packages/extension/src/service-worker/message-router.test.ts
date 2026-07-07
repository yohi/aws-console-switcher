/**
 * Service Worker メッセージルーターのユニットテスト（task 4.1）。
 */
import { describe, expect, it, vi } from "vitest";
import { routeMessage, handleMessage, performNewLogin, type MessageRouterDeps } from "./message-router.js";
import { type AccountMeta, type HostRequest, type SessionRecord, makeFlowError } from "@acs/shared";
import {
  type CredentialProvider,
  type SecretSourceAdapter,
} from "../secrets/bitwarden-credential-provider.js";
import {
  loadAccountMetaCache,
  loadSessionRecords,
  saveAccountMetaCache,
  saveSessionRecord,
  type StorageArea,
} from "./storage.js";
import { type ScriptingApi } from "./console-state-detector.js";
import {
  type SessionManager,
  type SessionTabsApi,
  type SessionWindowsApi,
  createSessionManager,
} from "./session-manager.js";

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

function createFakeCredentialProvider(): CredentialProvider {
  return {
    listAccounts: vi.fn(async () => ({
      ok: true as const,
      value: [
        {
          uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          accountId: "123456789012",
          alias: "prod",
          username: "admin",
          mfaEnabled: true,
        } satisfies AccountMeta,
      ],
    })),
    getCredentials: vi.fn(async () => ({
      ok: true as const,
      value: { username: "admin", password: "secret" },
    })),
    getTotp: vi.fn(async () => ({
      ok: true as const,
      value: { code: "123456", remainingSeconds: 17 },
    })),
  };
}

function createFakeTabs() {
  return {
    create: vi.fn(async (_props: { url: string }) => ({ id: 42 })),
    update: vi.fn(async (_tabId: number, _props: object) => ({})),
    query: vi.fn(async (_query: object) => []),
    sendMessage: vi.fn(async (_tabId: number, _message: unknown) => undefined),
    // console-state-detector.ts の ConsoleDetectorTabsApi 契約（既定はコンソールタブとして扱う）。
    get: vi.fn(async (_tabId: number) => ({
      url: "https://console.aws.amazon.com/console/home",
    })),
  };
}

/** console-state-detector.ts の ScriptingApi 契約のフェイク（既定は無検出扱いで安全側）。 */
function createFakeScripting(
  impl?: ScriptingApi["executeScript"],
): ScriptingApi {
  return {
    executeScript: vi.fn(impl ?? (async () => [])) as ScriptingApi["executeScript"],
  };
}

function createFakeAlarms() {
  return {
    onAlarm: { addListener: vi.fn() },
    create: vi.fn(),
    clear: vi.fn(),
  };
}

function createFakeAdapter(
  sendImpl?: SecretSourceAdapter["send"],
): SecretSourceAdapter {
  const defaultSend: SecretSourceAdapter["send"] = async () => ({
    ok: true,
    value: { requestId: "x", type: "configured" },
  });
  return { send: vi.fn(sendImpl ?? defaultSend) };
}

function createFakeSessionTabs(): SessionTabsApi {
  return {
    update: vi.fn(async (tabId: number, _props: { active?: boolean }) => ({
      id: tabId,
      windowId: tabId * 10,
    })),
    onActivated: { addListener: vi.fn() },
  };
}

function createFakeSessionWindows(): SessionWindowsApi {
  return { update: vi.fn(async () => undefined) };
}

function createDeps(
  overrides: Partial<MessageRouterDeps> = {},
): MessageRouterDeps {
  const storage = overrides.storage ?? createFakeStorage();
  const credentialProvider =
    overrides.credentialProvider ?? createFakeCredentialProvider();
  const tabs =
    overrides.tabs ?? (createFakeTabs() as unknown as MessageRouterDeps["tabs"]);
  const runtime =
    overrides.runtime ??
    ({ sendMessage: vi.fn() } as unknown as typeof chrome.runtime);
  const hostName = overrides.hostName ?? "com.example.host";
  const alarms =
    overrides.alarms ??
    (createFakeAlarms() as unknown as MessageRouterDeps["alarms"]);
  const adapter = overrides.adapter ?? createFakeAdapter();
  const scripting =
    overrides.scripting ?? (createFakeScripting() as unknown as MessageRouterDeps["scripting"]);
  // sessionManager は startLogin の switchTo 経路が使う。既定は実 createSessionManager を
  // フェイクの tabs/windows で構築し、未サインイン時の onNewLoginRequired が performNewLogin
  // （新規タブ作成 + FlowContext 保存 + アラーム登録）へ委譲するよう配線する（bootstrap と同一配線）。
  let deps: MessageRouterDeps;
  const sessionManager =
    overrides.sessionManager ??
    createSessionManager({
      storage,
      tabs: createFakeSessionTabs(),
      windows: createFakeSessionWindows(),
      onNewLoginRequired: async (uuid) => {
        const result = await performNewLogin(deps, uuid);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
      },
    });
  deps = {
    storage,
    credentialProvider,
    tabs,
    runtime,
    hostName,
    alarms,
    adapter,
    sessionManager,
    scripting,
  };
  return deps;
}

describe("routeMessage", () => {
  it("persists FlowContext on startLogin", async () => {
    const deps = createDeps();
    const response = await routeMessage(deps, {
      kind: "startLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(response.ok).toBe(true);
    const stored = await deps.storage.get("flow:42");
    expect(stored["flow:42"]).toMatchObject({
      tabId: 42,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "routing",
      mfaRetryCount: 0,
    });
  });

  it("startLogin foregrounds an existing session via SessionManager.switchTo without creating a new tab (task 6.1)", async () => {
    const switchTo = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const sessionManager: SessionManager = {
      getActiveSessions: vi.fn(async () => []),
      switchTo,
      evictIfNeeded: vi.fn(async () => undefined),
    };
    const deps = createDeps({ sessionManager });
    // 前面化対象の既存セッションを storage に用意する（switchTo 成功後に tabId を引く元）。
    const record: SessionRecord = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      tabId: 77,
      signedInAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: "active",
    };
    await saveSessionRecord(deps.storage, record);

    const response = await routeMessage(deps, {
      kind: "startLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    // switchTo 経由で解決し、新規タブ作成（performNewLogin）は行わない。
    expect(switchTo).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(deps.tabs.create).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value).toEqual({ tabId: 77 });
    }
  });

  it("startLogin propagates a SessionManager.switchTo failure as a RouterResponse error (task 6.1)", async () => {
    const sessionManager: SessionManager = {
      getActiveSessions: vi.fn(async () => []),
      switchTo: vi.fn(async () => ({
        ok: false as const,
        error: makeFlowError(
          "invalid_configuration",
          "No active session and a new login could not be started.",
        ),
      })),
      evictIfNeeded: vi.fn(async () => undefined),
    };
    const deps = createDeps({ sessionManager });

    const response = await routeMessage(deps, {
      kind: "startLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("invalid_configuration");
    }
  });

  it("startLogin reads accounts from cache without hitting the provider when cache is non-empty (task 8.1 pattern reuse)", async () => {
    const deps = createDeps();
    const cached: AccountMeta = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      alias: "prod",
      username: "admin",
      mfaEnabled: true,
    };
    await saveAccountMetaCache(deps.storage, [cached]);

    const response = await routeMessage(deps, {
      kind: "startLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(response.ok).toBe(true);
    expect(deps.credentialProvider.listAccounts).not.toHaveBeenCalled();
  });

  it("returns accounts for listAccounts", async () => {
    const deps = createDeps();
    const response = await routeMessage(deps, { kind: "listAccounts" });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect((response.value as { accounts: AccountMeta[] }).accounts).toHaveLength(1);
    }
  });

  it("listAccounts returns cached accounts without hitting the provider when cache is non-empty (task 8.1)", async () => {
    const deps = createDeps();
    const cached: AccountMeta = {
      uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      accountId: "999999999999",
      alias: "cached",
      username: "cached-user",
      mfaEnabled: false,
    };
    await saveAccountMetaCache(deps.storage, [cached]);

    const response = await routeMessage(deps, { kind: "listAccounts" });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect((response.value as { accounts: AccountMeta[] }).accounts).toEqual([
        cached,
      ]);
    }
    expect(deps.credentialProvider.listAccounts).not.toHaveBeenCalled();
  });

  it("listAccounts falls back to a fresh fetch and caches it when the cache is empty (task 8.1)", async () => {
    const deps = createDeps();
    const response = await routeMessage(deps, { kind: "listAccounts" });
    expect(response.ok).toBe(true);
    expect(deps.credentialProvider.listAccounts).toHaveBeenCalledTimes(1);
    expect(await loadAccountMetaCache(deps.storage)).toHaveLength(1);
  });

  it("syncAccounts overwrites the cache with a fresh fetch (task 8.1, requirements 3.4 (b))", async () => {
    const deps = createDeps();
    await saveAccountMetaCache(deps.storage, []);

    const response = await routeMessage(deps, { kind: "syncAccounts" });
    expect(response.ok).toBe(true);
    expect(deps.credentialProvider.listAccounts).toHaveBeenCalledTimes(1);
    expect(await loadAccountMetaCache(deps.storage)).toHaveLength(1);
  });

  it("listAccounts corrects session states and includes sessions in the response (task 5.3/8.1)", async () => {
    const scripting = createFakeScripting(async () => [
      { result: { ready: true, accountId: "123456789012" } },
    ]);
    const deps = createDeps({
      scripting: scripting as unknown as MessageRouterDeps["scripting"],
    });
    const record: SessionRecord = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      tabId: 42,
      signedInAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: "unknown",
    };
    await saveSessionRecord(deps.storage, record);

    const response = await routeMessage(deps, { kind: "listAccounts" });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const value = response.value as { sessions: readonly SessionRecord[] };
      expect(value.sessions).toHaveLength(1);
      expect(value.sessions[0]).toMatchObject({ state: "active" });
    }
  });

  it("syncAccounts corrects session states and includes sessions in the response (task 5.3/8.1)", async () => {
    const scripting = createFakeScripting(async () => [
      { result: { ready: true, accountId: "999999999999" } },
    ]);
    const deps = createDeps({
      scripting: scripting as unknown as MessageRouterDeps["scripting"],
    });
    const record: SessionRecord = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      tabId: 42,
      signedInAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: "active",
    };
    await saveSessionRecord(deps.storage, record);

    const response = await routeMessage(deps, { kind: "syncAccounts" });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const value = response.value as { sessions: readonly SessionRecord[] };
      expect(value.sessions).toHaveLength(1);
      // 検出された accountId が既存レコードと明確に異なるため、控えめに unknown へ補正し
      // レコードの accountId も実態へ補正する（誤って signed-in と表示しない, 3.1）。
      expect(value.sessions[0]).toMatchObject({
        state: "unknown",
        accountId: "999999999999",
      });
    }
  });

  it("ignores unknown messages without error", async () => {
    const deps = createDeps();
    const response = await routeMessage(deps, { kind: "notReal" } as unknown as { kind: "listAccounts" });
    expect(response.ok).toBe(true);
  });

  it("registers a flowTimeout alarm on startLogin", async () => {
    const deps = createDeps();
    await routeMessage(deps, {
      kind: "startLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(deps.alarms.create).toHaveBeenCalledWith("flowTimeout:42", {
      when: expect.any(Number),
    });
  });

  it("reschedules the flowTimeout alarm on a signinDomEvent step transition", async () => {
    const deps = createDeps();
    await deps.storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "routing",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      event: "mfaScreenShown",
    });

    expect(response.ok).toBe(true);
    const stored = await deps.storage.get("flow:42");
    expect((stored["flow:42"] as { step: string }).step).toBe("awaiting_mfa");
    expect(deps.alarms.create).toHaveBeenCalledWith("flowTimeout:42", {
      when: expect.any(Number),
    });
  });

  it("unlocks then configures the host and resyncs accounts", async () => {
    const sends: Array<Omit<HostRequest, "requestId">> = [];
    const adapter = createFakeAdapter(async (request) => {
      sends.push(request);
      if (request.type === "unlock") {
        return { ok: true, value: { requestId: "1", type: "unlocked" } };
      }
      return { ok: true, value: { requestId: "2", type: "configured" } };
    });
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, {
      kind: "unlock",
      masterPassword: "pw",
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value).toMatchObject({ unlocked: true, configured: true });
      expect(
        (response.value as { accounts: AccountMeta[] }).accounts,
      ).toHaveLength(1);
    }
    expect(sends.map((s) => s.type)).toEqual(["unlock", "configure"]);
    expect(sends.find((s) => s.type === "configure")).toMatchObject({
      idleLockMinutes: 20,
      totpMinRemainingSeconds: 5,
    });
  });

  it("propagates an adapter transport failure on unlock", async () => {
    const adapter = createFakeAdapter(async () => ({
      ok: false,
      error: makeFlowError("host_disconnected", "port closed"),
    }));
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, {
      kind: "unlock",
      masterPassword: "pw",
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("host_disconnected");
    }
  });

  it("propagates a host error response (bad_password) on unlock", async () => {
    const adapter = createFakeAdapter(async (request) => {
      if (request.type === "unlock") {
        return {
          ok: true,
          value: {
            requestId: "1",
            type: "error",
            error: makeFlowError("bad_password", "wrong password"),
          },
        };
      }
      return { ok: true, value: { requestId: "2", type: "configured" } };
    });
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, {
      kind: "unlock",
      masterPassword: "pw",
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("bad_password");
    }
  });

  it("still reports unlock success when configure fails", async () => {
    const adapter = createFakeAdapter(async (request) => {
      if (request.type === "unlock") {
        return { ok: true, value: { requestId: "1", type: "unlocked" } };
      }
      return {
        ok: false,
        error: makeFlowError("host_disconnected", "configure failed"),
      };
    });
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, {
      kind: "unlock",
      masterPassword: "pw",
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value).toMatchObject({
        unlocked: true,
        configured: false,
      });
    }
  });

  it("locks successfully", async () => {
    const adapter = createFakeAdapter(async () => ({
      ok: true,
      value: { requestId: "1", type: "locked" },
    }));
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, { kind: "lock" });

    expect(response.ok).toBe(true);
  });

  it("propagates a lock transport failure", async () => {
    const adapter = createFakeAdapter(async () => ({
      ok: false,
      error: makeFlowError("host_disconnected", "port closed"),
    }));
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, { kind: "lock" });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("host_disconnected");
    }
  });

  it("configures the host and persists merged settings on updateSettings", async () => {
    const configureReqs: Array<Omit<HostRequest, "requestId">> = [];
    const adapter = createFakeAdapter(async (request) => {
      configureReqs.push(request);
      return { ok: true, value: { requestId: "1", type: "configured" } };
    });
    const deps = createDeps({ adapter });

    const response = await routeMessage(deps, {
      kind: "updateSettings",
      idleLockMinutes: 45,
    });

    expect(response.ok).toBe(true);
    expect(configureReqs[0]).toMatchObject({
      type: "configure",
      idleLockMinutes: 45,
      totpMinRemainingSeconds: 5,
    });
    const stored = await deps.storage.get("settings:extension");
    expect(stored["settings:extension"]).toMatchObject({
      idleLockMinutes: 45,
      totpMinRemainingSeconds: 5,
    });
  });

  it("removes the persisted FlowContext for the matching uuid on cancelLogin", async () => {
    const deps = createDeps();
    await deps.storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    const response = await routeMessage(deps, {
      kind: "cancelLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(response.ok).toBe(true);
    const stored = await deps.storage.get("flow:42");
    expect(stored["flow:42"]).toBeUndefined();
    // task: resetFlow はクリーンアップ単一経路（cleanupFlow）を通し、flowTimeout アラームも解除する。
    expect(deps.alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
  });

  it("removes the persisted FlowContext for the matching uuid on retryLogin", async () => {
    const deps = createDeps();
    await deps.storage.set({
      "flow:7": {
        tabId: 7,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_mfa",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 1,
      },
    });

    const response = await routeMessage(deps, {
      kind: "retryLogin",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    expect(response.ok).toBe(true);
    const stored = await deps.storage.get("flow:7");
    expect(stored["flow:7"]).toBeUndefined();
    expect(deps.alarms.clear).toHaveBeenCalledWith("flowTimeout:7");
  });

  it("no-ops safely on cancelLogin when no persisted flow matches the uuid", async () => {
    const deps = createDeps();
    await deps.storage.set({
      "flow:42": {
        tabId: 42,
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        step: "awaiting_credentials",
        startedAt: new Date().toISOString(),
        mfaRetryCount: 0,
      },
    });

    const response = await routeMessage(deps, {
      kind: "cancelLogin",
      uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    });

    expect(response.ok).toBe(true);
    // 非対象 uuid のフローは削除されない。
    const stored = await deps.storage.get("flow:42");
    expect(stored["flow:42"]).toBeDefined();
    expect(deps.alarms.clear).not.toHaveBeenCalled();
  });

  it("acknowledges consoleState without error (task 5.3/8.1 stub route)", async () => {
    const deps = createDeps();
    const response = await routeMessage(deps, {
      kind: "consoleState",
      tabId: 42,
      accountId: "123456789012",
    });
    expect(response.ok).toBe(true);
  });

  it("corrects the matching SessionRecord to active when the reported accountId matches (consoleState real correction, task 5.3/8.1)", async () => {
    const deps = createDeps();
    const record: SessionRecord = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      tabId: 42,
      signedInAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: "unknown",
    };
    await saveSessionRecord(deps.storage, record);

    const response = await routeMessage(deps, {
      kind: "consoleState",
      tabId: 42,
      accountId: "123456789012",
    });

    expect(response.ok).toBe(true);
    const sessions = await loadSessionRecords(deps.storage);
    expect(sessions.find((s) => s.uuid === record.uuid)?.state).toBe("active");
  });

  it("corrects the matching SessionRecord to unknown and updates accountId on mismatch (consoleState real correction, task 5.3/8.1)", async () => {
    const deps = createDeps();
    const record: SessionRecord = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      tabId: 42,
      signedInAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: "active",
    };
    await saveSessionRecord(deps.storage, record);

    const response = await routeMessage(deps, {
      kind: "consoleState",
      tabId: 42,
      accountId: "999999999999",
    });

    expect(response.ok).toBe(true);
    const sessions = await loadSessionRecords(deps.storage);
    expect(sessions.find((s) => s.uuid === record.uuid)).toMatchObject({
      state: "unknown",
      accountId: "999999999999",
    });
  });

  it("leaves storage untouched when no SessionRecord matches the reported tabId (consoleState real correction, task 5.3/8.1)", async () => {
    const deps = createDeps();
    const record: SessionRecord = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      accountId: "123456789012",
      tabId: 7,
      signedInAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      state: "active",
    };
    await saveSessionRecord(deps.storage, record);

    const response = await routeMessage(deps, {
      kind: "consoleState",
      tabId: 999,
      accountId: "123456789012",
    });

    expect(response.ok).toBe(true);
    const sessions = await loadSessionRecords(deps.storage);
    expect(sessions.find((s) => s.uuid === record.uuid)?.state).toBe("active");
  });
});

const FLOW_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const accountA: AccountMeta = {
  uuid: FLOW_UUID,
  accountId: "123456789012",
  alias: "prod",
  username: "admin",
  mfaEnabled: true,
};

async function seedFlowContext(
  deps: MessageRouterDeps,
  step: string,
  mfaRetryCount = 0,
): Promise<void> {
  await deps.storage.set({
    "flow:42": {
      tabId: 42,
      uuid: FLOW_UUID,
      step,
      startedAt: new Date().toISOString(),
      mfaRetryCount,
    },
  });
}

describe("handleSigninDomEvent live-wiring (LoginStateMachine integration)", () => {
  it("injects the account ID and advances to awaiting_credentials on accountIdFieldShown (live-wired)", async () => {
    const deps = createDeps();
    await seedFlowContext(deps, "awaiting_account_id");

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: FLOW_UUID,
      event: "accountIdFieldShown",
    });

    expect(response.ok).toBe(true);
    expect(deps.tabs.sendMessage).toHaveBeenCalledWith(42, {
      kind: "injectAccountId",
      accountId: "123456789012",
    });
    const stored = await deps.storage.get("flow:42");
    expect((stored["flow:42"] as { step: string }).step).toBe(
      "awaiting_credentials",
    );
  });

  it("injects credentials and transitions to awaiting_credentials on credentialFieldShown while routing (Cookie-remembered branch, live-wired)", async () => {
    const deps = createDeps();
    await seedFlowContext(deps, "routing");

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: FLOW_UUID,
      event: "credentialFieldShown",
    });

    expect(response.ok).toBe(true);
    expect(deps.tabs.sendMessage).toHaveBeenCalledWith(42, {
      kind: "injectCredentials",
      username: "admin",
      password: "secret",
    });
    const stored = await deps.storage.get("flow:42");
    expect((stored["flow:42"] as { step: string }).step).toBe(
      "awaiting_credentials",
    );
    expect(deps.alarms.create).toHaveBeenCalledWith("flowTimeout:42", {
      when: expect.any(Number),
    });
  });

  it("injects a fresh TOTP code and transitions to awaiting_mfa on mfaScreenShown (live-wired)", async () => {
    const deps = createDeps();
    await seedFlowContext(deps, "awaiting_credentials");

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: FLOW_UUID,
      event: "mfaScreenShown",
    });

    expect(response.ok).toBe(true);
    expect(deps.tabs.sendMessage).toHaveBeenCalledWith(42, {
      kind: "injectTotp",
      code: "123456",
    });
    const stored = await deps.storage.get("flow:42");
    expect((stored["flow:42"] as { step: string }).step).toBe("awaiting_mfa");
  });

  it("persists the incremented mfaRetryCount from LoginAction.ctx on an awaiting_mfa TOTP retry (task 9.1 carry-through)", async () => {
    const deps = createDeps();
    await seedFlowContext(deps, "awaiting_mfa", 0);

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: FLOW_UUID,
      event: "authError",
    });

    expect(response.ok).toBe(true);
    expect(deps.tabs.sendMessage).toHaveBeenCalledWith(42, {
      kind: "injectTotp",
      code: "123456",
    });
    const stored = await deps.storage.get("flow:42");
    expect((stored["flow:42"] as { step: string }).step).toBe("awaiting_mfa");
    expect((stored["flow:42"] as { mfaRetryCount: number }).mfaRetryCount).toBe(
      1,
    );
    expect(deps.alarms.create).toHaveBeenCalledWith("flowTimeout:42", {
      when: expect.any(Number),
    });
  });

  it("cleans up, logs a structured FlowError, and returns a failure on authError (live-wired failed transition)", async () => {
    const deps = createDeps();
    await seedFlowContext(deps, "awaiting_credentials");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: FLOW_UUID,
      event: "authError",
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("bad_password");
    }
    // 失敗遷移では値注入を行わない。
    expect(deps.tabs.sendMessage).not.toHaveBeenCalled();
    // クリーンアップ単一経路: FlowContext 削除 + アラーム解除。
    const stored = await deps.storage.get("flow:42");
    expect(stored["flow:42"]).toBeUndefined();
    expect(deps.alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
    // handleSigninDomEvent 内で logFlowError(error, {tabId, uuid}) が呼ばれる。
    expect(spy).toHaveBeenCalledTimes(1);
    const [, record] = spy.mock.calls[0] ?? [];
    expect(record).toMatchObject({
      kind: "flow_error",
      code: "bad_password",
      context: { tabId: 42, uuid: FLOW_UUID },
    });
    spy.mockRestore();
  });

  it("propagates a classified secret-fetch failure (item_not_found) and cleans up (task 8.2 boundary)", async () => {
    const deps = createDeps({
      credentialProvider: {
        listAccounts: vi.fn(async () => ({ ok: true as const, value: [accountA] })),
        getCredentials: vi.fn(async () => ({
          ok: false as const,
          error: makeFlowError("item_not_found", "bw item not found"),
        })),
        getTotp: vi.fn(async () => ({
          ok: true as const,
          value: { code: "123456", remainingSeconds: 17 },
        })),
      },
    });
    await saveAccountMetaCache(deps.storage, [accountA]);
    await seedFlowContext(deps, "routing");

    const response = await routeMessage(deps, {
      kind: "signinDomEvent",
      tabId: 42,
      uuid: FLOW_UUID,
      event: "credentialFieldShown",
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("item_not_found");
    }
    const stored = await deps.storage.get("flow:42");
    expect(stored["flow:42"]).toBeUndefined();
    expect(deps.alarms.clear).toHaveBeenCalledWith("flowTimeout:42");
    // task 8.2: 真のオブジェクト欠落は当該 UUID をキャッシュから無効化する。
    expect(await loadAccountMetaCache(deps.storage)).toEqual([]);
  });
});

describe("handleMessage boundary logging", () => {
  it("logs a structured FlowError at the boundary when a route fails (task 9.1)", async () => {
    const adapter = createFakeAdapter(async () => ({
      ok: false,
      error: makeFlowError("host_disconnected", "port closed"),
    }));
    const deps = createDeps({ adapter });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleMessage(deps, { kind: "lock" });

    expect(response.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, record] = spy.mock.calls[0] ?? [];
    expect(record).toMatchObject({
      kind: "flow_error",
      category: "precondition",
      code: "host_disconnected",
      context: { messageKind: "lock" },
    });
    expect(record).not.toHaveProperty("message");
    spy.mockRestore();
  });
});
