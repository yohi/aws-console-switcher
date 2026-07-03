import { describe, expect, it, vi } from "vitest";
import { err, ok, type FlowError, type Result } from "@acs/shared";
import { startIdleLockTimer } from "./idle-lock.js";
import { createSessionManager } from "./session.js";
import type { BwCli } from "./bw-cli.js";

const vaultLockedError: FlowError = {
  category: "precondition",
  code: "vault_locked",
  message: "Bitwarden vault could not be locked.",
  retriable: false,
} as const;

function makeFakeBwCli(
  lockCalls: string[],
  lockResult: (sessionToken?: string) => Promise<Result<string, FlowError>> = async () => ok(""),
): BwCli {
  return {
    unlock: async () => ok("bw-session-token"),
    lock: async (sessionToken?: string) => {
      lockCalls.push(sessionToken ?? "");
      return lockResult(sessionToken);
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

  it("keeps the in-memory session unlocked when bw lock returns an error", async () => {
    // Given: an unlocked session whose bw lock command fails as a typed Result.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:00:00.000Z"));
    const lockCalls: string[] = [];
    const session = createSessionManager(() => new Date(Date.now()));
    session.configure({ idleLockMinutes: 1, totpMinRemainingSeconds: 5 });
    session.unlock("bw-session-token");
    const timer = startIdleLockTimer({
      bwCli: makeFakeBwCli(lockCalls, async () => err(vaultLockedError)),
      session,
      intervalMs: 1_000,
    });

    try {
      // When: the timer tries to lock the idle vault.
      await vi.advanceTimersByTimeAsync(61_000);

      // Then: the failed bw lock does not clear the host's in-memory session.
      expect(lockCalls).toEqual(["bw-session-token"]);
      expect(session.currentSession()).toBe("bw-session-token");
    } finally {
      timer.stop();
      vi.useRealTimers();
    }
  });

  it("resets the in-flight guard and logs when bw lock rejects", async () => {
    // Given: the first bw lock attempt rejects and the second succeeds.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:00:00.000Z"));
    const lockCalls: string[] = [];
    const session = createSessionManager(() => new Date(Date.now()));
    session.configure({ idleLockMinutes: 1, totpMinRemainingSeconds: 5 });
    session.unlock("bw-session-token");
    let shouldReject = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timer = startIdleLockTimer({
      bwCli: makeFakeBwCli(lockCalls, async () => {
        if (shouldReject) {
          shouldReject = false;
          throw new Error("bw lock crashed");
        }
        return ok("");
      }),
      session,
      intervalMs: 1_000,
    });

    try {
      // When: two idle-lock ticks run after the first rejected command.
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // Then: the rejection is logged, the guard is cleared, and the retry can lock the session.
      expect(consoleError).toHaveBeenCalledOnce();
      expect(lockCalls).toEqual(["bw-session-token", "bw-session-token"]);
      expect(session.currentSession()).toBeUndefined();
    } finally {
      timer.stop();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
