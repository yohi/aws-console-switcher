/**
 * 拡張内メッセージ契約（Popup / Content Script → Service Worker, design.md
 * 「ServiceWorker メッセージ契約」, requirements 5 / 3.2）。
 *
 * `chrome.runtime` メッセージングで送受信する判別共用体。境界での実行時バリデーションのため
 * `isExtMessage` 型ガードを提供する（tech.md「validate inputs at boundaries」）。
 */

/**
 * Content Script が検知しうるサインイン DOM イベント（design.md SigninDomEvent）。
 * `consoleRedirect` は含めない（HTTP 302 で CS が破棄されるため SW の `tabs.onUpdated` で検知, C-2）。
 */
export const SIGNIN_DOM_EVENTS = [
  "accountIdFieldShown",
  "credentialFieldShown",
  "mfaScreenShown",
  "authError",
  "domTimeout",
] as const;
export type SigninDomEvent = (typeof SIGNIN_DOM_EVENTS)[number];

/** Popup / Content Script → Service Worker の判別共用体（design.md ExtMessage）。 */
export type ExtMessage =
  | { readonly kind: "listAccounts" }
  | { readonly kind: "startLogin"; readonly uuid: string }
  // 待機状態から idle へ（M-5）
  | { readonly kind: "cancelLogin"; readonly uuid: string }
  // failed から idle へ（M-5）
  | { readonly kind: "retryLogin"; readonly uuid: string }
  // transient: 受け渡し後ホストが破棄。永続化・ログ出力禁止（4.1.1）
  | { readonly kind: "unlock"; readonly masterPassword: string }
  | { readonly kind: "lock" }
  | { readonly kind: "syncAccounts" }
  | {
      readonly kind: "signinDomEvent";
      readonly tabId: number;
      readonly uuid: string;
      readonly event: SigninDomEvent;
    }
  | {
      readonly kind: "consoleState";
      readonly tabId: number;
      readonly accountId?: string;
    }
  | {
      readonly kind: "updateSettings";
      readonly idleLockMinutes?: number;
      readonly totpMinRemainingSeconds?: number;
    };

/** 拡張メッセージの種別 discriminant。 */
export type ExtMessageKind = ExtMessage["kind"];

/** 値が `SigninDomEvent` か判定する。 */
export function isSigninDomEvent(value: unknown): value is SigninDomEvent {
  return (
    typeof value === "string" &&
    (SIGNIN_DOM_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * 値が `ExtMessage` か判定する型ガード（Popup/CS → SW 境界の実行時バリデーション用）。
 * `chrome.runtime` メッセージは JSON 直列化されるため `undefined` プロパティは伝送されない前提だが、
 * 任意フィールドは「キーが存在するなら型一致」を要求して健全性を保つ。
 */
export function isExtMessage(value: unknown): value is ExtMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  switch (message["kind"]) {
    case "listAccounts":
    case "lock":
    case "syncAccounts":
      return true;
    case "startLogin":
    case "cancelLogin":
    case "retryLogin":
      return typeof message["uuid"] === "string";
    case "unlock":
      return typeof message["masterPassword"] === "string";
    case "signinDomEvent":
      return (
        typeof message["tabId"] === "number" &&
        typeof message["uuid"] === "string" &&
        isSigninDomEvent(message["event"])
      );
    case "consoleState":
      return (
        typeof message["tabId"] === "number" &&
        (!("accountId" in message) || typeof message["accountId"] === "string")
      );
    case "updateSettings":
      return (
        (!("idleLockMinutes" in message) ||
          typeof message["idleLockMinutes"] === "number") &&
        (!("totpMinRemainingSeconds" in message) ||
          typeof message["totpMinRemainingSeconds"] === "number")
      );
    default:
      return false;
  }
}
