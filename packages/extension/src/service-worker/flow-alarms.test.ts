/**
 * フロー・タイムアウト用アラームヘルパーのユニットテスト（task 4.4）。
 */
import { describe, expect, it, vi } from "vitest";
import { type FlowContext } from "@acs/shared";
import {
  type AlarmsApi,
  DOM_TIMEOUT_MS,
  MFA_RETRY_LIMIT,
  MFA_TIMEOUT_MS,
  flowAlarmName,
  parseFlowAlarmName,
  scheduleFlowTimeout,
  timeoutWindowForStep,
} from "./flow-alarms.js";

describe("flow-alarms constants", () => {
  it("uses a 10s default window, a 35s MFA window, and a retry limit of 1", () => {
    expect(DOM_TIMEOUT_MS).toBe(10_000);
    expect(MFA_TIMEOUT_MS).toBe(35_000);
    expect(MFA_RETRY_LIMIT).toBe(1);
  });
});

describe("flowAlarmName / parseFlowAlarmName", () => {
  it("builds and parses a flow alarm name round-trip", () => {
    expect(flowAlarmName(42)).toBe("flowTimeout:42");
    expect(parseFlowAlarmName("flowTimeout:42")).toBe(42);
  });

  it("returns undefined for names that are not flow-timeout alarms", () => {
    expect(parseFlowAlarmName("otherAlarm")).toBeUndefined();
    expect(parseFlowAlarmName("flowTimeout:")).toBeUndefined();
    expect(parseFlowAlarmName("flowTimeout:abc")).toBeUndefined();
    expect(parseFlowAlarmName("flowTimeout:1.5")).toBeUndefined();
  });
});

describe("timeoutWindowForStep", () => {
  it("returns 10s for non-MFA steps and 35s for awaiting_mfa", () => {
    expect(timeoutWindowForStep("routing")).toBe(DOM_TIMEOUT_MS);
    expect(timeoutWindowForStep("awaiting_account_id")).toBe(DOM_TIMEOUT_MS);
    expect(timeoutWindowForStep("awaiting_credentials")).toBe(DOM_TIMEOUT_MS);
    expect(timeoutWindowForStep("awaiting_mfa")).toBe(MFA_TIMEOUT_MS);
  });
});

describe("scheduleFlowTimeout", () => {
  it("registers a flowTimeout alarm keyed by tabId with the MFA window for awaiting_mfa", () => {
    const created = new Map<string, { when?: number }>();
    const alarms: AlarmsApi = {
      onAlarm: { addListener: vi.fn() },
      create: vi.fn((name: string, info: { when?: number }) => {
        created.set(name, info);
      }),
      clear: vi.fn(),
    };
    const ctx: FlowContext = {
      tabId: 7,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "awaiting_mfa",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const before = Date.now();
    scheduleFlowTimeout(alarms, ctx);

    const info = created.get("flowTimeout:7");
    expect(info).toBeDefined();
    const when = info?.when ?? 0;
    expect(when - before).toBeGreaterThanOrEqual(MFA_TIMEOUT_MS - 1000);
    expect(when - before).toBeLessThanOrEqual(MFA_TIMEOUT_MS + 1000);
  });

  it("uses the default window for non-MFA steps", () => {
    const created = new Map<string, { when?: number }>();
    const alarms: AlarmsApi = {
      onAlarm: { addListener: vi.fn() },
      create: vi.fn((name: string, info: { when?: number }) => {
        created.set(name, info);
      }),
      clear: vi.fn(),
    };
    const ctx: FlowContext = {
      tabId: 3,
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      step: "routing",
      startedAt: new Date().toISOString(),
      mfaRetryCount: 0,
    };

    const before = Date.now();
    scheduleFlowTimeout(alarms, ctx);

    const info = created.get("flowTimeout:3");
    expect(info).toBeDefined();
    const when = info?.when ?? 0;
    expect(when - before).toBeGreaterThanOrEqual(DOM_TIMEOUT_MS - 1000);
    expect(when - before).toBeLessThanOrEqual(DOM_TIMEOUT_MS + 1000);
  });
});
