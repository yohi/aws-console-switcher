import {
  hasRequestId,
  isHostRequest,
  makeFlowError,
  type FlowError,
  type FlowErrorCode,
  type HostRequest,
  type HostResponse,
} from "@acs/shared";
import { parseAccountMetas, parseFolderSummaries, parseItemSecret } from "./bw-json.js";
import { createBwCli, type BwCli } from "./bw-cli.js";
import { createSessionManager, type HostSettings, type SessionManager } from "./session.js";
import { getTotpCodeWithWindowWait } from "./totp-wait.js";

const UNKNOWN_REQUEST_ID = "unknown";

export interface HostDispatcherDependencies {
  readonly bwCli: BwCli;
  readonly session: SessionManager;
}

export interface HostDispatcher {
  readonly handleIncomingMessage: (message: unknown) => Promise<HostResponse>;
  readonly handleRequest: (request: HostRequest) => Promise<HostResponse>;
}

const defaultDependencies = createDefaultHostDispatcherDependencies();
const defaultDispatcher = createHostDispatcher(defaultDependencies);

export function createDefaultHostDispatcherDependencies(): HostDispatcherDependencies {
  return {
    bwCli: createBwCli(),
    session: createSessionManager(),
  };
}

export function defaultHostDispatcherDependencies(): HostDispatcherDependencies {
  return defaultDependencies;
}

export function makeErrorResponse(
  requestId: string,
  error: FlowError,
): HostResponse {
  return { requestId, type: "error", error };
}

export function createHostDispatcher(deps: HostDispatcherDependencies): HostDispatcher {
  const handleRequestForDeps = async (request: HostRequest): Promise<HostResponse> => {
    try {
      deps.session.touch();
      return await dispatchRequest(request, deps);
    } catch (error) {
      if (error instanceof Error) {
        return makeErrorResponse(
          request.requestId,
          flowError("host_not_running", "Native host handler failed."),
        );
      }
      throw error;
    }
  };

  return {
    async handleIncomingMessage(message: unknown): Promise<HostResponse> {
      if (!isHostRequest(message)) {
        return makeErrorResponse(
          requestIdFrom(message),
          makeFlowError("host_not_running", "Malformed Native Messaging request."),
        );
      }

      return handleRequestForDeps(message);
    },
    handleRequest: handleRequestForDeps,
  };
}

export function handleIncomingMessage(message: unknown): Promise<HostResponse> {
  return defaultDispatcher.handleIncomingMessage(message);
}

export function handleRequest(request: HostRequest): Promise<HostResponse> {
  return defaultDispatcher.handleRequest(request);
}

async function dispatchRequest(
  request: HostRequest,
  deps: HostDispatcherDependencies,
): Promise<HostResponse> {
  switch (request.type) {
    case "unlock": {
      let masterPassword = request.masterPassword;
      try {
        const result = await deps.bwCli.unlock(masterPassword);
        if (!result.ok) {
          return makeErrorResponse(request.requestId, result.error);
        }
        deps.session.unlock(result.value);
        return { requestId: request.requestId, type: "unlocked" };
      } finally {
        // Note: JS strings are immutable; this only clears the local reference,
        // not the underlying bytes. Secret wiping is not possible in this runtime.
        masterPassword = "";
      }
    }
    case "lock": {
      const sessionToken = deps.session.currentSession();
      deps.session.lock();
      const result = await deps.bwCli.lock(sessionToken);
      return result.ok
        ? { requestId: request.requestId, type: "locked" }
        : makeErrorResponse(request.requestId, result.error);
    }
    case "status": {
      const status = deps.session.status();
      return {
        requestId: request.requestId,
        type: "status",
        unlocked: status.unlocked,
        lastUsedAt: status.lastUsedAt,
      };
    }
    case "configure":
      return configureHost(request, deps);
    case "listFolders": {
      const sessionToken = deps.session.currentSession();
      if (sessionToken === undefined) {
        return makeErrorResponse(request.requestId, vaultLockedError());
      }
      const result = await deps.bwCli.listFolders(sessionToken);
      if (!result.ok) {
        return makeErrorResponse(request.requestId, result.error);
      }
      const folders = parseFolderSummaries(result.value);
      return folders.ok
        ? { requestId: request.requestId, type: "folders", folders: folders.value }
        : makeErrorResponse(request.requestId, folders.error);
    }
    case "listItems": {
      const sessionToken = deps.session.currentSession();
      if (sessionToken === undefined) {
        return makeErrorResponse(request.requestId, vaultLockedError());
      }
      const result = await deps.bwCli.listItems(request.folderId, sessionToken);
      if (!result.ok) {
        return makeErrorResponse(request.requestId, result.error);
      }
      const items = parseAccountMetas(result.value);
      return items.ok
        ? { requestId: request.requestId, type: "items", items: items.value }
        : makeErrorResponse(request.requestId, items.error);
    }
    case "getItem": {
      const sessionToken = deps.session.currentSession();
      if (sessionToken === undefined) {
        return makeErrorResponse(request.requestId, vaultLockedError());
      }
      const result = await deps.bwCli.getItem(request.uuid, sessionToken);
      if (!result.ok) {
        return makeErrorResponse(request.requestId, result.error);
      }
      const item = parseItemSecret(result.value);
      return item.ok
        ? {
            requestId: request.requestId,
            type: "item",
            username: item.value.username,
            password: item.value.password,
          }
        : makeErrorResponse(request.requestId, item.error);
    }
    case "getTotp": {
      const sessionToken = deps.session.currentSession();
      if (sessionToken === undefined) {
        return makeErrorResponse(request.requestId, vaultLockedError());
      }
      const result = await getTotpCodeWithWindowWait({
        minRemainingSeconds: deps.session.settings().totpMinRemainingSeconds,
        fetchCode: () => deps.bwCli.getTotp(request.uuid, sessionToken),
      });
      if (!result.ok) {
        return makeErrorResponse(request.requestId, result.error);
      }
      return {
        requestId: request.requestId,
        type: "totp",
        code: result.value.code,
        remainingSeconds: result.value.remainingSeconds,
      };
    }
    default:
      return assertNever(request);
  }
}

function configureHost(
  request: Extract<HostRequest, { readonly type: "configure" }>,
  deps: HostDispatcherDependencies,
): HostResponse {
  if (!isValidIdleLockMinutes(request.idleLockMinutes)) {
    return makeErrorResponse(request.requestId, invalidConfigurationError());
  }
  if (!isValidTotpMinRemainingSeconds(request.totpMinRemainingSeconds)) {
    return makeErrorResponse(request.requestId, invalidConfigurationError());
  }

  const settings: HostSettings = {
    idleLockMinutes: request.idleLockMinutes,
    totpMinRemainingSeconds: request.totpMinRemainingSeconds,
  };
  deps.session.configure(settings);
  return { requestId: request.requestId, type: "configured" };
}

function isValidIdleLockMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 120;
}

function isValidTotpMinRemainingSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 5 && value <= 10;
}

function invalidConfigurationError(): FlowError {
  return makeFlowError("host_not_running", "Invalid native host configuration.");
}

function flowError(code: FlowErrorCode, message: string): FlowError {
  return makeFlowError(code, message);
}

function vaultLockedError(): FlowError {
  return makeFlowError("vault_locked", "Bitwarden vault is locked.");
}

function requestIdFrom(message: unknown): string {
  return hasRequestId(message) ? message.requestId : UNKNOWN_REQUEST_ID;
}

function assertNever(value: never): never {
  void value;
  throw new TypeError("Unhandled HostRequest variant.");
}
