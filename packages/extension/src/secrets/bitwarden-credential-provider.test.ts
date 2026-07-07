/**
 * Bitwarden 用 CredentialProvider のユニットテスト（task 3.2）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AccountMeta,
  type FlowError,
  type HostRequest,
  type HostResponse,
  type Result,
} from "@acs/shared";
import {
  BitwardenCredentialProvider,
  type SecretSourceAdapter,
} from "./bitwarden-credential-provider.js";

function createFakeAdapter(): SecretSourceAdapter & {
  resolveNext: (response: HostResponse) => void;
  resolveNextError: (error: FlowError) => void;
  _pending: { request: HostRequest; resolve: (value: Result<HostResponse, FlowError>) => void }[];
} {
  const pending: {
    request: HostRequest;
    resolve: (value: Result<HostResponse, FlowError>) => void;
  }[] = [];

  return {
    send: vi.fn(async (request: HostRequest) => {
      return new Promise<Result<HostResponse, FlowError>>((resolve) => {
        pending.push({ request, resolve });
      });
    }),
    resolveNext: (response: HostResponse) => {
      const next = pending.shift();
      if (!next) {
        throw new Error("no pending request");
      }
      next.resolve({ ok: true, value: response });
    },
    resolveNextError: (error: FlowError) => {
      const next = pending.shift();
      if (!next) {
        throw new Error("no pending request");
      }
      next.resolve({ ok: false, error });
    },
    _pending: pending,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("BitwardenCredentialProvider", () => {
  it("lists accounts by resolving folder name then listing items", async () => {
    const adapter = createFakeAdapter();
    const provider = new BitwardenCredentialProvider(
      adapter as unknown as SecretSourceAdapter,
      "AWS Accounts",
    );

    const listPromise = provider.listAccounts();
    adapter.resolveNext({
      type: "folders",
      requestId: "r1",
      folders: [
        { id: "folder-1", name: "Other" },
        { id: "folder-aws", name: "AWS Accounts" },
      ],
    });

    await flushMicrotasks();

    const itemsResponse: HostResponse = {
      type: "items",
      requestId: "r2",
      items: [
        {
          uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          accountId: "123456789012",
          alias: "prod",
          username: "admin",
          mfaEnabled: true,
        } satisfies AccountMeta,
      ],
    };
    adapter.resolveNext(itemsResponse);

    const result = await listPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        accountId: "123456789012",
        alias: "prod",
        username: "admin",
        mfaEnabled: true,
      });
    }
  });

  it("returns invalid_configuration when folder is not found", async () => {
    const adapter = createFakeAdapter();
    const provider = new BitwardenCredentialProvider(
      adapter as unknown as SecretSourceAdapter,
      "Missing Folder",
    );

    const listPromise = provider.listAccounts();
    adapter.resolveNext({
      type: "folders",
      requestId: "r1",
      folders: [{ id: "folder-1", name: "Other" }],
    });

    const result = await listPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_configuration");
      expect(result.error.category).toBe("precondition");
    }
  });

  it("returns credentials from item response", async () => {
    const adapter = createFakeAdapter();
    const provider = new BitwardenCredentialProvider(
      adapter as unknown as SecretSourceAdapter,
    );

    const credsPromise = provider.getCredentials(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    adapter.resolveNext({
      type: "item",
      requestId: "r1",
      username: "admin",
      password: "secret-password",
    });

    const result = await credsPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.username).toBe("admin");
      expect(result.value.password).toBe("secret-password");
    }
  });

  it("returns totp code with remaining seconds", async () => {
    const adapter = createFakeAdapter();
    const provider = new BitwardenCredentialProvider(
      adapter as unknown as SecretSourceAdapter,
    );

    const totpPromise = provider.getTotp(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    adapter.resolveNext({
      type: "totp",
      requestId: "r1",
      code: "123456",
      remainingSeconds: 17,
    });

    const result = await totpPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toBe("123456");
      expect(result.value.remainingSeconds).toBe(17);
    }
  });

  it("maps host errors to FlowError", async () => {
    const adapter = createFakeAdapter();
    const provider = new BitwardenCredentialProvider(
      adapter as unknown as SecretSourceAdapter,
    );

    const promise = provider.getCredentials(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    adapter.resolveNextError({
      category: "precondition",
      code: "vault_locked",
      message: "Vault is locked",
      retriable: false,
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("vault_locked");
    }
  });
});
