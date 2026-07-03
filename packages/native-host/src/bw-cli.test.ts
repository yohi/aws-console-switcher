import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBwCli, spawnBwCommand, type BwCommand, type CommandOutcome } from "./bw-cli.js";

describe("createBwCli", () => {
  it("runs bw unlock with --raw and --passwordenv, returning BW_SESSION", async () => {
    // Given: a fake command runner that records the requested bw command.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push({ ...command, env: { ...command.env } });
      return { exitCode: 0, stdout: "bw-session-token\n", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: the vault is unlocked with a transient master password.
    const result = await cli.unlock("correct horse battery staple");

    // Then: bw receives the password only through the temporary environment variable.
    expect(result).toEqual({ ok: true, value: "bw-session-token" });
    expect(captured).toHaveLength(1);
    const command = captured[0];
    expect(command?.args.slice(0, 3)).toEqual(["unlock", "--raw", "--passwordenv"]);
    const passwordEnvName = command?.args[3];
    expect(passwordEnvName).toMatch(/^ACS_BW_MASTER_PASSWORD_/u);
    expect(command?.env[passwordEnvName ?? ""]).toBe("correct horse battery staple");
    expect(process.env[passwordEnvName ?? ""]).toBeUndefined();
  });

  it("classifies an invalid master password as bad_password", async () => {
    // Given: bw rejects the supplied password.
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: 1,
      stdout: "",
      stderr: "Invalid master password.",
    });
    const cli = createBwCli(runner);

    // When: unlock fails.
    const result = await cli.unlock("wrong-password");

    // Then: callers receive a typed precondition error they can branch on.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("precondition");
      expect(result.error.code).toBe("bad_password");
    }
  });

  it("classifies an unlock start failure as host_not_running", async () => {
    // Given: bw could not start and reports a null exit code.
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: null,
      stdout: "",
      stderr: "",
    });
    const cli = createBwCli(runner);

    // When: unlock fails before bw can produce password-specific output.
    const result = await cli.unlock("correct horse battery staple");

    // Then: callers receive the same start-failure precondition used by other bw commands.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("precondition");
      expect(result.error.code).toBe("host_not_running");
      expect(result.error.message).toBe("Bitwarden CLI could not be started.");
    }
  });

  it("does not leak the master password in unlock error messages", async () => {
    // Given: bw failure output mentions the secret supplied by the user.
    const leakedSecret = "do-not-return-this-secret";
    const runner = async (): Promise<CommandOutcome> => ({
      exitCode: 1,
      stdout: "",
      stderr: `Invalid password: ${leakedSecret}`,
    });
    const cli = createBwCli(runner);

    // When: unlock fails.
    const result = await cli.unlock(leakedSecret);

    // Then: the public FlowError remains sanitized.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain(leakedSecret);
      expect(result.error.message).not.toContain(leakedSecret);
    }
  });

  it("runs bw lock with the in-memory BW_SESSION in child env only", async () => {
    // Given: a fake command runner that records lock execution.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push({ ...command, env: { ...command.env } });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: the vault is locked with a held session token.
    const result = await cli.lock("bw-session-token");

    // Then: bw lock is invoked without persisting BW_SESSION in process.env.
    expect(result).toEqual({ ok: true, value: "" });
    expect(captured).toEqual([
      {
        args: ["lock"],
        env: expect.objectContaining({ BW_SESSION: "bw-session-token" }),
      },
    ]);
    expect(process.env["BW_SESSION"]).toBeUndefined();
  });

  it("runs bw status", async () => {
    // Given: a fake command runner for bw status.
    const captured: BwCommand[] = [];
    const runner = async (command: BwCommand): Promise<CommandOutcome> => {
      captured.push(command);
      return { exitCode: 0, stdout: "{\"status\":\"unlocked\"}\n", stderr: "" };
    };
    const cli = createBwCli(runner);

    // When: status is requested.
    const result = await cli.status("bw-session-token");

    // Then: bw status output is returned without exposing the session token.
    expect(result).toEqual({ ok: true, value: "{\"status\":\"unlocked\"}" });
    expect(captured).toEqual([
      {
        args: ["status"],
        env: expect.objectContaining({ BW_SESSION: "bw-session-token" }),
      },
    ]);
  });

  it("times out a hanging bw process and resolves as a start failure", async () => {
    // Given: a fake bw executable that never exits on its own.
    const binDir = await mkdtemp(join(tmpdir(), "acs-bw-timeout-"));
    const bwPath = join(binDir, "bw");
    await writeFile(bwPath, "#!/usr/bin/env sh\nwhile true; do sleep 1; done\n", { mode: 0o755 });

    // When: the spawn runner is called with a short timeout.
    const outcome = await spawnBwCommand(
      {
        args: ["status"],
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      },
      10,
    );

    // Then: the Promise resolves with the existing null-exit start-failure shape.
    expect(outcome).toEqual({ exitCode: null, stdout: "", stderr: "" });
  });

});
