/**
 * Native Messaging プロトコル契約（Service Worker ↔ Native Host, design.md
 * 「NativeHost プロトコル契約」, requirements 3.3 / 4.2）。
 *
 * 全要求・応答は `requestId: string` を持ち、SW 側アダプタが応答を `requestId` で
 * demux する（共有ポート上の並行要求の取り違え防止, C-5）。この要件は
 * `{ requestId: string } & (...)` の交差型により **型レベルで強制** される
 * （どの判別バリアントも requestId を省略できない）。
 */

import { isAccountMeta, type AccountMeta } from "./data-models.js";
import { isFlowError, type FlowError } from "./flow-error.js";

/** `listFolders` 応答のフォルダ要約（design.md: folders: { id; name }[]）。 */
export interface FolderSummary {
  readonly id: string;
  readonly name: string;
}

/** HostRequest の種別 discriminant 一覧（SSOT）。 */
export const HOST_REQUEST_TYPES = [
  "unlock",
  "lock",
  "status",
  "configure",
  "listFolders",
  "listItems",
  "getItem",
  "getTotp",
] as const;
export type HostRequestType = (typeof HOST_REQUEST_TYPES)[number];

/** HostResponse の種別 discriminant 一覧（SSOT）。 */
export const HOST_RESPONSE_TYPES = [
  "unlocked",
  "locked",
  "configured",
  "status",
  "folders",
  "items",
  "item",
  "totp",
  "error",
] as const;
export type HostResponseType = (typeof HOST_RESPONSE_TYPES)[number];

/**
 * SW → Native Host 要求（design.md HostRequest）。
 * `{ requestId: string } &` により全バリアントが requestId を持つことを型強制する。
 */
export type HostRequest = { readonly requestId: string } & (
  // transient: 受け渡し後ホストがただちに破棄。永続化・ログ出力禁止（4.1.1）
  | { readonly type: "unlock"; readonly masterPassword: string }
  | { readonly type: "lock" }
  | { readonly type: "status" }
  // 設定伝達（Issue 5）: 拡張側設定の唯一の NH 伝達経路
  | {
      readonly type: "configure";
      readonly idleLockMinutes: number;
      readonly totpMinRemainingSeconds: number;
    }
  // folderName → folderId 解決用（M-3）
  | { readonly type: "listFolders" }
  | { readonly type: "listItems"; readonly folderId: string }
  | { readonly type: "getItem"; readonly uuid: string }
  | { readonly type: "getTotp"; readonly uuid: string }
);

/**
 * Native Host → SW 応答（design.md HostResponse）。
 * `{ requestId: string } &` により全バリアントが requestId を持つことを型強制する。
 */
export type HostResponse = { readonly requestId: string } & (
  | { readonly type: "unlocked" }
  | { readonly type: "locked" }
  | { readonly type: "configured" }
  | {
      readonly type: "status";
      readonly unlocked: boolean;
      readonly lastUsedAt: string;
    }
  | { readonly type: "folders"; readonly folders: readonly FolderSummary[] }
  | { readonly type: "items"; readonly items: readonly AccountMeta[] }
  // item は transient: username/password のみ（注入後ただちに破棄）。
  // TOTP シードは決して返さない（揮発性の徹底, C-4）。
  | { readonly type: "item"; readonly username: string; readonly password: string }
  | { readonly type: "totp"; readonly code: string; readonly remainingSeconds: number }
  | { readonly type: "error"; readonly error: FlowError }
);

/**
 * 値が `{ requestId: string }` を満たすか判定する（全要求・応答共通の前提, C-5）。
 * Native Messaging 境界での実行時バリデーションの起点。
 */
export function hasRequestId(value: unknown): value is { requestId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["requestId"] === "string"
  );
}

/** 値が `HostRequestType` か判定する。 */
export function isHostRequestType(value: unknown): value is HostRequestType {
  return (
    typeof value === "string" &&
    (HOST_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

/** 値が `HostResponseType` か判定する。 */
export function isHostResponseType(value: unknown): value is HostResponseType {
  return (
    typeof value === "string" &&
    (HOST_RESPONSE_TYPES as readonly string[]).includes(value)
  );
}

/** 値が `FolderSummary` か判定する。 */
export function isFolderSummary(value: unknown): value is FolderSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const folder = value as Record<string, unknown>;
  return typeof folder["id"] === "string" && typeof folder["name"] === "string";
}

/**
 * 値が `HostRequest` か判定する型ガード。requestId 必須を実行時にも強制する。
 */
export function isHostRequest(value: unknown): value is HostRequest {
  if (!hasRequestId(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  switch (request["type"]) {
    case "lock":
    case "status":
    case "listFolders":
      return true;
    case "unlock":
      return typeof request["masterPassword"] === "string";
    case "configure":
      return (
        typeof request["idleLockMinutes"] === "number" &&
        typeof request["totpMinRemainingSeconds"] === "number"
      );
    case "listItems":
      return typeof request["folderId"] === "string";
    case "getItem":
    case "getTotp":
      return typeof request["uuid"] === "string";
    default:
      return false;
  }
}

/**
 * 値が `HostResponse` か判定する型ガード。requestId 必須を実行時にも強制する。
 */
export function isHostResponse(value: unknown): value is HostResponse {
  if (!hasRequestId(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  switch (response["type"]) {
    case "unlocked":
    case "locked":
    case "configured":
      return true;
    case "status":
      return (
        typeof response["unlocked"] === "boolean" &&
        typeof response["lastUsedAt"] === "string"
      );
    case "folders": {
      const folders = response["folders"];
      return Array.isArray(folders) && folders.every(isFolderSummary);
    }
    case "items": {
      const items = response["items"];
      return Array.isArray(items) && items.every(isAccountMeta);
    }
    case "item":
      return (
        typeof response["username"] === "string" &&
        typeof response["password"] === "string"
      );
    case "totp":
      return (
        typeof response["code"] === "string" &&
        typeof response["remainingSeconds"] === "number"
      );
    case "error":
      return isFlowError(response["error"]);
    default:
      return false;
  }
}
