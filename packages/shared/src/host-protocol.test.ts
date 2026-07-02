import { describe, it, expect } from "vitest";
import {
  HOST_REQUEST_TYPES,
  HOST_RESPONSE_TYPES,
  hasRequestId,
  isHostRequestType,
  isHostResponseType,
  isHostRequest,
  isHostResponse,
  isFolderSummary,
  type HostRequest,
  type HostResponse,
} from "./host-protocol.js";

// --- Compile-time enforcement: every request/response carries requestId: string ---
// design.md「全要求・応答は requestId を持ち、SW 側で demux する（C-5）」。
// これらは tsc（npm run typecheck）でのみ評価される。requestId が外れると型エラーになる。
type Assert<T extends true> = T;
type _RequestsCarryRequestId = Assert<
  HostRequest extends { requestId: string } ? true : false
>;
type _ResponsesCarryRequestId = Assert<
  HostResponse extends { requestId: string } ? true : false
>;
// 型パラメータの利用を確定させ、未使用扱いを避ける。
export type __TypeLevelChecks = [
  _RequestsCarryRequestId,
  _ResponsesCarryRequestId,
];

describe("protocol type catalogs", () => {
  it("declares every design.md HostRequest type", () => {
    expect([...HOST_REQUEST_TYPES]).toEqual([
      "unlock",
      "lock",
      "status",
      "configure",
      "listFolders",
      "listItems",
      "getItem",
      "getTotp",
    ]);
  });

  it("declares every design.md HostResponse type", () => {
    expect([...HOST_RESPONSE_TYPES]).toEqual([
      "unlocked",
      "locked",
      "configured",
      "status",
      "folders",
      "items",
      "item",
      "totp",
      "error",
    ]);
  });
});

describe("hasRequestId (requestId contract enforcement, C-5)", () => {
  it("accepts objects with a string requestId", () => {
    expect(hasRequestId({ requestId: "r1", type: "lock" })).toBe(true);
  });

  it("rejects objects missing requestId or with a non-string requestId", () => {
    expect(hasRequestId({ type: "lock" })).toBe(false);
    expect(hasRequestId({ requestId: 42, type: "lock" })).toBe(false);
    expect(hasRequestId(null)).toBe(false);
    expect(hasRequestId("lock")).toBe(false);
  });
});

describe("isHostRequestType / isHostResponseType", () => {
  it("validate membership at runtime", () => {
    expect(isHostRequestType("getTotp")).toBe(true);
    expect(isHostRequestType("nope")).toBe(false);
    expect(isHostResponseType("totp")).toBe(true);
    expect(isHostResponseType("nope")).toBe(false);
  });
});

describe("isHostRequest", () => {
  it("requires a requestId on every request variant", () => {
    // 全 8 種別が requestId 無しでは拒否される（型・実行時の双方で強制）。
    for (const type of HOST_REQUEST_TYPES) {
      expect(isHostRequest({ type })).toBe(false);
    }
  });

  it("accepts nullary requests with a requestId", () => {
    expect(isHostRequest({ requestId: "r", type: "lock" })).toBe(true);
    expect(isHostRequest({ requestId: "r", type: "status" })).toBe(true);
    expect(isHostRequest({ requestId: "r", type: "listFolders" })).toBe(true);
  });

  it("accepts unlock with a string masterPassword (transient)", () => {
    expect(
      isHostRequest({ requestId: "r", type: "unlock", masterPassword: "pw" }),
    ).toBe(true);
    expect(isHostRequest({ requestId: "r", type: "unlock" })).toBe(false);
  });

  it("accepts configure with numeric settings", () => {
    expect(
      isHostRequest({
        requestId: "r",
        type: "configure",
        idleLockMinutes: 20,
        totpMinRemainingSeconds: 5,
      }),
    ).toBe(true);
    expect(
      isHostRequest({ requestId: "r", type: "configure", idleLockMinutes: 20 }),
    ).toBe(false);
  });

  it("accepts listItems / getItem / getTotp with their string keys", () => {
    expect(
      isHostRequest({ requestId: "r", type: "listItems", folderId: "f" }),
    ).toBe(true);
    expect(isHostRequest({ requestId: "r", type: "getItem", uuid: "u" })).toBe(true);
    expect(isHostRequest({ requestId: "r", type: "getTotp", uuid: "u" })).toBe(true);
    expect(isHostRequest({ requestId: "r", type: "getItem" })).toBe(false);
  });

  it("rejects unknown request types", () => {
    expect(isHostRequest({ requestId: "r", type: "sudo" })).toBe(false);
  });
});

describe("isHostResponse", () => {
  it("requires a requestId on every response variant", () => {
    expect(isHostResponse({ type: "unlocked" })).toBe(false);
  });

  it("accepts nullary responses with a requestId", () => {
    expect(isHostResponse({ requestId: "r", type: "unlocked" })).toBe(true);
    expect(isHostResponse({ requestId: "r", type: "locked" })).toBe(true);
    expect(isHostResponse({ requestId: "r", type: "configured" })).toBe(true);
  });

  it("accepts status with unlocked:boolean and lastUsedAt:string", () => {
    expect(
      isHostResponse({
        requestId: "r",
        type: "status",
        unlocked: true,
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isHostResponse({ requestId: "r", type: "status", unlocked: true }),
    ).toBe(false);
  });

  it("accepts folders with an array of {id,name}", () => {
    expect(
      isHostResponse({
        requestId: "r",
        type: "folders",
        folders: [{ id: "f1", name: "AWS Accounts" }],
      }),
    ).toBe(true);
    expect(
      isHostResponse({
        requestId: "r",
        type: "folders",
        folders: [{ id: "f1" }],
      }),
    ).toBe(false);
  });

  it("accepts items with an array of AccountMeta", () => {
    expect(
      isHostResponse({
        requestId: "r",
        type: "items",
        items: [
          {
            uuid: "u",
            accountId: "123456789012",
            username: "alice",
            mfaEnabled: false,
          },
        ],
      }),
    ).toBe(true);
    expect(
      isHostResponse({ requestId: "r", type: "items", items: [{ uuid: "u" }] }),
    ).toBe(false);
  });

  it("accepts item with username+password (transient) and never a totp seed", () => {
    expect(
      isHostResponse({
        requestId: "r",
        type: "item",
        username: "alice",
        password: "secret",
      }),
    ).toBe(true);
    expect(
      isHostResponse({ requestId: "r", type: "item", username: "alice" }),
    ).toBe(false);
  });

  it("accepts totp with code+remainingSeconds", () => {
    expect(
      isHostResponse({
        requestId: "r",
        type: "totp",
        code: "123456",
        remainingSeconds: 25,
      }),
    ).toBe(true);
  });

  it("accepts error carrying a FlowError", () => {
    expect(
      isHostResponse({
        requestId: "r",
        type: "error",
        error: {
          category: "precondition",
          code: "vault_locked",
          message: "locked",
          retriable: false,
        },
      }),
    ).toBe(true);
    expect(
      isHostResponse({
        requestId: "r",
        type: "error",
        error: { category: "precondition", code: "nope" },
      }),
    ).toBe(false);
  });

  it("rejects unknown response types", () => {
    expect(isHostResponse({ requestId: "r", type: "granted" })).toBe(false);
  });
});

describe("isFolderSummary", () => {
  it("accepts {id,name} string pairs", () => {
    expect(isFolderSummary({ id: "f", name: "AWS Accounts" })).toBe(true);
  });
  it("rejects malformed shapes", () => {
    expect(isFolderSummary({ id: "f" })).toBe(false);
    expect(isFolderSummary({ id: 1, name: "n" })).toBe(false);
    expect(isFolderSummary(null)).toBe(false);
  });
});
