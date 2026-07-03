import {
  err,
  isAccountMeta,
  isFolderSummary,
  makeFlowError,
  ok,
  type AccountMeta,
  type FlowError,
  type FolderSummary,
  type Result,
} from "@acs/shared";

export interface ItemSecret {
  readonly username: string;
  readonly password: string;
}

export function parseFolderSummaries(text: string): Result<readonly FolderSummary[], FlowError> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return parsed;
  }
  if (!Array.isArray(parsed.value) || !parsed.value.every(isFolderSummary)) {
    return malformedBwOutput();
  }
  return ok(parsed.value.map((folder) => ({ id: folder.id, name: folder.name })));
}

export function parseAccountMetas(text: string): Result<readonly AccountMeta[], FlowError> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return parsed;
  }
  if (!Array.isArray(parsed.value)) {
    return malformedBwOutput();
  }
  const items = parsed.value.map(toAccountMeta);
  if (!items.every(isDefined)) {
    return malformedBwOutput();
  }
  return ok(items);
}

export function parseItemSecret(text: string): Result<ItemSecret, FlowError> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return parsed;
  }
  const item = objectValue(parsed.value);
  const login = item === undefined ? undefined : objectProperty(item, "login");
  const username = login === undefined ? undefined : stringProperty(login, "username");
  const password = login === undefined ? undefined : stringProperty(login, "password");
  return username === undefined || password === undefined
    ? malformedBwOutput()
    : ok({ username, password });
}

function parseJson(text: string): Result<unknown, FlowError> {
  try {
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return malformedBwOutput();
    }
    if (error instanceof Error) {
      return malformedBwOutput();
    }
    throw error;
  }
}

function toAccountMeta(value: unknown): AccountMeta | undefined {
  const item = objectValue(value);
  if (item === undefined) {
    return undefined;
  }
  const uuid = stringProperty(item, "id");
  const login = objectProperty(item, "login");
  const username = login === undefined ? undefined : stringProperty(login, "username");
  const fields = arrayProperty(item, "fields");
  const accountId = fields === undefined ? undefined : customFieldValue(fields, "aws_account_id");
  if (uuid === undefined || username === undefined || accountId === undefined) {
    return undefined;
  }

  const alias = fields === undefined ? undefined : customFieldValue(fields, "aws_account_alias");
  const signInUrl = login === undefined ? undefined : firstLoginUri(login);
  const totp = login === undefined ? undefined : stringProperty(login, "totp");
  const base = { uuid, accountId, username, mfaEnabled: totp !== undefined && totp.length > 0 };
  const withAlias = alias === undefined ? base : { ...base, alias };
  const meta = signInUrl === undefined ? withAlias : { ...withAlias, signInUrl };
  return isAccountMeta(meta) ? meta : undefined;
}

function customFieldValue(fields: readonly unknown[], targetName: string): string | undefined {
  for (const field of fields) {
    const fieldObject = objectValue(field);
    if (fieldObject === undefined) {
      continue;
    }
    if (stringProperty(fieldObject, "name") === targetName) {
      return stringProperty(fieldObject, "value");
    }
  }
  return undefined;
}

function firstLoginUri(login: object): string | undefined {
  const uris = arrayProperty(login, "uris");
  const firstUri = uris?.[0];
  const firstUriObject = objectValue(firstUri);
  return firstUriObject === undefined ? undefined : stringProperty(firstUriObject, "uri");
}

function objectValue(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function objectProperty(value: object, key: string): object | undefined {
  return objectValue(Reflect.get(value, key));
}

function stringProperty(value: object, key: string): string | undefined {
  const property: unknown = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

function arrayProperty(value: object, key: string): readonly unknown[] | undefined {
  const property: unknown = Reflect.get(value, key);
  return Array.isArray(property) ? property : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function malformedBwOutput(): Result<never, FlowError> {
  return err(makeFlowError("host_not_running", "Bitwarden CLI returned malformed output."));
}
