import { describe, it, expect } from "vitest";
import { isAccountMeta } from "./data-models.js";

const base = {
  uuid: "b1f9c0de-0000-4000-8000-000000000001",
  accountId: "123456789012",
  username: "alice",
  mfaEnabled: true,
};

describe("isAccountMeta", () => {
  it("accepts minimal valid non-secret metadata", () => {
    expect(isAccountMeta(base)).toBe(true);
  });

  it("accepts optional alias / signInUrl when they are strings", () => {
    expect(
      isAccountMeta({
        ...base,
        alias: "prod",
        signInUrl: "https://123456789012.signin.aws.amazon.com/console/",
      }),
    ).toBe(true);
  });

  it("rejects when a required field is missing or mistyped", () => {
    expect(isAccountMeta({ accountId: "1", username: "a", mfaEnabled: true })).toBe(
      false,
    );
    expect(isAccountMeta({ ...base, accountId: 123456789012 })).toBe(false);
    expect(isAccountMeta({ ...base, mfaEnabled: "yes" })).toBe(false);
  });

  it("rejects a present-but-wrong-typed optional field", () => {
    expect(isAccountMeta({ ...base, alias: 1 })).toBe(false);
    expect(isAccountMeta({ ...base, signInUrl: false })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isAccountMeta(null)).toBe(false);
    expect(isAccountMeta(undefined)).toBe(false);
    expect(isAccountMeta("uuid")).toBe(false);
    expect(isAccountMeta(42)).toBe(false);
  });
});
