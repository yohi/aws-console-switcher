import { describe, it, expect } from "vitest";
import {
  generateRequestId,
  isValidRequestId,
  isCanonicalUuidV4,
} from "./request-id.js";

describe("generateRequestId", () => {
  it("produces a canonical UUID v4 string (design: crypto.randomUUID())", () => {
    expect(isCanonicalUuidV4(generateRequestId())).toBe(true);
  });

  it("produces a value accepted by isValidRequestId", () => {
    expect(isValidRequestId(generateRequestId())).toBe(true);
  });

  it("produces distinct values across many calls (collision avoidance, C-5)", () => {
    const ids = new Set(
      Array.from({ length: 1000 }, () => generateRequestId()),
    );
    expect(ids.size).toBe(1000);
  });
});

describe("isValidRequestId", () => {
  it("accepts any non-empty string (matches the requestId: string contract)", () => {
    expect(isValidRequestId("abc")).toBe(true);
    expect(isValidRequestId(generateRequestId())).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isValidRequestId("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId(123)).toBe(false);
    expect(isValidRequestId({})).toBe(false);
    expect(isValidRequestId(["x"])).toBe(false);
  });
});

describe("isCanonicalUuidV4", () => {
  it("accepts canonical v4 UUIDs (case-insensitive)", () => {
    expect(isCanonicalUuidV4("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isCanonicalUuidV4("123E4567-E89B-42D3-A456-426614174000")).toBe(true);
  });

  it("rejects malformed or non-v4 UUIDs", () => {
    expect(isCanonicalUuidV4("not-a-uuid")).toBe(false);
    // no dashes
    expect(isCanonicalUuidV4("123e4567e89b42d3a456426614174000")).toBe(false);
    // version nibble is 3, not 4
    expect(isCanonicalUuidV4("123e4567-e89b-32d3-a456-426614174000")).toBe(false);
    // variant nibble is 7 (not 8/9/a/b)
    expect(isCanonicalUuidV4("123e4567-e89b-42d3-7456-426614174000")).toBe(false);
    expect(isCanonicalUuidV4("")).toBe(false);
    expect(isCanonicalUuidV4(42)).toBe(false);
    expect(isCanonicalUuidV4(null)).toBe(false);
  });
});
