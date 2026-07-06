/**
 * 構造化失敗ログ `logFlowError` のユニットテスト（task 9.1, design.md「Monitoring」）。
 *
 * 主眼は秘匿境界の検証: 出力に `message` を含めず、`{ category, code, retriable }` と
 * 明示 `context` のみを記録すること。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFlowError } from "@acs/shared";
import { FLOW_ERROR_LOG_LABEL, logFlowError } from "./error-logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logFlowError", () => {
  it("records category, code, and retriable as a structured record", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFlowError(makeFlowError("host_disconnected", "port closed"));

    expect(spy).toHaveBeenCalledTimes(1);
    const [label, record] = spy.mock.calls[0] ?? [];
    expect(label).toBe(FLOW_ERROR_LOG_LABEL);
    expect(record).toEqual({
      kind: "flow_error",
      category: "precondition",
      code: "host_disconnected",
      retriable: false,
    });
  });

  it("never emits the FlowError message (secret-leakage guard)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFlowError(makeFlowError("bad_password", "super-secret-detail"));

    const [, record] = spy.mock.calls[0] ?? [];
    expect(record).not.toHaveProperty("message");
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain("super-secret-detail");
  });

  it("includes the non-secret context when provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFlowError(makeFlowError("totp_rejected", "reused"), {
      messageKind: "signinDomEvent",
      tabId: 42,
    });

    const [, record] = spy.mock.calls[0] ?? [];
    expect(record).toMatchObject({
      kind: "flow_error",
      code: "totp_rejected",
      retriable: true,
      context: { messageKind: "signinDomEvent", tabId: 42 },
    });
  });

  it("omits the context key entirely when not provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logFlowError(makeFlowError("vault_locked", "locked"));

    const [, record] = spy.mock.calls[0] ?? [];
    expect(record).not.toHaveProperty("context");
  });
});
