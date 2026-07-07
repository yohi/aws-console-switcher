/**
 * Service Worker 用 storage ヘルパーのユニットテスト（task 4.1）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDLE_LOCK_MINUTES,
  DEFAULT_TOTP_MIN_REMAINING_SECONDS,
  invalidateAccountMetaEntry,
  loadAccountMetaCache,
  loadExtensionSettings,
  loadFlowContext,
  removeFlowContext,
  saveAccountMetaCache,
  saveExtensionSettings,
  saveFlowContext,
  type StorageArea,
} from "./storage.js";
import { type AccountMeta, type FlowContext } from "@acs/shared";

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

describe("storage helpers", () => {
  it("saves and loads FlowContext by tabId", async () => {
    const storage = createFakeStorage();
    const ctx: FlowContext = {
      tabId: 42,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "routing",
      startedAt: "2026-07-03T00:00:00Z",
      mfaRetryCount: 0,
    };

    await saveFlowContext(storage, ctx);
    const loaded = await loadFlowContext(storage, 42);
    expect(loaded).toEqual(ctx);
  });

  it("returns undefined for missing FlowContext", async () => {
    const storage = createFakeStorage();
    const loaded = await loadFlowContext(storage, 99);
    expect(loaded).toBeUndefined();
  });

  it("removes FlowContext", async () => {
    const storage = createFakeStorage();
    const ctx: FlowContext = {
      tabId: 42,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "routing",
      startedAt: "2026-07-03T00:00:00Z",
      mfaRetryCount: 0,
    };

    await saveFlowContext(storage, ctx);
    await removeFlowContext(storage, 42);
    const loaded = await loadFlowContext(storage, 42);
    expect(loaded).toBeUndefined();
  });
});

describe("extension settings helpers", () => {
  it("returns defaults when nothing is stored", async () => {
    const storage = createFakeStorage();
    const settings = await loadExtensionSettings(storage);
    expect(settings).toEqual({
      idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES,
      totpMinRemainingSeconds: DEFAULT_TOTP_MIN_REMAINING_SECONDS,
    });
  });

  it("round-trips saved settings", async () => {
    const storage = createFakeStorage();
    await saveExtensionSettings(storage, {
      idleLockMinutes: 30,
      totpMinRemainingSeconds: 8,
    });
    const settings = await loadExtensionSettings(storage);
    expect(settings).toEqual({ idleLockMinutes: 30, totpMinRemainingSeconds: 8 });
  });

  it("merges partial saves over existing values", async () => {
    const storage = createFakeStorage();
    await saveExtensionSettings(storage, { idleLockMinutes: 45 });
    expect(await loadExtensionSettings(storage)).toEqual({
      idleLockMinutes: 45,
      totpMinRemainingSeconds: DEFAULT_TOTP_MIN_REMAINING_SECONDS,
    });
    await saveExtensionSettings(storage, { totpMinRemainingSeconds: 9 });
    expect(await loadExtensionSettings(storage)).toEqual({
      idleLockMinutes: 45,
      totpMinRemainingSeconds: 9,
    });
  });
});

describe("account meta cache helpers (task 8.1, requirements 3.4)", () => {
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

  it("round-trips the cached AccountMeta array", async () => {
    const storage = createFakeStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);
  });

  it("returns [] when nothing is cached", async () => {
    const storage = createFakeStorage();
    expect(await loadAccountMetaCache(storage)).toEqual([]);
  });

  it("invalidates only the matching uuid and leaves others", async () => {
    const storage = createFakeStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    await invalidateAccountMetaEntry(storage, accountA.uuid);
    expect(await loadAccountMetaCache(storage)).toEqual([accountB]);
  });

  it("is a no-op when invalidating on an empty cache", async () => {
    const storage = createFakeStorage();
    await invalidateAccountMetaEntry(storage, accountA.uuid);
    expect(await loadAccountMetaCache(storage)).toEqual([]);
  });

  it("composes an initial sync, stale-entry invalidation, and re-sync into a consistent final cache (task 10.2, 補正反映)", async () => {
    // Given: an initial account sync has cached two accounts in chrome.storage.local.
    const storage = createFakeStorage();
    await saveAccountMetaCache(storage, [accountA, accountB]);
    expect(await loadAccountMetaCache(storage)).toEqual([accountA, accountB]);

    // When: a true object-absence correction invalidates the stale entry (task 8.2, S-3).
    await invalidateAccountMetaEntry(storage, accountA.uuid);
    expect(await loadAccountMetaCache(storage)).toEqual([accountB]);

    // And: a re-sync overwrites the cache, reflecting a later MFA enrollment (後付け MFA) and a re-added account.
    const resyncedB: AccountMeta = { ...accountB, mfaEnabled: true };
    const readdedA: AccountMeta = { ...accountA, alias: "prod-renamed" };
    await saveAccountMetaCache(storage, [readdedA, resyncedB]);

    // Then: reloading yields the composed final state with the corrected metadata.
    const finalCache = await loadAccountMetaCache(storage);
    expect(finalCache).toEqual([readdedA, resyncedB]);
    expect(finalCache.find((account) => account.uuid === accountB.uuid)?.mfaEnabled).toBe(true);
  });
});
