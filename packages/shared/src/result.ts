/**
 * 全ポート境界（Popup/Content Script/Service Worker 間、Native Messaging）で用いる
 * 成功 / 型付きエラーの判別共用体。
 *
 * 例外送出ではなく `Result` を返すことで、失敗 3 分類（precondition / aws_auth /
 * dom_timeout）を型安全に扱い UX を分岐する（design.md「共通型: Result とエラー分類」, 3.5）。
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** 成功結果を生成する。 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** 失敗結果を生成する。 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** 成功結果へ絞り込む型ガード。 */
export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

/** 失敗結果へ絞り込む型ガード。 */
export function isErr<T, E>(
  result: Result<T, E>,
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** 成功値を変換する（失敗はそのまま伝播）。 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** 失敗値を変換する（成功はそのまま伝播）。 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** 成功なら内包値、失敗なら fallback を返す。 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** 成功なら fallible な後続処理へ連結する（失敗は短絡させる）。 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}
