import { describe, expect, it } from "vitest";
import { createBwCli, type BwCommand, type CommandOutcome } from "./bw-cli.js";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createBwCli task 2.3 commands", () => {
  it("runs bw list folders with the in-memory BW_SESSION", async () => {
    // Given: a fake command runner for folder listing.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push({ ...command, env: { ...command.env } });
      return { exitCode: 0, stdout: "[]\n", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: folders are requested.
    const result = await cli.listFolders("bw-session-token");

    // Then: bw list folders receives the session token only in child env.
    expect(result).toEqual({ ok: true, value: "[]" });
    expect(captured).toEqual([
      {
        args: ["list", "folders"],
        env: expect.objectContaining({ BW_SESSION: "bw-session-token" }),
      },
    ]);
    expect(process.env["BW_SESSION"]).toBeUndefined();
  });

  it("runs bw list items for a folder with the in-memory BW_SESSION", async () => {
    // Given: a fake command runner for item listing.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push({ ...command, env: { ...command.env } });
      return { exitCode: 0, stdout: "[]\n", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: items in a folder are requested.
    const result = await cli.listItems("folder-1", "bw-session-token");

    // Then: bw list items is scoped to the folder and uses child env only.
    expect(result).toEqual({ ok: true, value: "[]" });
    expect(captured).toEqual([
      {
        args: ["list", "items", "--folderid", "folder-1"],
        env: expect.objectContaining({ BW_SESSION: "bw-session-token" }),
      },
    ]);
    expect(process.env["BW_SESSION"]).toBeUndefined();
  });

  it("runs bw get item for a uuid with the in-memory BW_SESSION", async () => {
    // Given: a fake command runner for item retrieval.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push({ ...command, env: { ...command.env } });
      return { exitCode: 0, stdout: "{}\n", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: an item is requested.
    const result = await cli.getItem(UUID, "bw-session-token");

    // Then: bw get item targets only that UUID.
    expect(result).toEqual({ ok: true, value: "{}" });
    expect(captured).toEqual([
      {
        args: ["get", "item", UUID],
        env: expect.objectContaining({ BW_SESSION: "bw-session-token" }),
      },
    ]);
  });

  it("runs bw get totp for a uuid with the in-memory BW_SESSION", async () => {
    // Given: a fake command runner for TOTP retrieval.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push({ ...command, env: { ...command.env } });
      return { exitCode: 0, stdout: "123456\n", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: a TOTP code is requested.
    const result = await cli.getTotp(UUID, "bw-session-token");

    // Then: bw get totp targets only that UUID.
    expect(result).toEqual({ ok: true, value: "123456" });
    expect(captured).toEqual([
      {
        args: ["get", "totp", UUID],
        env: expect.objectContaining({ BW_SESSION: "bw-session-token" }),
      },
    ]);
  });

  it("classifies locked vault output as vault_locked", async () => {
    // Given: bw reports that the vault is locked.
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: 1,
      stdout: "",
      stderr: "Vault is locked. Run bw unlock.",
    });
    const cli = createBwCli(runner);

    // When: folders are requested.
    const result = await cli.listFolders("expired-session-token");

    // Then: callers can branch on the locked-vault precondition.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("vault_locked");
      expect(result.error.category).toBe("precondition");
    }
  });

  it("classifies missing bw login as bw_not_logged_in", async () => {
    // Given: bw reports there is no login state.
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: 1,
      stdout: "You are not logged in.",
      stderr: "",
    });
    const cli = createBwCli(runner);

    // When: folders are requested.
    const result = await cli.listFolders("bw-session-token");

    // Then: callers receive the not-logged-in precondition code.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bw_not_logged_in");
      expect(result.error.category).toBe("precondition");
    }
  });

  it("classifies invalid UUID output separately from missing items", async () => {
    // Given: bw rejects the UUID shape.
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: 1,
      stdout: "",
      stderr: "Invalid item ID.",
    });
    const cli = createBwCli(runner);

    // When: an item is requested.
    const result = await cli.getItem("not-a-uuid", "bw-session-token");

    // Then: callers receive invalid_uuid, not a generic host failure.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_uuid");
      expect(result.error.category).toBe("precondition");
    }
  });

  it("classifies not-found item output as item_not_found", async () => {
    // Given: bw cannot find the target object.
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: 1,
      stdout: "",
      stderr: "Item not found.",
    });
    const cli = createBwCli(runner);

    // When: an item is requested.
    const result = await cli.getItem(UUID, "bw-session-token");

    // Then: true object disappearance is distinguishable from transient vault errors.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("item_not_found");
      expect(result.error.category).toBe("precondition");
    }
  });
});
