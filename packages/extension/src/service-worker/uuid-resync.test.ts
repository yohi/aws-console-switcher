/**
 * UUID 再同期トリガー分類のユニットテスト（task 8.2, requirements 3.4, S-3）。
 */
import { describe, expect, it, vi } from "vitest";
import { type AccountMeta, makeFlowError } from "@acs/shared";
import {
  loadAccountMetaCache,
  saveAccountMetaCache,
  type StorageArea,
} from "./storage.js";
import { classifyAndHandleSecretFetchError } from "./uuid-resync.js";

const accountA: AccountMeta = {
  uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  accountId: "123456789012",
  alias: "prod",
  username: "admin",
  mfaEnabled: true,
};
const accountB: AccountMeta = {
  uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  accountId: "210987654321",
  alias: "dev",
  username: "dev-user",
  mfaEnabled: false,
};

function createSpyStorage(): {
  storage: StorageArea;
  setSpy: ReturnType<typeof vi.fn>;
} {
  const data = new Map<string, unknown>();
  const setSpy = vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      data.set(key, value);
    }
  });
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
    set: setSpy,
    remove: async (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const key of keyList) {
        data.delete(key);
      }
    },
  };
  return { storage, setSpy };
}

describe("classifyAndHandleSecretFetchError (task 8.2, requirements 3.4, S-3)", () => {
  it("invalidates the cache and returns an enriched error on item_not_found", async () => {
    const { storage, setSpy } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    setSpy.mockClear();

    const original = makeFlowError("item_not_found", "bw item not found");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result.code).toBe("item_not_found");
    expect(result.message).not.toBe(original.message);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(await loadAccountMetaCache(storage)).toEqual([accountB]);
  });

  it("invalidates the cache on invalid_uuid", async () => {
    const { storage } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);

    const original = makeFlowError("invalid_uuid", "invalid uuid");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result.code).toBe("invalid_uuid");
    expect(await loadAccountMetaCache(storage)).toEqual([accountB]);
  });

  it("keeps the cache untouched and returns the original error on vault_locked", async () => {
    const { storage, setSpy } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    setSpy.mockClear();

    const original = makeFlowError("vault_locked", "vault is locked");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result).toBe(original);
    expect(setSpy).not.toHaveBeenCalled();
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);
  });

  it("keeps the cache untouched on bad_password (aws_auth, non-transient, non-missing)", async () => {
    const { storage, setSpy } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    setSpy.mockClear();

    const original = makeFlowError("bad_password", "aws rejected credentials");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result).toBe(original);
    expect(setSpy).not.toHaveBeenCalled();
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);
  });

  it("keeps the cache untouched and returns the original error on bw_not_logged_in (transient precondition)", async () => {
    const { storage, setSpy } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    setSpy.mockClear();

    const original = makeFlowError("bw_not_logged_in", "bw is not logged in");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result).toBe(original);
    expect(setSpy).not.toHaveBeenCalled();
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);
  });

  it("keeps the cache untouched and returns the original error on host_not_running (transient precondition)", async () => {
    const { storage, setSpy } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    setSpy.mockClear();

    const original = makeFlowError("host_not_running", "native host is not running");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result).toBe(original);
    expect(setSpy).not.toHaveBeenCalled();
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);
  });

  it("keeps the cache untouched and returns the original error on host_disconnected (transient precondition)", async () => {
    const { storage, setSpy } = createSpyStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    setSpy.mockClear();

    const original = makeFlowError("host_disconnected", "native host port closed");
    const result = await classifyAndHandleSecretFetchError(
      storage,
      accountA.uuid,
      original,
    );

    expect(result).toBe(original);
    expect(setSpy).not.toHaveBeenCalled();
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);
  });
});
