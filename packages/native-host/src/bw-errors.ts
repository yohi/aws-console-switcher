import { type FlowError } from "@acs/shared";

type UnlockErrorCode = "bad_password" | "vault_locked";
type BwFailureCode =
  | "bw_not_logged_in"
  | "host_not_running"
  | "invalid_uuid"
  | "item_not_found"
  | "vault_locked";

export function classifyUnlockFailure(output: string): FlowError {
  const lowerOutput = output.toLowerCase();
  const code: UnlockErrorCode = lowerOutput.includes("invalid master password") ||
    lowerOutput.includes("invalid password") ||
    lowerOutput.includes("incorrect password")
    ? "bad_password"
    : "vault_locked";
  return preconditionError(code, unlockFailureMessage(code));
}

export function classifyBwFailure(output: string): FlowError {
  const lowerOutput = output.toLowerCase();
  if (lowerOutput.includes("not logged in") || lowerOutput.includes("not authenticated")) {
    return preconditionError("bw_not_logged_in", "Bitwarden CLI is not logged in.");
  }
  if (lowerOutput.includes("invalid uuid") || lowerOutput.includes("invalid item id")) {
    return preconditionError("invalid_uuid", "Bitwarden item UUID is invalid.");
  }
  if (lowerOutput.includes("item not found") || lowerOutput.includes("object not found")) {
    return preconditionError("item_not_found", "Bitwarden item was not found.");
  }
  if (
    lowerOutput.includes("vault is locked") ||
    lowerOutput.includes("vault locked") ||
    lowerOutput.includes("not unlocked") ||
    lowerOutput.includes("run bw unlock")
  ) {
    return preconditionError("vault_locked", "Bitwarden vault is locked.");
  }
  return commandStartError();
}

export function commandStartError(): FlowError {
  return preconditionError("host_not_running", "Bitwarden CLI could not be started.");
}

function unlockFailureMessage(code: UnlockErrorCode): string {
  switch (code) {
    case "bad_password":
      return "Bitwarden master password was rejected.";
    case "vault_locked":
      return "Bitwarden vault could not be unlocked.";
    default:
      return assertNever(code);
  }
}

function preconditionError(code: BwFailureCode | UnlockErrorCode, message: string): FlowError {
  return { category: "precondition", code, message, retriable: false };
}

function assertNever(value: never): never {
  void value;
  throw new TypeError("Unhandled Bitwarden error code.");
}
