import { describe, expect, it, vi } from "vitest";
import { ok } from "@acs/shared";
import { startIdleLockTimer } from "./idle-lock.js";
import { createSessionManager } from "./session.js";
import type { BwCli } from "./bw-cli.js";

function makeFakeBwCli(lockCalls: string[]): BwCli {
  return {
    unlock: async () => ok("bw-session-token"),
    lock: async (sessionToken?: string) => {
      lockCalls.push(sessionToken ?? "");
      return ok("");
    },
    status: async () => ok("{\"status\":\"unlocked\"}"),
    listFolders: async () => ok("[]"),
    listItems: async () => ok("[]"),
    getItem: async () => ok("{\"login\":{\"username\":\"user\",\"password\":\"pass\"}}"),
    getTotp: async () => ok("123456"),
  };
}

describe("startIdleLockTimer", () => {
  it("locks and clears BW_SESSION after configured idle time elapses", async () => {
    // Given: an unlocked session configured with a one-minute idle timeout.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:00:00.000Z"));
    const lockCalls: string[] = [];
    const session = createSessionManager(() => new Date(Date.now()));
    session.configure({ idleLockMinutes: 1, totpMinRemainingSeconds: 5 });
    session.unlock("bw-session-token");
    const timer = startIdleLockTimer({
      bwCli: makeFakeBwCli(lockCalls),
      session,
      intervalMs: 1_000,
    });

    try {
      // When: the timer observes that idle time has exceeded the setting.
      await vi.advanceTimersByTimeAsync(61_000);

      // Then: bw lock runs once and the in-memory session is cleared.
      expect(lockCalls).toEqual(["bw-session-token"]);
      expect(session.currentSession()).toBeUndefined();
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });

  it("does nothing when the vault is already locked", async () => {
    // Given: a locked session and an active idle timer.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:00:00.000Z"));
    const lockCalls: string[] = [];
    const session = createSessionManager(() => new Date(Date.now()));
    session.configure({ idleLockMinutes: 1, totpMinRemainingSeconds: 5 });
    const timer = startIdleLockTimer({
      bwCli: makeFakeBwCli(lockCalls),
      session,
      intervalMs: 1_000,
    });

    try {
      // When: far more than the configured idle time elapses.
      await vi.advanceTimersByTimeAsync(121_000);

      // Then: no bw lock call is made because no BW_SESSION is held.
      expect(lockCalls).toEqual([]);
      expect(session.status().unlocked).toBe(false);
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });
});
