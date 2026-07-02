import { describe, it, expect } from "vitest";
import {
  SIGNIN_DOM_EVENTS,
  isSigninDomEvent,
  isExtMessage,
} from "./ext-message.js";

describe("SIGNIN_DOM_EVENTS", () => {
  it("declares the five design.md signin DOM events", () => {
    expect([...SIGNIN_DOM_EVENTS]).toEqual([
      "accountIdFieldShown",
      "credentialFieldShown",
      "mfaScreenShown",
      "authError",
      "domTimeout",
    ]);
  });

  it("excludes consoleRedirect (detected by SW tabs.onUpdated, C-2)", () => {
    expect((SIGNIN_DOM_EVENTS as readonly string[]).includes("consoleRedirect")).toBe(
      false,
    );
  });
});

describe("isSigninDomEvent", () => {
  it("accepts every declared event", () => {
    for (const event of SIGNIN_DOM_EVENTS) {
      expect(isSigninDomEvent(event)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isSigninDomEvent("consoleRedirect")).toBe(false);
    expect(isSigninDomEvent(42)).toBe(false);
    expect(isSigninDomEvent(null)).toBe(false);
  });
});

describe("isExtMessage — nullary kinds", () => {
  it("accepts listAccounts / lock / syncAccounts", () => {
    expect(isExtMessage({ kind: "listAccounts" })).toBe(true);
    expect(isExtMessage({ kind: "lock" })).toBe(true);
    expect(isExtMessage({ kind: "syncAccounts" })).toBe(true);
  });
});

describe("isExtMessage — uuid-carrying kinds", () => {
  it("accepts startLogin / cancelLogin / retryLogin with a string uuid", () => {
    expect(isExtMessage({ kind: "startLogin", uuid: "u" })).toBe(true);
    expect(isExtMessage({ kind: "cancelLogin", uuid: "u" })).toBe(true);
    expect(isExtMessage({ kind: "retryLogin", uuid: "u" })).toBe(true);
  });

  it("rejects when uuid is missing or not a string", () => {
    expect(isExtMessage({ kind: "startLogin" })).toBe(false);
    expect(isExtMessage({ kind: "startLogin", uuid: 1 })).toBe(false);
  });
});

describe("isExtMessage — unlock (transient secret)", () => {
  it("accepts unlock with a string masterPassword", () => {
    expect(isExtMessage({ kind: "unlock", masterPassword: "pw" })).toBe(true);
  });

  it("rejects unlock without masterPassword", () => {
    expect(isExtMessage({ kind: "unlock" })).toBe(false);
    expect(isExtMessage({ kind: "unlock", masterPassword: 123 })).toBe(false);
  });
});

describe("isExtMessage — signinDomEvent", () => {
  it("accepts a fully-formed signinDomEvent (uuid always present, C-1)", () => {
    expect(
      isExtMessage({
        kind: "signinDomEvent",
        tabId: 3,
        uuid: "u",
        event: "mfaScreenShown",
      }),
    ).toBe(true);
  });

  it("rejects invalid event, missing uuid, or non-numeric tabId", () => {
    expect(
      isExtMessage({ kind: "signinDomEvent", tabId: 3, uuid: "u", event: "nope" }),
    ).toBe(false);
    expect(
      isExtMessage({ kind: "signinDomEvent", tabId: 3, event: "authError" }),
    ).toBe(false);
    expect(
      isExtMessage({
        kind: "signinDomEvent",
        tabId: "3",
        uuid: "u",
        event: "authError",
      }),
    ).toBe(false);
  });
});

describe("isExtMessage — consoleState", () => {
  it("accepts with and without the optional accountId", () => {
    expect(isExtMessage({ kind: "consoleState", tabId: 3 })).toBe(true);
    expect(isExtMessage({ kind: "consoleState", tabId: 3, accountId: "123" })).toBe(
      true,
    );
  });

  it("rejects a present-but-non-string accountId", () => {
    expect(isExtMessage({ kind: "consoleState", tabId: 3, accountId: 123 })).toBe(
      false,
    );
    expect(
      isExtMessage({ kind: "consoleState", tabId: 3, accountId: undefined }),
    ).toBe(false);
  });
});

describe("isExtMessage — rejects junk", () => {
  it("rejects unknown kinds and non-objects", () => {
    expect(isExtMessage({ kind: "nope" })).toBe(false);
    expect(isExtMessage({})).toBe(false);
    expect(isExtMessage(null)).toBe(false);
    expect(isExtMessage(undefined)).toBe(false);
    expect(isExtMessage("startLogin")).toBe(false);
  });
});
