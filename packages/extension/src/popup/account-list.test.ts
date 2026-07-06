/**
 * Popup アカウント一覧ロジック（メタデータとセッション状態の結合・インクリメンタル
 * サーチ・状態表示）のユニットテスト（task 7.1, requirements 3.1）。
 *
 * DOM/ブラウザ非依存の純粋関数のみを対象とする（popup.ts の DOM 配線は対象外）。
 */
import { describe, expect, it } from "vitest";
import type { AccountMeta, SessionRecord } from "@acs/shared";
import {
  type AccountListItem,
  describeSessionState,
  filterAccounts,
  mergeAccountsWithSessions,
} from "./account-list.js";

/** テスト用 AccountMeta を最小フィールドから生成する。 */
function meta(overrides: Partial<AccountMeta> & { uuid: string }): AccountMeta {
  return {
    accountId: "123456789012",
    username: "iam-user",
    mfaEnabled: false,
    ...overrides,
  };
}

/** テスト用 SessionRecord を最小フィールドから生成する。 */
function session(
  overrides: Partial<SessionRecord> & {
    uuid: string;
    state: SessionRecord["state"];
  },
): SessionRecord {
  return {
    accountId: "123456789012",
    tabId: 1,
    signedInAt: "2026-07-06T00:00:00.000Z",
    lastAccessedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeAccountsWithSessions", () => {
  it("attaches a session to the account with the matching uuid", () => {
    const accounts = [meta({ uuid: "11111111-1111-1111-1111-111111111111" })];
    const sessions = [
      session({
        uuid: "11111111-1111-1111-1111-111111111111",
        state: "active",
      }),
    ];
    const items = mergeAccountsWithSessions(accounts, sessions);
    expect(items).toHaveLength(1);
    expect(items[0]?.meta.uuid).toBe("11111111-1111-1111-1111-111111111111");
    expect(items[0]?.session?.state).toBe("active");
  });

  it("leaves session undefined when no session matches the account uuid", () => {
    const accounts = [meta({ uuid: "11111111-1111-1111-1111-111111111111" })];
    const sessions = [
      session({
        uuid: "22222222-2222-2222-2222-222222222222",
        state: "active",
      }),
    ];
    const items = mergeAccountsWithSessions(accounts, sessions);
    expect(items).toHaveLength(1);
    expect(items[0]?.session).toBeUndefined();
  });

  it("preserves account order and joins each by uuid independently", () => {
    const accounts = [
      meta({ uuid: "11111111-1111-1111-1111-111111111111" }),
      meta({ uuid: "22222222-2222-2222-2222-222222222222" }),
    ];
    const sessions = [
      session({
        uuid: "22222222-2222-2222-2222-222222222222",
        state: "stale",
      }),
    ];
    const items = mergeAccountsWithSessions(accounts, sessions);
    expect(items[0]?.session).toBeUndefined();
    expect(items[1]?.session?.state).toBe("stale");
  });

  it("returns an empty list when there are no accounts", () => {
    expect(mergeAccountsWithSessions([], [])).toEqual([]);
  });
});

describe("filterAccounts", () => {
  const items: readonly AccountListItem[] = [
    { meta: meta({ uuid: "a", alias: "prod-web", username: "alice" }) },
    { meta: meta({ uuid: "b", accountId: "999900001111", username: "bob" }) },
    { meta: meta({ uuid: "c", alias: "staging", username: "carol-admin" }) },
  ];

  it("returns all items unfiltered for an empty query", () => {
    expect(filterAccounts(items, "")).toHaveLength(3);
  });

  it("returns all items unfiltered for a whitespace-only query", () => {
    expect(filterAccounts(items, "   ")).toHaveLength(3);
  });

  it("matches on alias (case-insensitive substring)", () => {
    const result = filterAccounts(items, "PROD");
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.uuid).toBe("a");
  });

  it("matches on accountId (substring)", () => {
    const result = filterAccounts(items, "9999");
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.uuid).toBe("b");
  });

  it("matches on username (case-insensitive substring)", () => {
    const result = filterAccounts(items, "CAROL");
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.uuid).toBe("c");
  });

  it("trims the query before matching", () => {
    const result = filterAccounts(items, "  staging  ");
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.uuid).toBe("c");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterAccounts(items, "nonexistent")).toHaveLength(0);
  });

  it("does not throw when alias is absent and query targets other fields", () => {
    const result = filterAccounts(items, "bob");
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.uuid).toBe("b");
  });
});

describe("describeSessionState", () => {
  it("reports signed-in only for an active session", () => {
    const item: AccountListItem = {
      meta: meta({ uuid: "a" }),
      session: session({ uuid: "a", state: "active" }),
    };
    expect(describeSessionState(item)).toBe("signed-in");
  });

  it("reports unknown for a stale session (conservative, never falsely signed-in)", () => {
    const item: AccountListItem = {
      meta: meta({ uuid: "a" }),
      session: session({ uuid: "a", state: "stale" }),
    };
    expect(describeSessionState(item)).toBe("unknown");
  });

  it("reports unknown for an unknown-state session", () => {
    const item: AccountListItem = {
      meta: meta({ uuid: "a" }),
      session: session({ uuid: "a", state: "unknown" }),
    };
    expect(describeSessionState(item)).toBe("unknown");
  });

  it("reports not-signed-in when there is no session", () => {
    const item: AccountListItem = { meta: meta({ uuid: "a" }) };
    expect(describeSessionState(item)).toBe("not-signed-in");
  });
});
