import { describe, expect, it } from "vitest";
import { err, isHostResponse, ok, type FlowError, type HostRequest, type HostResponse, type Result } from "@acs/shared";
import { createHostDispatcher, handleIncomingMessage } from "./dispatcher.js";
import { createSessionManager } from "./session.js";
import type { BwCli } from "./bw-cli.js";

const FIXED_NOW = new Date("2026-07-03T01:02:03.004Z");

function makeFakeBwCli(unlockResult: Result<string, FlowError> = ok("bw-session-token")): BwCli {
  return {
    unlock: async () => unlockResult,
    lock: async () => ok(""),
    status: async () => ok("{\"status\":\"unlocked\"}"),
    listFolders: async () => ok("[]"),
    listItems: async () => ok("[]"),
    getItem: async () => ok("{\"login\":{\"username\":\"user\",\"password\":\"pass\"}}"),
    getTotp: async () => ok("123456"),
  };
}

function makeFlowErrorForTest(code: "bad_password" | "vault_locked"): FlowError {
  return {
    category: "precondition",
    code,
    message: "Bitwarden vault could not be unlocked.",
    retriable: false,
  };
}

describe("handleRequest", () => {
  it("echoes requestId on every typed HostRequest route", async () => {
    // Given: one request for each route the host dispatcher owns.
    const requests: readonly HostRequest[] = [
      { requestId: "r-unlock", type: "unlock", masterPassword: "transient-secret" },
      { requestId: "r-lock", type: "lock" },
      { requestId: "r-status", type: "status" },
      {
        requestId: "r-configure",
        type: "configure",
        idleLockMinutes: 20,
        totpMinRemainingSeconds: 5,
      },
      { requestId: "r-folders", type: "listFolders" },
      { requestId: "r-items", type: "listItems", folderId: "folder-1" },
      { requestId: "r-item", type: "getItem", uuid: "item-1" },
      { requestId: "r-totp", type: "getTotp", uuid: "item-1" },
    ];

    // When: each request is dispatched.
    const dispatcher = createHostDispatcher({
      bwCli: makeFakeBwCli(),
      session: createSessionManager(() => FIXED_NOW),
    });
    const responses = await Promise.all(
      requests.map((request) => dispatcher.handleRequest(request)),
    );

    // Then: each response is contract-valid and retains its originating requestId.
    expect(responses.map((response) => response.requestId)).toEqual(
      requests.map((request) => request.requestId),
    );
    expect(responses.every(isHostResponse)).toBe(true);
  });

  it("routes configure without touching vault state", async () => {
    // Given: a configure request that does not require Bitwarden access.
    const cases: readonly { readonly request: HostRequest; readonly expected: HostResponse }[] = [
      {
        request: {
          requestId: "r-configure",
          type: "configure",
          idleLockMinutes: 20,
          totpMinRemainingSeconds: 5,
        },
        expected: { requestId: "r-configure", type: "configured" },
      },
    ];

    const dispatcher = createHostDispatcher({
      bwCli: makeFakeBwCli(),
      session: createSessionManager(() => FIXED_NOW),
    });

    // When/Then: the dispatcher returns the route-specific response.
    for (const { request, expected } of cases) {
      await expect(dispatcher.handleRequest(request)).resolves.toEqual(expected);
    }
  });

  it("stores configure settings in the native host process", async () => {
    // Given: a dispatcher with a process-local session manager.
    const session = createSessionManager(() => FIXED_NOW);
    const dispatcher = createHostDispatcher({
      bwCli: makeFakeBwCli(),
      session,
    });

    // When: configure is requested with non-default settings.
    const response = await dispatcher.handleRequest({
      requestId: "r-configure",
      type: "configure",
      idleLockMinutes: 7,
      totpMinRemainingSeconds: 9,
    });

    // Then: settings are retained for later host-side behavior.
    expect(response).toEqual({ requestId: "r-configure", type: "configured" });
    expect(session.settings()).toEqual({
      idleLockMinutes: 7,
      totpMinRemainingSeconds: 9,
    });
  });

  it("rejects configure values outside supported ranges", async () => {
    // Given: invalid configure messages for each setting boundary.
    const requests: readonly HostRequest[] = [
      {
        requestId: "r-idle-low",
        type: "configure",
        idleLockMinutes: 0,
        totpMinRemainingSeconds: 5,
      },
      {
        requestId: "r-idle-high",
        type: "configure",
        idleLockMinutes: 121,
        totpMinRemainingSeconds: 5,
      },
      {
        requestId: "r-idle-fraction",
        type: "configure",
        idleLockMinutes: 1.5,
        totpMinRemainingSeconds: 5,
      },
      {
        requestId: "r-totp-low",
        type: "configure",
        idleLockMinutes: 20,
        totpMinRemainingSeconds: 4,
      },
      {
        requestId: "r-totp-high",
        type: "configure",
        idleLockMinutes: 20,
        totpMinRemainingSeconds: 11,
      },
    ];
    const dispatcher = createHostDispatcher({
      bwCli: makeFakeBwCli(),
      session: createSessionManager(() => FIXED_NOW),
    });

    // When: each invalid request is dispatched.
    const responses = await Promise.all(
      requests.map((request) => dispatcher.handleRequest(request)),
    );

    // Then: each invalid configure is rejected as a typed precondition error.
    expect(responses).toHaveLength(requests.length);
    for (const response of responses) {
      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.code).toBe("invalid_configuration");
      }
    }
  });

  it("updates lastUsedAt on every incoming request", async () => {
    // Given: a dispatcher with a clock that advances per request.
    const firstRequestAt = new Date("2026-07-03T01:00:00.000Z");
    const secondRequestAt = new Date("2026-07-03T01:01:00.000Z");
    let timestampIndex = 0;
    const session = createSessionManager(() => {
      const timestamp = timestampIndex === 0 ? firstRequestAt : secondRequestAt;
      timestampIndex += 1;
      return timestamp;
    });
    const dispatcher = createHostDispatcher({ bwCli: makeFakeBwCli(), session });

    // When: a configure request is followed by a status request.
    await dispatcher.handleRequest({
      requestId: "r-configure",
      type: "configure",
      idleLockMinutes: 20,
      totpMinRemainingSeconds: 5,
    });
    const response = await dispatcher.handleRequest({ requestId: "r-status", type: "status" });

    // Then: even non-vault requests move the last-used timestamp forward.
    expect(response).toEqual({
      requestId: "r-status",
      type: "status",
      unlocked: false,
      lastUsedAt: "2026-07-03T01:01:00.000Z",
    });
  });

  it("stores BW_SESSION on successful unlock and reports unlocked status", async () => {
    // Given: a dispatcher backed by a successful bw unlock result.
    const session = createSessionManager(() => FIXED_NOW);
    const dispatcher = createHostDispatcher({ bwCli: makeFakeBwCli(), session });

    // When: unlock succeeds and status is requested.
    const unlockResponse = await dispatcher.handleRequest({
      requestId: "r-unlock",
      type: "unlock",
      masterPassword: "transient-secret",
    });
    const statusResponse = await dispatcher.handleRequest({ requestId: "r-status", type: "status" });

    // Then: BW_SESSION stays in the session manager and is never returned to the caller.
    expect(unlockResponse).toEqual({ requestId: "r-unlock", type: "unlocked" });
    expect(statusResponse).toEqual({
      requestId: "r-status",
      type: "status",
      unlocked: true,
      lastUsedAt: "2026-07-03T01:02:03.004Z",
    });
    expect(JSON.stringify(unlockResponse)).not.toContain("bw-session-token");
  });

  it("returns a sanitized typed error when unlock fails", async () => {
    // Given: a dispatcher whose bw unlock rejects the master password.
    const secret = "wrong-master-password";
    const unlockError = makeFlowErrorForTest("bad_password");
    const dispatcher = createHostDispatcher({
      bwCli: makeFakeBwCli(err(unlockError)),
      session: createSessionManager(() => FIXED_NOW),
    });

    // When: unlock is requested.
    const response = await dispatcher.handleRequest({
      requestId: "r-unlock",
      type: "unlock",
      masterPassword: secret,
    });

    // Then: the error is typed and contains no master password.
    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error).toEqual(unlockError);
      expect(JSON.stringify(response.error)).not.toContain(secret);
    }
  });

  it("clears BW_SESSION on lock and reports locked status", async () => {
    // Given: an unlocked dispatcher session.
    const session = createSessionManager(() => FIXED_NOW);
    const dispatcher = createHostDispatcher({ bwCli: makeFakeBwCli(), session });
    await dispatcher.handleRequest({
      requestId: "r-unlock",
      type: "unlock",
      masterPassword: "transient-secret",
    });

    // When: lock is requested and status is requested afterwards.
    const lockResponse = await dispatcher.handleRequest({ requestId: "r-lock", type: "lock" });
    const statusResponse = await dispatcher.handleRequest({ requestId: "r-status", type: "status" });

    // Then: the process no longer holds BW_SESSION.
    expect(lockResponse).toEqual({ requestId: "r-lock", type: "locked" });
    expect(session.currentSession()).toBeUndefined();
    expect(statusResponse).toEqual({
      requestId: "r-status",
      type: "status",
      unlocked: false,
      lastUsedAt: "2026-07-03T01:02:03.004Z",
    });
  });
});

describe("handleIncomingMessage", () => {
  it("echoes requestId when converting an unknown request type to a typed error response", async () => {
    // Given: a boundary value with a requestId but an unsupported type.
    const message = { requestId: "r-unknown", type: "sudo" };

    // When: the untrusted input is handled.
    const response = await handleIncomingMessage(message);

    // Then: the host returns a contract-valid FlowError response for the same requestId.
    expect(response.requestId).toBe("r-unknown");
    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error.category).toBe("precondition");
      expect(response.error.code).toBe("malformed_request");
    }
  });

  it("returns a typed malformed-input error when requestId is missing", async () => {
    // Given: a boundary value that is not a valid HostRequest.
    const message = { type: "status" };

    // When: the untrusted input is handled.
    const response = await handleIncomingMessage(message);

    // Then: malformed input is surfaced as a FlowError response without throwing.
    expect(response).toEqual({
      requestId: "unknown",
      type: "error",
      error: {
        category: "precondition",
        code: "malformed_request",
        message: "Malformed Native Messaging request.",
        retriable: false,
      },
    });
  });
});
