import { describe, it, expect } from "vitest";
import {
  FAILURE_CATEGORIES,
  FLOW_ERROR_CODES,
  categoryForCode,
  isRetriableByDefault,
  makeFlowError,
  isFlowError,
  isFailureCategory,
  isFlowErrorCode,
  isTrueObjectMissing,
  isTransientPreconditionError,
  type FlowError,
} from "./flow-error.js";

describe("category / code catalogs", () => {
  it("declares exactly the three §3.5 failure categories", () => {
    expect([...FAILURE_CATEGORIES]).toEqual([
      "precondition",
      "aws_auth",
      "dom_timeout",
    ]);
  });

  it("declares the twelve design.md FlowErrorCode values", () => {
    expect([...FLOW_ERROR_CODES]).toEqual([
      "host_not_running",
      "host_disconnected",
      "bw_not_logged_in",
      "vault_locked",
      "item_not_found",
      "invalid_uuid",
      "bad_password",
      "account_locked",
      "totp_rejected",
      "selector_not_found",
      "page_not_rendered",
      "captcha_detected",
    ]);
  });
});

describe("categoryForCode", () => {
  it("maps host / vault / object-missing errors to precondition", () => {
    for (const code of [
      "host_not_running",
      "host_disconnected",
      "bw_not_logged_in",
      "vault_locked",
      "item_not_found",
      "invalid_uuid",
    ] as const) {
      expect(categoryForCode(code)).toBe("precondition");
    }
  });

  it("maps credential / TOTP errors to aws_auth", () => {
    for (const code of ["bad_password", "account_locked", "totp_rejected"] as const) {
      expect(categoryForCode(code)).toBe("aws_auth");
    }
  });

  it("maps selector / render / captcha errors to dom_timeout", () => {
    for (const code of [
      "selector_not_found",
      "page_not_rendered",
      "captcha_detected",
    ] as const) {
      expect(categoryForCode(code)).toBe("dom_timeout");
    }
  });

  it("assigns one of the declared categories to every declared code", () => {
    for (const code of FLOW_ERROR_CODES) {
      expect(FAILURE_CATEGORIES).toContain(categoryForCode(code));
    }
  });
});

describe("isRetriableByDefault", () => {
  it("marks only totp_rejected as auto-retriable by default", () => {
    expect(isRetriableByDefault("totp_rejected")).toBe(true);
    for (const code of FLOW_ERROR_CODES) {
      if (code !== "totp_rejected") {
        expect(isRetriableByDefault(code)).toBe(false);
      }
    }
  });
});

describe("makeFlowError", () => {
  it("derives category and default retriable from the code", () => {
    expect(makeFlowError("vault_locked", "Vault is locked")).toEqual({
      category: "precondition",
      code: "vault_locked",
      message: "Vault is locked",
      retriable: false,
    });
    expect(makeFlowError("totp_rejected", "TOTP rejected")).toEqual({
      category: "aws_auth",
      code: "totp_rejected",
      message: "TOTP rejected",
      retriable: true,
    });
  });

  it("allows overriding the retriable flag", () => {
    const e = makeFlowError("totp_rejected", "retry limit reached", {
      retriable: false,
    });
    expect(e.retriable).toBe(false);
  });
});

describe("isFlowError", () => {
  it("accepts a well-formed FlowError", () => {
    const e: FlowError = makeFlowError("bad_password", "Wrong password");
    expect(isFlowError(e)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isFlowError(null)).toBe(false);
    expect(isFlowError(undefined)).toBe(false);
    expect(isFlowError("vault_locked")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(
      isFlowError({
        category: "precondition",
        code: "nope",
        message: "m",
        retriable: false,
      }),
    ).toBe(false);
    // missing retriable
    expect(
      isFlowError({ category: "precondition", code: "vault_locked", message: "m" }),
    ).toBe(false);
    // invalid category
    expect(
      isFlowError({
        category: "weird",
        code: "vault_locked",
        message: "m",
        retriable: false,
      }),
    ).toBe(false);
  });
});

describe("isFailureCategory / isFlowErrorCode", () => {
  it("validate membership at runtime", () => {
    expect(isFailureCategory("aws_auth")).toBe(true);
    expect(isFailureCategory("nope")).toBe(false);
    expect(isFailureCategory(42)).toBe(false);
    expect(isFlowErrorCode("totp_rejected")).toBe(true);
    expect(isFlowErrorCode("totp")).toBe(false);
    expect(isFlowErrorCode(42)).toBe(false);
  });
});

describe("UUID resync classification (§3.4 / S-3)", () => {
  it("treats only item_not_found / invalid_uuid as true object missing", () => {
    expect(isTrueObjectMissing("item_not_found")).toBe(true);
    expect(isTrueObjectMissing("invalid_uuid")).toBe(true);
    expect(isTrueObjectMissing("vault_locked")).toBe(false);
    expect(isTrueObjectMissing("host_not_running")).toBe(false);
  });

  it("treats host / vault / login errors as transient preconditions", () => {
    for (const code of [
      "vault_locked",
      "bw_not_logged_in",
      "host_not_running",
      "host_disconnected",
    ] as const) {
      expect(isTransientPreconditionError(code)).toBe(true);
    }
    expect(isTransientPreconditionError("item_not_found")).toBe(false);
    expect(isTransientPreconditionError("invalid_uuid")).toBe(false);
  });

  it("keeps true-object-missing and transient-precondition mutually exclusive", () => {
    for (const code of FLOW_ERROR_CODES) {
      expect(isTrueObjectMissing(code) && isTransientPreconditionError(code)).toBe(
        false,
      );
    }
  });
});
