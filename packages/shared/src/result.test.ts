import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  unwrapOr,
  andThen,
  type Result,
} from "./result.js";

describe("ok / err constructors", () => {
  it("ok() wraps a value in a success result", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
    }
  });

  it("err() wraps an error in a failure result", () => {
    const r = err("boom");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("boom");
    }
  });
});

describe("isOk / isErr", () => {
  it("isOk is true only for success results", () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err("e");
    expect(isOk(success)).toBe(true);
    expect(isOk(failure)).toBe(false);
  });

  it("isErr is true only for failure results", () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err("e");
    expect(isErr(failure)).toBe(true);
    expect(isErr(success)).toBe(false);
  });
});

describe("map", () => {
  it("transforms the success value", () => {
    const r: Result<number, string> = ok(2);
    expect(map(r, (n) => n * 3)).toEqual(ok(6));
  });

  it("leaves a failure untouched", () => {
    const r: Result<number, string> = err("e");
    expect(map(r, (n) => n * 3)).toEqual(err("e"));
  });
});

describe("mapErr", () => {
  it("transforms the error value", () => {
    const r: Result<number, string> = err("e");
    expect(mapErr(r, (s) => s.toUpperCase())).toEqual(err("E"));
  });

  it("leaves a success untouched", () => {
    const r: Result<number, string> = ok(2);
    expect(mapErr(r, (s) => s.toUpperCase())).toEqual(ok(2));
  });
});

describe("unwrapOr", () => {
  it("returns the value on success", () => {
    const r: Result<number, string> = ok(5);
    expect(unwrapOr(r, 0)).toBe(5);
  });

  it("returns the fallback on failure", () => {
    const r: Result<number, string> = err("e");
    expect(unwrapOr(r, 0)).toBe(0);
  });
});

describe("andThen", () => {
  const parse = (s: string): Result<number, string> =>
    Number.isNaN(Number(s)) ? err("nan") : ok(Number(s));

  it("chains a fallible operation when the input succeeds", () => {
    const r: Result<string, string> = ok("3");
    expect(andThen(r, parse)).toEqual(ok(3));
  });

  it("propagates the inner failure", () => {
    const r: Result<string, string> = ok("x");
    expect(andThen(r, parse)).toEqual(err("nan"));
  });

  it("short-circuits when the input already failed", () => {
    const r: Result<string, string> = err("prior");
    expect(andThen(r, parse)).toEqual(err("prior"));
  });
});
