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

  it("rejects a syntactically-string-but-malformed uuid", () => {
    expect(isAccountMeta({ ...base, uuid: "not-a-uuid" })).toBe(false);
    expect(isAccountMeta({ ...base, uuid: "" })).toBe(false);
    // ハイフン無し（16 進 32 文字だが区切りが無い）
    expect(
      isAccountMeta({ ...base, uuid: "b1f9c0de000040008000000000000001" }),
    ).toBe(false);
  });

  it("rejects a malformed accountId (not exactly 12 ASCII digits)", () => {
    expect(isAccountMeta({ ...base, accountId: "12345" })).toBe(false); // 桁不足
    expect(isAccountMeta({ ...base, accountId: "12345678901a" })).toBe(false); // 非数字混入
    expect(isAccountMeta({ ...base, accountId: "1234567890123" })).toBe(false); // 桁超過
  });

  it("rejects non-objects", () => {
    expect(isAccountMeta(null)).toBe(false);
    expect(isAccountMeta(undefined)).toBe(false);
    expect(isAccountMeta("uuid")).toBe(false);
    expect(isAccountMeta(42)).toBe(false);
  });
});
