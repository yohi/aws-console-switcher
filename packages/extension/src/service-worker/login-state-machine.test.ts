/**
 * ログイン自動化ステートマシンのユニットテスト（task 4.2, task 8.2）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AccountMeta,
  type FlowContext,
  makeFlowError,
} from "@acs/shared";
import {
  type CredentialProvider,
} from "../secrets/bitwarden-credential-provider.js";
import {
  loadAccountMetaCache,
  saveAccountMetaCache,
  type StorageArea,
} from "./storage.js";
import {
  LoginStateMachine,
  type LoginMessenger,
} from "./login-state-machine.js";

const accountA: AccountMeta = {
  uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  accountId: "123456789012",
  alias: "prod",
  username: "admin",
  mfaEnabled: true,
};

function createFakeProvider(): CredentialProvider {
  return {
    listAccounts: vi.fn(async () => ({
      ok: true as const,
      value: [accountA],
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

function createFakeProviderWith(
  overrides: Partial<CredentialProvider> = {},
): CredentialProvider {
  return { ...createFakeProvider(), ...overrides };
}

function createFakeMessenger() {
  return {
    injectCredentials: vi.fn(async () => ({ ok: true as const, value: undefined })),
    injectTotp: vi.fn(async () => ({ ok: true as const, value: undefined })),
    injectAccountId: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

/**
 * injectAccountId / injectCredentials / injectTotp の一部を差し替えた
 * LoginMessenger を作る（値注入失敗分岐の検証用）。
 */
function createFakeMessengerWith(
  overrides: Partial<LoginMessenger> = {},
): LoginMessenger {
  return { ...createFakeMessenger(), ...overrides };
}

/**
 * 各遷移テスト用に FlowContext を組み立てる小さなヘルパー。
 * step と一部フィールドのみ差し替え、既定は accountA・tabId 1・mfaRetryCount 0。
 */
function makeCtx(
  step: FlowContext["step"],
  overrides: Partial<FlowContext> = {},
): FlowContext {
  return {
    tabId: 1,
    uuid: accountA.uuid,
    step,
    startedAt: new Date().toISOString(),
    mfaRetryCount: 0,
    ...overrides,
  };
}

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

describe("LoginStateMachine", () => {
  it("transitions to awaiting_account_id on accountIdFieldShown", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );
    const ctx: FlowContext = {
      tabId: 1,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "routing",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "accountIdFieldShown" });
    expect(result.step).toBe("awaiting_account_id");
  });

  it("transitions to awaiting_credentials on credentialFieldShown and injects credentials", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());
    const ctx: FlowContext = {
      tabId: 1,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "routing",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "credentialFieldShown" });
    expect(result.step).toBe("awaiting_credentials");
    expect(messenger.injectCredentials).toHaveBeenCalledWith(
      1,
      "admin",
      "secret",
    );
  });

  it("transitions to awaiting_mfa on mfaScreenShown and injects TOTP", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());
    const ctx: FlowContext = {
      tabId: 1,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "awaiting_credentials",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "mfaScreenShown" });
    expect(result.step).toBe("awaiting_mfa");
    expect(messenger.injectTotp).toHaveBeenCalledWith(1, "123456");
  });

  it("returns done on console redirect", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );
    const ctx: FlowContext = {
      tabId: 1,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "awaiting_credentials",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "consoleRedirect" });
    expect(result.step).toBe("done");
  });

  it("returns failed on authError", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );
    const ctx: FlowContext = {
      tabId: 1,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "awaiting_credentials",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "authError" });
    expect(result.step).toBe("failed");
  });

  it("retries TOTP once with a fresh code on authError in awaiting_mfa (task 9.1)", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());
    const ctx: FlowContext = {
      tabId: 1,
      uuid: accountA.uuid,
      step: "awaiting_mfa",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "authError" });
    expect(result.step).toBe("awaiting_mfa");
    expect(provider.getTotp).toHaveBeenCalledWith(accountA.uuid);
    expect(messenger.injectTotp).toHaveBeenCalledWith(1, "123456");
    if (result.step === "awaiting_mfa") {
      expect(result.ctx?.mfaRetryCount).toBe(1);
    }
  });

  it("fails with a non-retriable totp_rejected once the retry limit is exceeded (task 9.1)", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());
    const ctx: FlowContext = {
      tabId: 1,
      uuid: accountA.uuid,
      step: "awaiting_mfa",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 1,
    };

    const result = await machine.handleEvent(ctx, { event: "authError" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("totp_rejected");
      expect(result.error.retriable).toBe(false);
    }
    expect(messenger.injectTotp).not.toHaveBeenCalled();
  });

  it("fails when the fresh TOTP fetch is rejected during retry (task 9.1)", async () => {
    const provider = createFakeProviderWith({
      getTotp: vi.fn(async () => ({
        ok: false as const,
        error: makeFlowError("host_disconnected", "port closed"),
      })),
    });
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());
    const ctx: FlowContext = {
      tabId: 1,
      uuid: accountA.uuid,
      step: "awaiting_mfa",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "authError" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("host_disconnected");
    }
    expect(messenger.injectTotp).not.toHaveBeenCalled();
  });

  it("invalidates the cached UUID and returns the classified error when getCredentials fails with item_not_found (task 8.2)", async () => {
    const provider = createFakeProviderWith({
      getCredentials: vi.fn(async () => ({
        ok: false as const,
        error: makeFlowError("item_not_found", "bw item not found"),
      })),
    });
    const storage = createFakeStorage();
    await saveAccountMetaCache(storage, [accountA]);
    const machine = new LoginStateMachine(provider, createFakeMessenger(), storage);
    const ctx: FlowContext = {
      tabId: 1,
      uuid: accountA.uuid,
      step: "routing",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "credentialFieldShown" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("item_not_found");
      expect(result.error.message).not.toBe("bw item not found");
    }
    expect(await loadAccountMetaCache(storage)).toEqual([]);
  });

  it("leaves the cache untouched and returns the original error when getCredentials fails with vault_locked (task 8.2)", async () => {
    const original = makeFlowError("vault_locked", "vault is locked");
    const provider = createFakeProviderWith({
      getCredentials: vi.fn(async () => ({ ok: false as const, error: original })),
    });
    const storage = createFakeStorage();
    await saveAccountMetaCache(storage, [accountA]);
    const machine = new LoginStateMachine(provider, createFakeMessenger(), storage);
    const ctx: FlowContext = {
      tabId: 1,
      uuid: accountA.uuid,
      step: "routing",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const result = await machine.handleEvent(ctx, { event: "credentialFieldShown" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error).toBe(original);
    }
    expect(await loadAccountMetaCache(storage)).toEqual([accountA]);
  });

  // --- handleRouting の未網羅分岐（Cookie 記憶での MFA/完了・失敗）（task 10.1） ---

  it("injects TOTP and transitions to awaiting_mfa on mfaScreenShown while routing (Cookie-remembered MFA account)", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("routing"), { event: "mfaScreenShown" });
    expect(result.step).toBe("awaiting_mfa");
    expect(messenger.injectTotp).toHaveBeenCalledWith(1, "123456");
  });

  it("returns done on consoleRedirect while routing (Cookie-remembered full session)", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("routing"), { event: "consoleRedirect" });
    expect(result.step).toBe("done");
  });

  it("fails with bad_password on authError while routing", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("routing"), { event: "authError" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("bad_password");
    }
  });

  // --- handleAwaitingAccountId の各分岐（注入成功・アカウント欠落・注入失敗・Cookie 記憶・失敗）（task 10.1） ---

  it("injects the account ID and advances to awaiting_credentials on accountIdFieldShown", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_account_id"), {
      event: "accountIdFieldShown",
    });
    expect(result.step).toBe("awaiting_credentials");
    expect(messenger.injectAccountId).toHaveBeenCalledWith(1, "123456789012");
  });

  it("fails with invalid_configuration when the flow UUID is absent from the account list on accountIdFieldShown", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );
    const ctx = makeCtx("awaiting_account_id", {
      uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    });

    const result = await machine.handleEvent(ctx, { event: "accountIdFieldShown" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("invalid_configuration");
    }
  });

  it("fails and propagates the messenger error when injectAccountId fails on accountIdFieldShown", async () => {
    const messenger = createFakeMessengerWith({
      injectAccountId: vi.fn(async () => ({
        ok: false as const,
        error: makeFlowError("selector_not_found", "account field not found"),
      })),
    });
    const machine = new LoginStateMachine(createFakeProvider(), messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_account_id"), {
      event: "accountIdFieldShown",
    });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("selector_not_found");
    }
  });

  it("injects credentials on credentialFieldShown while awaiting_account_id (account ID already remembered)", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_account_id"), {
      event: "credentialFieldShown",
    });
    expect(result.step).toBe("awaiting_credentials");
    expect(messenger.injectCredentials).toHaveBeenCalledWith(1, "admin", "secret");
  });

  it("returns done on consoleRedirect while awaiting_account_id (Cookie-remembered, skipped credentials)", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("awaiting_account_id"), {
      event: "consoleRedirect",
    });
    expect(result.step).toBe("done");
  });

  it("fails with bad_password on authError while awaiting_account_id", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("awaiting_account_id"), { event: "authError" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("bad_password");
    }
  });

  // --- handleAwaitingCredentials の未網羅分岐（再描画注入・DOM タイムアウト・注入失敗）（task 10.1） ---

  it("re-injects credentials on a repeated credentialFieldShown while awaiting_credentials", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_credentials"), {
      event: "credentialFieldShown",
    });
    expect(result.step).toBe("awaiting_credentials");
    expect(messenger.injectCredentials).toHaveBeenCalledWith(1, "admin", "secret");
  });

  it("fails with page_not_rendered on domTimeout while awaiting_credentials", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("awaiting_credentials"), { event: "domTimeout" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("page_not_rendered");
    }
  });

  it("fails and propagates the messenger error when injectCredentials fails", async () => {
    const messenger = createFakeMessengerWith({
      injectCredentials: vi.fn(async () => ({
        ok: false as const,
        error: makeFlowError("selector_not_found", "password field not found"),
      })),
    });
    const machine = new LoginStateMachine(createFakeProvider(), messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_credentials"), {
      event: "credentialFieldShown",
    });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("selector_not_found");
    }
  });

  // --- handleAwaitingMfa の未網羅分岐（直接注入・完了・DOM タイムアウト・注入失敗・無関係イベント）（task 10.1） ---

  it("injects TOTP on a repeated mfaScreenShown while awaiting_mfa", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_mfa"), { event: "mfaScreenShown" });
    expect(result.step).toBe("awaiting_mfa");
    expect(messenger.injectTotp).toHaveBeenCalledWith(1, "123456");
  });

  it("returns done on consoleRedirect while awaiting_mfa", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("awaiting_mfa"), { event: "consoleRedirect" });
    expect(result.step).toBe("done");
  });

  it("fails with page_not_rendered on domTimeout while awaiting_mfa", async () => {
    const machine = new LoginStateMachine(
      createFakeProvider(),
      createFakeMessenger(),
      createFakeStorage(),
    );

    const result = await machine.handleEvent(makeCtx("awaiting_mfa"), { event: "domTimeout" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("page_not_rendered");
    }
  });

  it("fails and propagates the messenger error when injectTotp fails on mfaScreenShown", async () => {
    const messenger = createFakeMessengerWith({
      injectTotp: vi.fn(async () => ({
        ok: false as const,
        error: makeFlowError("selector_not_found", "mfa field not found"),
      })),
    });
    const machine = new LoginStateMachine(createFakeProvider(), messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_mfa"), { event: "mfaScreenShown" });
    expect(result.step).toBe("failed");
    if (result.step === "failed") {
      expect(result.error.code).toBe("selector_not_found");
    }
  });

  it("ignores an out-of-order credentialFieldShown while awaiting_mfa and stays in the same step", async () => {
    const provider = createFakeProvider();
    const messenger = createFakeMessenger();
    const machine = new LoginStateMachine(provider, messenger, createFakeStorage());

    const result = await machine.handleEvent(makeCtx("awaiting_mfa"), {
      event: "credentialFieldShown",
    });
    expect(result.step).toBe("awaiting_mfa");
    expect(messenger.injectTotp).not.toHaveBeenCalled();
    expect(messenger.injectCredentials).not.toHaveBeenCalled();
  });
});
