/**
 * 失敗 3 分類と型付きエラー（design.md「共通型: Result とエラー分類」, requirements 3.5）。
 *
 * カタログ（`FAILURE_CATEGORIES` / `FLOW_ERROR_CODES`）を単一の真実源とし、
 * そこから型（`FailureCategory` / `FlowErrorCode`）を導出することで、
 * コンパイル時のユニオンと実行時バリデーションを一致させる。
 */

/** requirements 3.5 の 3 分類。UX 分岐の基準。 */
export const FAILURE_CATEGORIES = [
  "precondition",
  "aws_auth",
  "dom_timeout",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FLOW_ERROR_CODES = [
  "host_not_running",
  "host_disconnected",
  "bw_not_logged_in",
  "vault_locked",
  "item_not_found",
  "invalid_uuid",
  "bad_password",
  "account_locked",
  "totp_rejected",
  "selector_not_found",
  "page_not_rendered",
  "captcha_detected",
  "malformed_request",
  "invalid_configuration",
] as const;
export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number];

/** 全ポート境界で共有する型付きエラー（design.md FlowError）。 */
export interface FlowError {
  readonly category: FailureCategory;
  /** ユーザー向けの行動可能なメッセージ（秘匿値は含めない）。 */
  readonly message: string;
  readonly code: FlowErrorCode;
  /** 例: totp_rejected は次コードで 1 回のみ自動再試行するため true。 */
  readonly retriable: boolean;
}

/**
 * 各エラーコードの正準カテゴリ。
 *
 * - `item_not_found` / `invalid_uuid`（真のオブジェクト欠落）は AWS 認証でも DOM でもないため
 *   `precondition` に分類する。ただし「一時的前提条件エラー」とは `isTrueObjectMissing` で区別し、
 *   UUID 再同期トリガー（3.4 (a) / task 8.2）へ回す。
 * - `captcha_detected` はサインイン DOM で検知され、手動介入フォールバックが `dom_timeout` と
 *   同じ経路になるため `dom_timeout` に分類する（3.5 補足）。
 */
const CODE_TO_CATEGORY: Record<FlowErrorCode, FailureCategory> = {
  host_not_running: "precondition",
  host_disconnected: "precondition",
  bw_not_logged_in: "precondition",
  vault_locked: "precondition",
  item_not_found: "precondition",
  invalid_uuid: "precondition",
  bad_password: "aws_auth",
  account_locked: "aws_auth",
  totp_rejected: "aws_auth",
  selector_not_found: "dom_timeout",
  page_not_rendered: "dom_timeout",
  captcha_detected: "dom_timeout",
  malformed_request: "precondition",
  invalid_configuration: "precondition",
};

/**
 * コード別の既定 retriable。design.md「totp_rejected は次コードで 1 回のみ自動再試行」に従い、
 * `totp_rejected` のみ true、他は false。
 */
const DEFAULT_RETRIABLE: Record<FlowErrorCode, boolean> = {
  host_not_running: false,
  host_disconnected: false,
  bw_not_logged_in: false,
  vault_locked: false,
  item_not_found: false,
  invalid_uuid: false,
  bad_password: false,
  account_locked: false,
  totp_rejected: true,
  selector_not_found: false,
  page_not_rendered: false,
  captcha_detected: false,
  malformed_request: false,
  invalid_configuration: false,
};

/** エラーコードの正準カテゴリを返す。 */
export function categoryForCode(code: FlowErrorCode): FailureCategory {
  return CODE_TO_CATEGORY[code];
}

/** エラーコードの既定 retriable を返す。 */
export function isRetriableByDefault(code: FlowErrorCode): boolean {
  return DEFAULT_RETRIABLE[code];
}

/** `makeFlowError` の任意オプション。 */
export interface MakeFlowErrorOptions {
  /** 既定の retriable を上書きする（例: 再試行上限超過で false に固定）。 */
  readonly retriable?: boolean;
}

/**
 * コードから正準カテゴリと既定 retriable を導出して FlowError を生成する。
 * category と code の不整合を構造的に防ぐ唯一の生成経路。
 */
export function makeFlowError(
  code: FlowErrorCode,
  message: string,
  options?: MakeFlowErrorOptions,
): FlowError {
  return {
    category: CODE_TO_CATEGORY[code],
    code,
    message,
    retriable: options?.retriable ?? DEFAULT_RETRIABLE[code],
  };
}

/** 値が `FailureCategory` か判定する。 */
export function isFailureCategory(value: unknown): value is FailureCategory {
  return (
    typeof value === "string" &&
    (FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** 値が `FlowErrorCode` か判定する。 */
export function isFlowErrorCode(value: unknown): value is FlowErrorCode {
  return (
    typeof value === "string" &&
    (FLOW_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** 値が `FlowError` の形をしているか（Native Messaging 境界の実行時バリデーション用）。 */
export function isFlowError(value: unknown): value is FlowError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isFailureCategory(record["category"]) &&
    isFlowErrorCode(record["code"]) &&
    typeof record["message"] === "string" &&
    typeof record["retriable"] === "boolean"
  );
}

/**
 * 真のオブジェクト欠落（アイテム削除・無効 UUID）か判定する。
 * これのみ UUID 即時無効化＋再同期のトリガー（requirements 3.4 (a), S-3 / task 8.2）。
 */
export function isTrueObjectMissing(code: FlowErrorCode): boolean {
  return code === "item_not_found" || code === "invalid_uuid";
}

/**
 * 一時的な前提条件エラー（Vault ロック・ホスト未起動・未ログイン・切断）か判定する。
 * これらはキャッシュ保持し UUID 無効化・再同期を行わない（requirements 3.4, S-3）。
 */
export function isTransientPreconditionError(code: FlowErrorCode): boolean {
  return (
    code === "vault_locked" ||
    code === "bw_not_logged_in" ||
    code === "host_not_running" ||
    code === "host_disconnected"
  );
}
