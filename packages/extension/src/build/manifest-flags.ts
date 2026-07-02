/**
 * ビルド時フラグの解決（design.md「Build & Deployment Notes」, requirements 4.1 / 9.2）。
 *
 * - `bw serve` 代替経路の `http://localhost:8087/*` host_permission は **本番ビルドから常に除外**
 *   し、非本番でも `ACS_BW_SERVE` を明示的に有効化した場合のみ含める（DNS リバインドリスク, 2.1.2）。
 * - 拡張 ID を固定する manifest `key` は `ACS_EXTENSION_KEY` から注入する（未設定時は Web Store 等の
 *   固定 ID を用いるため省略, m-7）。
 *
 * いずれも副作用のない純粋関数として実装し、`process.env` などの環境依存は呼び出し側で注入する。
 */

/** ビルドモード等から導出したフラグ。 */
export interface BuildFlags {
  readonly mode: string;
  readonly isProduction: boolean;
  /** `bw serve` 代替経路 (localhost:8087) を host_permissions に含めるか。本番は常に false。 */
  readonly includeBwServe: boolean;
}

/** `resolveBuildFlags` の入力。`env` は既定で空（テスト時に注入可能）。 */
export interface ResolveBuildFlagsInput {
  readonly mode: string;
  readonly env?: Record<string, string | undefined>;
}

const TRUTHY_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** 環境変数風の文字列を真偽に解釈する（大小文字・前後空白を無視）。 */
export function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return TRUTHY_VALUES.has(value.trim().toLowerCase());
}

/**
 * ビルドフラグを解決する。
 * `includeBwServe` は「非本番」かつ `ACS_BW_SERVE` が truthy のときのみ true（本番は常に除外）。
 */
export function resolveBuildFlags(input: ResolveBuildFlagsInput): BuildFlags {
  const env = input.env ?? {};
  const isProduction = input.mode === "production";
  const includeBwServe = !isProduction && isTruthyFlag(env["ACS_BW_SERVE"]);
  return {
    mode: input.mode,
    isProduction,
    includeBwServe,
  };
}

/**
 * manifest `key`（拡張 ID 固定用）を解決する。
 * `ACS_EXTENSION_KEY` が非空なら trim して返す。未設定・空白のみなら undefined（key を省略）。
 */
export function resolveExtensionKey(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = env["ACS_EXTENSION_KEY"];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
