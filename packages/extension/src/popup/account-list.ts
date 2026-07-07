/**
 * Popup アカウント一覧ロジック（task 7.1, requirements 3.1）。
 *
 * 非秘匿メタデータ（`AccountMeta`）と拡張が記録したサインイン状態（`SessionRecord`）を
 * 結合し、インクリメンタルサーチで絞り込み、控えめな状態表示を導く純粋関数群。
 * DOM/ブラウザに依存せず単体テスト可能に保つ（DOM 配線は popup.ts の責務）。
 */
import type { AccountMeta, SessionRecord } from "@acs/shared";

/** アカウントメタデータと既知のセッション状態を結合した一覧アイテム。 */
export interface AccountListItem {
  readonly meta: AccountMeta;
  /** 対応する `SessionRecord`。記録が無い（＝状態不明）の場合は未設定。 */
  readonly session?: SessionRecord;
}

/**
 * アカウント一覧に既知のセッション記録を `uuid` で結合する。
 * アカウント順は保持し、対応する記録が無いアカウントは `session` 未設定のまま返す。
 */
export function mergeAccountsWithSessions(
  accounts: readonly AccountMeta[],
  sessions: readonly SessionRecord[],
): readonly AccountListItem[] {
  const sessionByUuid = new Map<string, SessionRecord>();
  for (const record of sessions) {
    sessionByUuid.set(record.uuid, record);
  }
  return accounts.map((meta) => {
    const session = sessionByUuid.get(meta.uuid);
    // exactOptionalPropertyTypes 準拠: session 未存在時は `session` キー自体を付与しない。
    return session === undefined ? { meta } : { meta, session };
  });
}

/**
 * エイリアス・アカウント ID・IAM ユーザー名に対する大文字小文字非依存の部分一致で
 * 一覧を絞り込む（requirements 3.1 インクリメンタルサーチ）。
 * クエリが空・空白のみの場合は全件を絞り込まずに返す。
 */
export function filterAccounts(
  items: readonly AccountListItem[],
  query: string,
): readonly AccountListItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return items;
  }
  return items.filter((item) => {
    const { alias, accountId, username } = item.meta;
    const haystacks = [alias ?? "", accountId, username];
    return haystacks.some((field) => field.toLowerCase().includes(needle));
  });
}

/** 一覧に表示するセッション状態の 3 区分。 */
export type SessionStateLabel = "signed-in" | "unknown" | "not-signed-in";

/**
 * 一覧アイテムから控えめな状態ラベルを導く（requirements 3.1 陳腐化対策）。
 *
 * - `active`: 拡張の記録と console 検出が矛盾しない → "signed-in"。
 * - `stale` / `unknown`: 確証が得られない → "unknown"（誤った「ログイン済み」表示を避ける）。
 * - セッション記録なし: "not-signed-in"。
 *
 * 保守的方針: 確証の無い状態を "signed-in" と表示してはならない。
 */
export function describeSessionState(item: AccountListItem): SessionStateLabel {
  const session = item.session;
  if (session === undefined) {
    return "not-signed-in";
  }
  return session.state === "active" ? "signed-in" : "unknown";
}
