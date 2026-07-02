/**
 * Native Messaging と拡張内メッセージングで用いる `requestId` の生成・検証。
 *
 * design.md より、`requestId` は要求ごとに `crypto.randomUUID()` で生成する（Web Crypto,
 * Service Worker と Node の双方でグローバルに利用可能）。共有ポート上での並行要求
 * （最大 5 セッション）の取り違えを実用上無視できるレベルまで低減する（C-5）。
 */

/** 標準的な UUID v4 の表記（バージョン/バリアントニブルを含む）。 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 要求ごとに一意な `requestId` を生成する。 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * 値が `requestId: string` 契約を満たすか（非空文字列）を判定する型ガード。
 * Native Messaging 境界での実行時バリデーションに用いる。
 */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 値が標準表記の UUID v4 か判定する（生成値の形式検証・厳格チェック用）。 */
export function isCanonicalUuidV4(value: unknown): boolean {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}
