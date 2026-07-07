import {
  err,
  makeFlowError,
  ok,
  type FlowError,
  type HostRequest,
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

describe("task 10.2 dispatcher integration (locked-vault preconditions)", () => {
  it("returns vault_locked for every secret operation before unlock", async () => {
    // Given: a dispatcher whose vault has never been unlocked.
    const session = createSessionManager(() => new Date("2026-07-03T01:02:03.004Z"));
    const dispatcher = createHostDispatcher({ bwCli: makeFakeBwCli(), session });

    // When: each vault-dependent request is dispatched without a held BW_SESSION.
    const requests: readonly HostRequest[] = [
      { requestId: "r-folders", type: "listFolders" },
      { requestId: "r-items", type: "listItems", folderId: "folder-1" },
      { requestId: "r-item", type: "getItem", uuid: UUID },
      { requestId: "r-totp", type: "getTotp", uuid: UUID },
    ];
    const responses = await Promise.all(
      requests.map((request) => dispatcher.handleRequest(request)),
    );

    // Then: each is rejected as a vault_locked precondition that still echoes its requestId.
    expect(responses.map((response) => response.requestId)).toEqual(
      requests.map((request) => request.requestId),
    );
    for (const response of responses) {
      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.error.category).toBe("precondition");
        expect(response.error.code).toBe("vault_locked");
      }
    }
  });
});

describe("task 10.2 dispatcher integration (unlock -> sync -> lock lifecycle)", () => {
  it("threads the resolved folder id through one unlocked session and reports status transitions", async () => {
    // Given: a fresh dispatcher frozen at a TOTP window with 27 seconds remaining.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:02:03.004Z"));
    try {
      const session = createSessionManager(() => new Date(Date.now()));
      const listItemsFolderIds: string[] = [];
      const bwCli: BwCli = {
        ...makeFakeBwCli(),
        listItems: async (folderId: string) => {
          listItemsFolderIds.push(folderId);
          return ok(ITEMS_JSON);
        },
      };
      const dispatcher = createHostDispatcher({ bwCli, session });

      // When: the full unlock -> initial-sync -> secret -> lock sequence runs on one dispatcher.
      const unlocked = await dispatcher.handleRequest({
        requestId: "r-unlock",
        type: "unlock",
        masterPassword: "transient-secret",
      });
      const statusAfterUnlock = await dispatcher.handleRequest({ requestId: "r-status-1", type: "status" });
      const foldersResponse = await dispatcher.handleRequest({ requestId: "r-folders", type: "listFolders" });
      // Resolve folderName -> folderId from listFolders and thread it into listItems (design M-3).
      const folderId = foldersResponse.type === "folders" ? foldersResponse.folders[0]?.id ?? "" : "";
      const itemsResponse = await dispatcher.handleRequest({ requestId: "r-items", type: "listItems", folderId });
      const itemResponse = await dispatcher.handleRequest({ requestId: "r-item", type: "getItem", uuid: UUID });
      const totpResponse = await dispatcher.handleRequest({ requestId: "r-totp", type: "getTotp", uuid: UUID });
      const lockResponse = await dispatcher.handleRequest({ requestId: "r-lock", type: "lock" });
      const statusAfterLock = await dispatcher.handleRequest({ requestId: "r-status-2", type: "status" });

      // Then: state flows unlocked -> locked and the resolved folder id drives listItems.
      expect(unlocked).toEqual({ requestId: "r-unlock", type: "unlocked" });
      expect(statusAfterUnlock).toEqual({
        requestId: "r-status-1",
        type: "status",
        unlocked: true,
        lastUsedAt: "2026-07-03T01:02:03.004Z",
      });
      expect(folderId).toBe("folder-1");
      expect(listItemsFolderIds).toEqual(["folder-1"]);
      expect(itemsResponse.type).toBe("items");
      expect(itemResponse).toEqual({
        requestId: "r-item",
        type: "item",
        username: "iam-user",
        password: "secret-password",
      });
      expect(totpResponse).toEqual({
        requestId: "r-totp",
        type: "totp",
        code: "123456",
        remainingSeconds: 27,
      });
      expect(lockResponse).toEqual({ requestId: "r-lock", type: "locked" });
      expect(statusAfterLock).toEqual({
        requestId: "r-status-2",
        type: "status",
        unlocked: false,
        lastUsedAt: "2026-07-03T01:02:03.004Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("task 10.2 dispatcher integration (requestId demux under interleaving)", () => {
  it("binds each response to its own requestId and payload when bw calls resolve out of order", async () => {
    // Given: an unlocked dispatcher whose getItem for two uuids can be resolved in reverse order.
    const session = createSessionManager(() => new Date("2026-07-03T01:02:03.004Z"));
    const resolvers = new Map<string, (value: Result<string, FlowError>) => void>();
    const itemJsonFor = (username: string, password: string): string =>
      JSON.stringify({ login: { username, password } });
    const bwCli: BwCli = {
      ...makeFakeBwCli(),
      getItem: (uuid: string) =>
        new Promise<Result<string, FlowError>>((resolve) => {
          resolvers.set(uuid, resolve);
        }),
    };
    const dispatcher = createHostDispatcher({ bwCli, session });
    await dispatcher.handleRequest({
      requestId: "r-unlock",
      type: "unlock",
      masterPassword: "transient-secret",
    });

    // When: two getItem requests are issued and then completed in reverse arrival order.
    const first = dispatcher.handleRequest({ requestId: "r-item-A", type: "getItem", uuid: "uuid-A" });
    const second = dispatcher.handleRequest({ requestId: "r-item-B", type: "getItem", uuid: "uuid-B" });
    await vi.waitFor(() => {
      expect(resolvers.has("uuid-A")).toBe(true);
      expect(resolvers.has("uuid-B")).toBe(true);
    });
    resolvers.get("uuid-B")?.(ok(itemJsonFor("user-B", "pass-B")));
    resolvers.get("uuid-A")?.(ok(itemJsonFor("user-A", "pass-A")));
    const [responseA, responseB] = await Promise.all([first, second]);

    // Then: each response keeps its own requestId and its own item payload (no cross-contamination).
    expect(responseA).toEqual({ requestId: "r-item-A", type: "item", username: "user-A", password: "pass-A" });
    expect(responseB).toEqual({ requestId: "r-item-B", type: "item", username: "user-B", password: "pass-B" });
  });
});
