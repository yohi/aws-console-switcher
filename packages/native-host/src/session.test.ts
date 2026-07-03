import { describe, expect, it } from "vitest";
import { createSessionManager } from "./session.js";

describe("SessionManager", () => {
  it("reports locked status when no BW_SESSION is held", () => {
    // Given: a fresh native-host process session manager.
    const session = createSessionManager();

    // When: status is requested before unlock.
    const status = session.status();

    // Then: no in-memory Bitwarden session is reported.
    expect(status).toEqual({
      unlocked: false,
      lastUsedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("stores BW_SESSION and last-used timestamp when unlocked", () => {
    // Given: a deterministic clock and a fresh session manager.
    const now = new Date("2026-07-03T01:02:03.004Z");
    const session = createSessionManager(() => now);

    // When: the vault is unlocked with a session token.
    session.unlock("bw-session-token");

    // Then: only process memory exposes unlocked status and the last-used timestamp.
    expect(session.currentSession()).toBe("bw-session-token");
    expect(session.status()).toEqual({
      unlocked: true,
      lastUsedAt: "2026-07-03T01:02:03.004Z",
    });
  });

  it("clears BW_SESSION without resetting last-used timestamp when locked", () => {
    // Given: an unlocked in-memory Bitwarden session.
    const now = new Date("2026-07-03T01:02:03.004Z");
    const session = createSessionManager(() => now);
    session.unlock("bw-session-token");

    // When: the host locks the vault.
    session.lock();

    // Then: the sensitive session token is gone while status remains well-formed.
    expect(session.currentSession()).toBeUndefined();
    expect(session.status()).toEqual({
      unlocked: false,
      lastUsedAt: "2026-07-03T01:02:03.004Z",
    });
  });

  it("rejects invalid idle lock minutes before storing settings", () => {
    // Given: a session manager with default settings.
    const session = createSessionManager();

    for (const idleLockMinutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      // When / Then: invalid idle lock durations are rejected as range errors.
      expect(() => {
        session.configure({ idleLockMinutes, totpMinRemainingSeconds: 5 });
      }).toThrow(RangeError);
    }

    expect(session.settings()).toEqual({ idleLockMinutes: 20, totpMinRemainingSeconds: 5 });
  });

  it("rejects invalid TOTP minimum remaining seconds before storing settings", () => {
    // Given: a session manager with default settings.
    const session = createSessionManager();

    for (const totpMinRemainingSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      // When / Then: invalid TOTP thresholds are rejected as range errors.
      expect(() => {
        session.configure({ idleLockMinutes: 20, totpMinRemainingSeconds });
      }).toThrow(RangeError);
    }

    expect(session.settings()).toEqual({ idleLockMinutes: 20, totpMinRemainingSeconds: 5 });
  });
});
