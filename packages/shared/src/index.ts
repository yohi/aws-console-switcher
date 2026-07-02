/**
 * `@acs/shared` — AWS Console Switcher 全ポート境界で共有する契約。
 *
 * - Result / 型付きエラー（失敗 3 分類・エラーコード列挙）
 * - 非秘匿データモデル（AccountMeta / SessionRecord / FlowContext / ExtensionSettings /
 *   SelectorSet。パスワード・TOTP は型レベルで保持不可）
 * - 拡張内メッセージ（Popup/Content Script → Service Worker）判別共用体
 * - Native Messaging プロトコル（要求・応答）判別共用体（全要求が requestId を持つ）
 * - requestId 生成 / 検証
 */

export * from "./result.js";
export * from "./flow-error.js";
export * from "./request-id.js";
export * from "./data-models.js";
export * from "./ext-message.js";
export * from "./host-protocol.js";
