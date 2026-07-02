import { ok } from "@acs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTotpCodeWithWindowWait, remainingTotpSeconds } from "./totp-wait.js";

describe("remainingTotpSeconds", () => {
  it("computes the remaining seconds in the current 30-second window", () => {
    // Given: a timestamp 28 seconds into a TOTP window.
    const nowMs = 28_000;

    // When: remaining seconds are computed.
    const remainingSeconds = remainingTotpSeconds(nowMs);

    // Then: two seconds remain in the current window.
    expect(remainingSeconds).toBe(2);
  });
});

describe("getTotpCodeWithWindowWait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the fetched code immediately when enough seconds remain", async () => {
    // Given: the current TOTP window has ten seconds remaining.
    const fetchCalls: string[] = [];
    const sleepCalls: number[] = [];

    // When: a code is requested with a five-second minimum.
    const result = await getTotpCodeWithWindowWait({
      minRemainingSeconds: 5,
      fetchCode: async () => {
        fetchCalls.push("fetch");
        return ok("123456\n");
      },
      nowMs: () => 20_000,
      sleep: async (durationMs: number) => {
        sleepCalls.push(durationMs);
      },
    });

    // Then: the first code is returned without waiting or re-fetching.
    expect(result).toEqual({ ok: true, value: { code: "123456", remainingSeconds: 10 } });
    expect(fetchCalls).toEqual(["fetch"]);
    expect(sleepCalls).toEqual([]);
  });

  it("waits for the next window and re-fetches when remaining seconds are below minimum", async () => {
    // Given: the current window has two seconds remaining.
    let nowMs = 28_000;
    const fetchCalls: string[] = [];
    const sleepCalls: number[] = [];

    // When: a code is requested with a five-second minimum.
    const result = await getTotpCodeWithWindowWait({
      minRemainingSeconds: 5,
      fetchCode: async () => {
        const code = fetchCalls.length === 0 ? "111111" : "222222";
        fetchCalls.push(code);
        return ok(`${code}\n`);
      },
      nowMs: () => nowMs,
      sleep: async (durationMs: number) => {
        sleepCalls.push(durationMs);
        nowMs = 31_000;
      },
    });

    // Then: the stale code is discarded after a remaining+1 second wait.
    expect(result).toEqual({ ok: true, value: { code: "222222", remainingSeconds: 29 } });
    expect(fetchCalls).toEqual(["111111", "222222"]);
    expect(sleepCalls).toEqual([3_000]);
  });

  it("respects the configured minimum remaining seconds", async () => {
    // Given: seven seconds remain, which is below a configured eight-second minimum.
    let nowMs = 23_000;
    const sleepCalls: number[] = [];

    // When: a code is requested with that configured threshold.
    const result = await getTotpCodeWithWindowWait({
      minRemainingSeconds: 8,
      fetchCode: async () => ok(nowMs === 23_000 ? "111111" : "222222"),
      nowMs: () => nowMs,
      sleep: async (durationMs: number) => {
        sleepCalls.push(durationMs);
        nowMs = 31_000;
      },
    });

    // Then: waiting is driven by the configured threshold, not the default value.
    expect(result).toEqual({ ok: true, value: { code: "222222", remainingSeconds: 29 } });
    expect(sleepCalls).toEqual([8_000]);
  });

  it("uses timer-based sleep that can be driven by fake timers", async () => {
    // Given: the default sleep implementation is used near the end of a TOTP window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(28_000));
    let settled = false;
    const fetchCalls: string[] = [];

    // When: a code is requested and fake time advances to the next window.
    const resultPromise = getTotpCodeWithWindowWait({
      minRemainingSeconds: 5,
      fetchCode: async () => {
        const code = fetchCalls.length === 0 ? "111111" : "222222";
        fetchCalls.push(code);
        return ok(code);
      },
    });
    void resultPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_999);

    // Then: the promise has not resolved before the safety margin elapses.
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, value: { code: "222222", remainingSeconds: 29 } });
    expect(fetchCalls).toEqual(["111111", "222222"]);
  });
});
