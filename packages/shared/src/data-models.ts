/**
 * `chrome.storage.local` に永続化する **非秘匿** データ構造（design.md「Logical Data Model」,
 * requirements 3.1 / 3.4 / 5, 2.2）。
 *
 * 秘匿境界（最重要）:
 * ここで定義するどの型にも **パスワード・マスターパスワード・TOTP シード/コード・BW_SESSION**
 * を表すフィールドは存在しない。秘匿値は取得の都度の揮発値としてのみ扱い、ドメインモデル/
 * ストレージには一切保持しない（requirements 3.3, 4.1.1, design.md「秘匿境界」）。
 * この不変条件は型レベルで担保され、tsc により継続的に検証される。
 */

/** ログイン自動化フローの永続ステップ（in-flight のみ。`idle`/`done`/`failed` は永続化しない）。 */
export type FlowStep =
  | "routing"
  | "awaiting_account_id"
  | "awaiting_credentials"
  | "awaiting_mfa";

/**
 * セッション記録の実態整合ステータス（design.md SessionRecord）。
 * - `active`: 拡張がログイン記録し、console 検出とも矛盾なし
 * - `stale`: console 検出でサインアウト/失効を確認
 * - `unknown`: タブ無し等で確証が得られない（控えめ表示, 3.1）
 */
export type SessionState = "active" | "stale" | "unknown";

/**
 * Bitwarden アイテムに対応する非秘匿メタデータ（design.md AccountMeta, 3.4）。
 * パスワード・TOTP シードは **含まない**（含めてはならない）。
 */
export interface AccountMeta {
  /** Bitwarden アイテム UUID。`bw get item/totp <uuid>` に用いる。 */
  readonly uuid: string;
  /** 12 桁 AWS アカウント ID（カスタムフィールド `aws_account_id`）。 */
  readonly accountId: string;
  /** エイリアス（カスタムフィールド `aws_account_alias`, 任意）。 */
  readonly alias?: string;
  /** 表示用 IAM ユーザー名（標準 `Username`）。表示専用であり認証には都度取得する。 */
  readonly username: string;
  /** サインイン URL（標準 `URI`, 任意）。 */
  readonly signInUrl?: string;
  /** TOTP シード有無から導出。再同期で更新（後付け MFA を反映）。 */
  readonly mfaEnabled: boolean;
}

/**
 * 拡張が記録するサインイン状態（design.md SessionRecord, 3.2.1）。
 * 最大 5 セッション併存・前面化・LRU 退避の基準に用いる。
 */
export interface SessionRecord {
  readonly uuid: string;
  readonly accountId: string;
  /** 前面化対象タブ（C-3）。閉鎖時は switchTo で再ログインへフォールバック。 */
  readonly tabId: number;
  /** サインイン時刻（ISO 8601）。 */
  readonly signedInAt: string;
  /** 最終アクセス時刻（ISO 8601）。LRU 退避の基準（M-6）。 */
  readonly lastAccessedAt: string;
  readonly state: SessionState;
}

/**
 * フロー状態（design.md FlowContext, 2.2 / C-1）。`tabId` をキーに `chrome.storage.local` へ保存し、
 * MV3 Service Worker 再起動をまたいで復元する。
 */
export interface FlowContext {
  readonly tabId: number;
  readonly uuid: string;
  readonly step: FlowStep;
  /** フロー開始時刻（ISO 8601）。dom_timeout 判定の起点。 */
  readonly startedAt: string;
  /** awaiting_mfa の getTotp 再発行回数。SW 再起動をまたいで上限（既定 1）を判定（Issue 2）。 */
  readonly mfaRetryCount: number;
}

/**
 * AWS サインイン各ステップ・認証エラー・コンソール検出の CSS セレクタ集合（design.md SelectorSet, 5）。
 * 各配列は順序付きフォールバックで適用する。具体値は PoC #4/#5 で確定し既定値として同梱（task 5.1）。
 */
export interface SelectorSet {
  /** semver。同梱既定値と設定上書きを比較し新しい方を採用（m-3）。 */
  readonly version: string;
  readonly accountIdInput: readonly string[];
  readonly usernameInput: readonly string[];
  readonly passwordInput: readonly string[];
  readonly mfaInput: readonly string[];
  readonly submitButton: readonly string[];
  /** 認証失敗 DOM マーカー（M-4）。 */
  readonly authErrorMarker: readonly string[];
  /** ログイン後コンソール検出マーカー。 */
  readonly consoleReadyMarker: readonly string[];
}

/**
 * 拡張設定（design.md ExtensionSettings）。秘匿値は含まない。
 * NativeHost へは `configure` メッセージで `idleLockMinutes` / `totpMinRemainingSeconds` のみ伝達する。
 */
export interface ExtensionSettings {
  /** 対象フォルダ名。既定 "AWS Accounts"。 */
  readonly folderName: string;
  /** `listFolders` で解決しキャッシュしたフォルダ ID（M-3, 任意）。 */
  readonly folderId?: string;
  /** アイドル自動ロック分数。既定 20、許容範囲 1〜120（m-2）。 */
  readonly idleLockMinutes: number;
  /** TOTP 最小残秒数の閾値。既定 5、許容範囲 5〜10（3.2 Step 3）。 */
  readonly totpMinRemainingSeconds: number;
  readonly selectors: SelectorSet;
}

/**
 * 値が `AccountMeta` の形をしているか判定する型ガード。
 * Native Messaging の `items` 応答（AccountMeta[]）を SW 境界で検証する用途。
 * 秘匿フィールド（password / totpSeed）は型に存在しないため検証対象にもならない。
 */
export function isAccountMeta(value: unknown): value is AccountMeta {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const meta = value as Record<string, unknown>;
  return (
    typeof meta["uuid"] === "string" &&
    typeof meta["accountId"] === "string" &&
    typeof meta["username"] === "string" &&
    typeof meta["mfaEnabled"] === "boolean" &&
    (!("alias" in meta) || typeof meta["alias"] === "string") &&
    (!("signInUrl" in meta) || typeof meta["signInUrl"] === "string")
  );
}
