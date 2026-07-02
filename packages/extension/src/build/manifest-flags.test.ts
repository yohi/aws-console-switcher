import { describe, it, expect } from "vitest";
import {
  isTruthyFlag,
  resolveBuildFlags,
  resolveExtensionKey,
} from "./manifest-flags.js";

describe("isTruthyFlag", () => {
  it("treats 1/true/yes/on (any case, trimmed) as truthy", () => {
    for (const value of ["1", "true", "TRUE", "Yes", " on "]) {
      expect(isTruthyFlag(value)).toBe(true);
    }
  });

  it("treats undefined / empty / other values as falsy", () => {
    expect(isTruthyFlag(undefined)).toBe(false);
    expect(isTruthyFlag("")).toBe(false);
    expect(isTruthyFlag("0")).toBe(false);
    expect(isTruthyFlag("false")).toBe(false);
    expect(isTruthyFlag("nope")).toBe(false);
  });
});

describe("resolveBuildFlags — bw serve (localhost:8087) exclusion (§4.1, 9.2)", () => {
  it("excludes bw serve in production regardless of the env flag", () => {
    expect(resolveBuildFlags({ mode: "production" }).includeBwServe).toBe(false);
    expect(
      resolveBuildFlags({ mode: "production", env: { ACS_BW_SERVE: "1" } })
        .includeBwServe,
    ).toBe(false);
  });

  it("excludes bw serve by default in development (opt-in only)", () => {
    expect(resolveBuildFlags({ mode: "development" }).includeBwServe).toBe(false);
  });

  it("includes bw serve in development only when explicitly enabled", () => {
    expect(
      resolveBuildFlags({ mode: "development", env: { ACS_BW_SERVE: "1" } })
        .includeBwServe,
    ).toBe(true);
    expect(
      resolveBuildFlags({ mode: "development", env: { ACS_BW_SERVE: "0" } })
        .includeBwServe,
    ).toBe(false);
  });

  it("reports isProduction and echoes the mode", () => {
    const prod = resolveBuildFlags({ mode: "production" });
    expect(prod.isProduction).toBe(true);
    expect(prod.mode).toBe("production");
    const dev = resolveBuildFlags({ mode: "development" });
    expect(dev.isProduction).toBe(false);
  });
});

describe("resolveExtensionKey — extension ID pinning (manifest key field, m-7)", () => {
  it("returns the trimmed key when ACS_EXTENSION_KEY is set", () => {
    expect(resolveExtensionKey({ ACS_EXTENSION_KEY: "  MIIBpinnedKey  " })).toBe(
      "MIIBpinnedKey",
    );
  });

  it("returns undefined when unset or blank (store-assigned ID in production)", () => {
    expect(resolveExtensionKey({})).toBeUndefined();
    expect(resolveExtensionKey({ ACS_EXTENSION_KEY: "" })).toBeUndefined();
    expect(resolveExtensionKey({ ACS_EXTENSION_KEY: "   " })).toBeUndefined();
  });
});
