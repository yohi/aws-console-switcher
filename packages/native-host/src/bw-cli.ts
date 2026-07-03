import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { err, ok, type FlowError, type Result } from "@acs/shared";
import { classifyBwFailure, classifyUnlockFailure, commandStartError } from "./bw-errors.js";

export interface BwCommand {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: BwCommand) => Promise<CommandOutcome>;

export interface BwCli {
  readonly unlock: (masterPassword: string) => Promise<Result<string, FlowError>>;
  readonly lock: (sessionToken?: string) => Promise<Result<string, FlowError>>;
  readonly status: (sessionToken?: string) => Promise<Result<string, FlowError>>;
  readonly listFolders: (sessionToken?: string) => Promise<Result<string, FlowError>>;
  readonly listItems: (folderId: string, sessionToken?: string) => Promise<Result<string, FlowError>>;
  readonly getItem: (uuid: string, sessionToken?: string) => Promise<Result<string, FlowError>>;
  readonly getTotp: (uuid: string, sessionToken?: string) => Promise<Result<string, FlowError>>;
}

interface RunCommandRequest {
  readonly runner: CommandRunner;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly failureError: (stderr: string) => FlowError;
}

type PreconditionErrorCode = "bad_password" | "host_not_running" | "vault_locked";

const BW_COMMAND = "bw";
const DEFAULT_BW_COMMAND_TIMEOUT_MS = 10_000;
const PASSWORD_ENV_PREFIX = "ACS_BW_MASTER_PASSWORD_";

export function createBwCli(runner: CommandRunner = spawnBwCommand): BwCli {
  return {
    unlock(masterPassword: string): Promise<Result<string, FlowError>> {
      return unlockVault(runner, masterPassword);
    },
    lock(sessionToken?: string): Promise<Result<string, FlowError>> {
      return runBwCommand({
        runner,
        args: ["lock"],
        env: childEnv(sessionToken),
        failureError: () => preconditionError("vault_locked", "Bitwarden vault could not be locked."),
      });
    },
    status(sessionToken?: string): Promise<Result<string, FlowError>> {
      return runBwCommand({
        runner,
        args: ["status"],
        env: childEnv(sessionToken),
        failureError: () => preconditionError("vault_locked", "Bitwarden vault status could not be read."),
      });
    },
    listFolders(sessionToken?: string): Promise<Result<string, FlowError>> {
      return runBwCommand({
        runner,
        args: ["list", "folders"],
        env: childEnv(sessionToken),
        failureError: classifyBwFailure,
      });
    },
    listItems(folderId: string, sessionToken?: string): Promise<Result<string, FlowError>> {
      return runBwCommand({
        runner,
        args: ["list", "items", "--folderid", folderId],
        env: childEnv(sessionToken),
        failureError: classifyBwFailure,
      });
    },
    getItem(uuid: string, sessionToken?: string): Promise<Result<string, FlowError>> {
      return runBwCommand({
        runner,
        args: ["get", "item", uuid],
        env: childEnv(sessionToken),
        failureError: classifyBwFailure,
      });
    },
    getTotp(uuid: string, sessionToken?: string): Promise<Result<string, FlowError>> {
      return runBwCommand({
        runner,
        args: ["get", "totp", uuid],
        env: childEnv(sessionToken),
        failureError: classifyBwFailure,
      });
    },
  };
}

async function unlockVault(
  runner: CommandRunner,
  masterPassword: string,
): Promise<Result<string, FlowError>> {
  const passwordEnvName = `${PASSWORD_ENV_PREFIX}${randomUUID().replaceAll("-", "_")}`;
  const env = childEnv();
  env[passwordEnvName] = masterPassword;

  let outcomePromise: Promise<CommandOutcome>;
  try {
    outcomePromise = runner({
      args: ["unlock", "--raw", "--passwordenv", passwordEnvName],
      env,
    });
  } catch (error) {
    delete env[passwordEnvName];
    if (error instanceof Error) {
      return err(commandStartError());
    }
    return err(commandStartError());
  }
  delete env[passwordEnvName];

  const outcomeResult = await settleOutcome(outcomePromise);
  if (!outcomeResult.ok) {
    return outcomeResult;
  }

  const outcome = outcomeResult.value;
  if (outcome.exitCode === null) {
    return err(preconditionError("host_not_running", "Bitwarden CLI could not be started."));
  }

  if (outcome.exitCode === 0) {
    const sessionToken = outcome.stdout.trim();
    return sessionToken.length > 0
      ? ok(sessionToken)
      : err(preconditionError("vault_locked", "Bitwarden vault did not return a session."));
  }

  return err(classifyUnlockFailure(failureOutput(outcome)));
}

async function runBwCommand(request: RunCommandRequest): Promise<Result<string, FlowError>> {
  const outcomeResult = await runCommand(request.runner, {
    args: request.args,
    env: request.env,
  });
  if (!outcomeResult.ok) {
    return outcomeResult;
  }

  const outcome = outcomeResult.value;
  if (outcome.exitCode === 0) {
    return ok(outcome.stdout.trim());
  }

  if (outcome.exitCode === null) {
    return err(preconditionError("host_not_running", "Bitwarden CLI could not be started."));
  }

  return err(request.failureError(failureOutput(outcome)));
}

function failureOutput(outcome: CommandOutcome): string {
  return `${outcome.stderr}\n${outcome.stdout}`;
}

async function runCommand(
  runner: CommandRunner,
  command: BwCommand,
): Promise<Result<CommandOutcome, FlowError>> {
  try {
    return await settleOutcome(runner(command));
  } catch (error) {
    if (error instanceof Error) {
      return err(commandStartError());
    }
    throw error;
  }
}

async function settleOutcome(
  outcomePromise: Promise<CommandOutcome>,
): Promise<Result<CommandOutcome, FlowError>> {
  try {
    return ok(await outcomePromise);
  } catch (error) {
    if (error instanceof Error) {
      return err(commandStartError());
    }
    throw error;
  }
}

export function spawnBwCommand(
  command: BwCommand,
  timeoutMs = DEFAULT_BW_COMMAND_TIMEOUT_MS,
): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    const child = spawn(BW_COMMAND, [...command.args], {
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      settle({ exitCode: null, stdout: "", stderr: "" });
    }, timeoutMs);

    const settle = (outcome: CommandOutcome): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(outcome);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      settle({ exitCode: null, stdout: "", stderr: "" });
    });
    child.on("close", (exitCode: number | null) => {
      settle({ exitCode, stdout, stderr });
    });
  });
}

function childEnv(sessionToken?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sessionToken !== undefined && sessionToken.length > 0) {
    env["BW_SESSION"] = sessionToken;
  }
  return env;
}

function preconditionError(code: PreconditionErrorCode, message: string): FlowError {
  return { category: "precondition", code, message, retriable: false };
}
