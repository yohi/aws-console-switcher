import {
  err,
  makeFlowError,
  ok,
  type FlowError,
  type Result,
} from "@acs/shared";
import { describe, expect, it, vi } from "vitest";
import type { BwCli } from "./bw-cli.js";
import { createHostDispatcher } from "./dispatcher.js";
import { createSessionManager } from "./session.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const FOLDER_JSON = JSON.stringify([{ id: "folder-1", name: "AWS Accounts" }]);
const ITEM_JSON = JSON.stringify({
  id: UUID,
  login: {
    username: "iam-user",
    password: "secret-password",
    totp: "otpauth://totp/AWS?secret=SEED",
    uris: [{ uri: "https://123456789012.signin.aws.amazon.com/console" }],
  },
  fields: [
    { name: "aws_account_id", value: "123456789012" },
    { name: "aws_account_alias", value: "prod" },
  ],
});
const ITEMS_JSON = JSON.stringify([JSON.parse(ITEM_JSON)]);

type BwResults = {
  readonly listFolders?: Result<string, FlowError>;
  readonly listItems?: Result<string, FlowError>;
  readonly getItem?: Result<string, FlowError>;
  readonly getTotp?: Result<string, FlowError>;
};

function makeFakeBwCli(results: BwResults = {}): BwCli {
  return {
    unlock: async () => ok("bw-session-token"),
    lock: async () => ok(""),
    status: async () => ok("{\"status\":\"unlocked\"}"),
    listFolders: async () => results.listFolders ?? ok(FOLDER_JSON),
    listItems: async () => results.listItems ?? ok(ITEMS_JSON),
    getItem: async () => results.getItem ?? ok(ITEM_JSON),
    getTotp: async () => results.getTotp ?? ok("123456"),
  };
}

async function makeUnlockedDispatcher(results: BwResults = {}) {
  const session = createSessionManager(() => new Date("2026-07-03T01:02:03.004Z"));
  const dispatcher = createHostDispatcher({ bwCli: makeFakeBwCli(results), session });
  await dispatcher.handleRequest({
    requestId: "r-unlock",
    type: "unlock",
    masterPassword: "transient-secret",
  });
  return dispatcher;
}

describe("task 2.3 Bitwarden dispatcher handlers", () => {
  it("returns folder summaries when listFolders receives valid bw JSON", async () => {
    // Given: an unlocked dispatcher and bw folder JSON.
    const dispatcher = await makeUnlockedDispatcher();

    // When: folders are requested.
    const response = await dispatcher.handleRequest({ requestId: "r-folders", type: "listFolders" });

    // Then: only folder id and name are returned.
    expect(response).toEqual({
      requestId: "r-folders",
      type: "folders",
      folders: [{ id: "folder-1", name: "AWS Accounts" }],
    });
  });

  it("maps Bitwarden items to validated non-secret AccountMeta", async () => {
    // Given: bw item JSON containing credentials and a TOTP seed.
    const dispatcher = await makeUnlockedDispatcher();

    // When: items are requested for a folder.
    const response = await dispatcher.handleRequest({
      requestId: "r-items",
      type: "listItems",
      folderId: "folder-1",
    });

    // Then: the response contains only non-secret metadata.
    expect(response).toEqual({
      requestId: "r-items",
      type: "items",
      items: [
        {
          uuid: UUID,
          accountId: "123456789012",
          alias: "prod",
          username: "iam-user",
          signInUrl: "https://123456789012.signin.aws.amazon.com/console",
          mfaEnabled: true,
        },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("secret-password");
    expect(JSON.stringify(response)).not.toContain("SEED");
  });

  it("returns only username and password when getItem receives secret item JSON", async () => {
    // Given: bw item JSON contains login.totp.
    const dispatcher = await makeUnlockedDispatcher();

    // When: the item secret is requested.
    const response = await dispatcher.handleRequest({ requestId: "r-item", type: "getItem", uuid: UUID });

    // Then: TOTP seed is not leaked in the host response.
    expect(response).toEqual({
      requestId: "r-item",
      type: "item",
      username: "iam-user",
      password: "secret-password",
    });
    expect(JSON.stringify(response)).not.toContain("totp");
    expect(JSON.stringify(response)).not.toContain("SEED");
  });

  it("returns a 6-digit TOTP code with the computed remaining window", async () => {
    // Given: bw returns a plain text TOTP code.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:02:03.004Z"));
    const dispatcher = await makeUnlockedDispatcher({ getTotp: ok("654321\n") });

    try {
      // When: TOTP is requested.
      const response = await dispatcher.handleRequest({ requestId: "r-totp", type: "getTotp", uuid: UUID });

      // Then: the code is trimmed and remaining seconds are computed host-side.
      expect(response).toEqual({
        requestId: "r-totp",
        type: "totp",
        code: "654321",
        remainingSeconds: 27,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits in the native host and re-fetches TOTP when below the configured threshold", async () => {
    // Given: an unlocked dispatcher at two seconds before TOTP rotation.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(28_000));
    const getTotpCalls: string[] = [];
    const bwCli = makeFakeBwCli();
    const session = createSessionManager(() => new Date(Date.now()));
    const dispatcher = createHostDispatcher({
      bwCli: {
        ...bwCli,
        getTotp: async (uuid: string) => {
          const code = getTotpCalls.length === 0 ? "111111" : "222222";
          getTotpCalls.push(uuid);
          return ok(`${code}\n`);
        },
      },
      session,
    });

    try {
      await dispatcher.handleRequest({
        requestId: "r-unlock",
        type: "unlock",
        masterPassword: "transient-secret",
      });
      await dispatcher.handleRequest({
        requestId: "r-configure",
        type: "configure",
        idleLockMinutes: 20,
        totpMinRemainingSeconds: 5,
      });

      // When: TOTP is requested and the host-side wait crosses the next window.
      const responsePromise = dispatcher.handleRequest({ requestId: "r-totp", type: "getTotp", uuid: UUID });
      await vi.advanceTimersByTimeAsync(0);
      expect(getTotpCalls).toEqual([UUID]);
      await vi.advanceTimersByTimeAsync(3_000);
      const response = await responsePromise;

      // Then: the response contains a freshly fetched code from the next window.
      expect(response).toEqual({
        requestId: "r-totp",
        type: "totp",
        code: "222222",
        remainingSeconds: 29,
      });
      expect(getTotpCalls).toEqual([UUID, UUID]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a locked-vault FlowError from bw listFolders", async () => {
    // Given: bw reports a locked vault.
    const locked = makeFlowError("vault_locked", "Bitwarden vault is locked.");
    const dispatcher = await makeUnlockedDispatcher({ listFolders: err(locked) });

    // When: folders are requested.
    const response = await dispatcher.handleRequest({ requestId: "r-folders", type: "listFolders" });

    // Then: the typed precondition error is returned unchanged.
    expect(response).toEqual({ requestId: "r-folders", type: "error", error: locked });
  });

  it("propagates an item-not-found FlowError from bw getItem", async () => {
    // Given: bw reports that the target item disappeared.
    const missing = makeFlowError("item_not_found", "Bitwarden item was not found.");
    const dispatcher = await makeUnlockedDispatcher({ getItem: err(missing) });

    // When: the item is requested.
    const response = await dispatcher.handleRequest({ requestId: "r-item", type: "getItem", uuid: UUID });

    // Then: true object absence is preserved for callers.
    expect(response).toEqual({ requestId: "r-item", type: "error", error: missing });
  });

  it("returns host_not_running when bw returns malformed folder JSON", async () => {
    // Given: bw returns non-JSON output instead of folder data.
    const dispatcher = await makeUnlockedDispatcher({ listFolders: ok("not-json") });

    // When: folders are requested.
    const response = await dispatcher.handleRequest({ requestId: "r-folders", type: "listFolders" });

    // Then: malformed bw output is handled gracefully as a host-side precondition error.
    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error.code).toBe("host_not_running");
      expect(response.error.category).toBe("precondition");
    }
  });
});
