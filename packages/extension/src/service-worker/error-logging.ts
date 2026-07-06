/**
 * 失敗の構造化ログ（task 9.1, design.md「Monitoring」）。
 *
 * design.md「Monitoring」: 失敗は `category` / `code` を構造化ログとして拡張内に記録する
 * （秘匿値は出力禁止）。本ヘルパーは副作用（`console.error`）のみを持つ薄い関数とし、
 * ロギングフレームワークは導入しない（本リポジトリの簡素性方針）。
 *
 * 秘匿境界（最重要）: `FlowError.message` は全生成経路でテンプレート化された静的文字列であり
 * 秘匿値を補間しない設計だが（`makeFlowError` 呼び出し全箇所を task 9.1 で監査済み）、万一の混入に
 * 備え本ログは `message` を一切出力しない。記録するのは `{ category, code, retriable }` と、呼び出し側が
 * 明示的に渡す非秘匿 `context`（例: メッセージ種別・tabId）のみ。`context` に秘匿値を渡してはならない。
 */
import { type FlowError } from "@acs/shared";

/** `logFlowError` が出力する構造化レコード（秘匿値・`message` を含まない）。 */
export interface FlowErrorLogRecord {
  readonly kind: "flow_error";
  readonly category: FlowError["category"];
  readonly code: FlowError["code"];
  readonly retriable: boolean;
  /** 呼び出し側が付与する非秘匿メタ（省略可）。秘匿値を含めてはならない。 */
  readonly context?: Record<string, unknown>;
}

/** 構造化ログの安定した接頭ラベル（ログ収集・grep 用）。 */
export const FLOW_ERROR_LOG_LABEL = "[acs] flow_error";

/**
 * `FlowError` を構造化ログとして記録する（design.md「Monitoring」）。
 *
 * `message` は秘匿値混入リスクを避けるため出力しない。`context` には tabId やメッセージ種別など
 * 非秘匿メタのみを渡すこと（秘匿値は渡さない）。
 */
export function logFlowError(
  error: FlowError,
  context?: Record<string, unknown>,
): void {
  // exactOptionalPropertyTypes: context 未指定時は context キー自体を付与しない。
  const record: FlowErrorLogRecord =
    context === undefined
      ? {
          kind: "flow_error",
          category: error.category,
          code: error.code,
          retriable: error.retriable,
        }
      : {
          kind: "flow_error",
          category: error.category,
          code: error.code,
          retriable: error.retriable,
          context,
        };
  console.error(FLOW_ERROR_LOG_LABEL, record);
}
