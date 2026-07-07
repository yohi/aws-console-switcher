/**
 * Popup の SW 応答境界関数（`extractSessions`）のユニットテスト（task 5.3/8.1）。
 *
 * `extractAccounts` と同じ規約（ガード付き境界関数、DOM/ブラウザ非依存）で、SW の
 * `listAccounts`/`syncAccounts` 応答値から健全な `SessionRecord[]` のみを取り出すことを検証する。
 * さらに、抽出結果が `mergeAccountsWithSessions`（account-list.ts, 既存テスト済み）へ実際に
 * 供給され、アカウント一覧アイテムへ正しく結合されることを検証する（EMPTY_SESSIONS 決め打ちの撤去）。
 */
import { describe, expect, it } from "vitest";
import type { AccountMeta, SessionRecord } from "@acs/shared";
import { mergeAccountsWithSessions } from "./account-list.js";
import { extractSessions, isExistingSessionForegrounded } from "./popup.js";

function session(overrides: Partial<SessionRecord> & { uuid: string }): SessionRecord {
  return {
    accountId: "123456789012",
    tabId: 1,
    signedInAt: "2026-07-06T00:00:00.000Z",
    lastAccessedAt: "2026-07-06T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
}

describe("extractSessions", () => {
  it("returns an empty array when value is not an object", () => {
    expect(extractSessions(null)).toEqual([]);
    expect(extractSessions(undefined)).toEqual([]);
    expect(extractSessions("nope")).toEqual([]);
  });

  it("returns an empty array when the sessions key is missing", () => {
    expect(extractSessions({})).toEqual([]);
  });

  it("returns an empty array when the sessions key is not an array", () => {
    expect(extractSessions({ sessions: "nope" })).toEqual([]);
  });

  it("returns well-formed SessionRecord entries unchanged", () => {
    const record = session({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    expect(extractSessions({ sessions: [record] })).toEqual([record]);
  });

  it("filters out malformed entries (missing required fields)", () => {
    const record = session({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const malformed = { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    expect(extractSessions({ sessions: [record, malformed] })).toEqual([record]);
  });

  it("filters out entries with an invalid state value", () => {
    const malformed = {
      ...session({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
      state: "signed-in",
    };
    expect(extractSessions({ sessions: [malformed] })).toEqual([]);
  });
});

describe("extractSessions -> mergeAccountsWithSessions (real supply, task 5.3/8.1)", () => {
  it("supplies extracted sessions into mergeAccountsWithSessions so matching accounts get their state", () => {
    const accounts: readonly AccountMeta[] = [
      {
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        accountId: "123456789012",
        username: "admin",
        mfaEnabled: false,
      },
    ];
    const record = session({
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      state: "active",
    });

    const sessions = extractSessions({ accounts, sessions: [record] });
    const items = mergeAccountsWithSessions(accounts, sessions);

    expect(items).toHaveLength(1);
    expect(items[0]?.session?.state).toBe("active");
  });

  it("leaves items without a session (not-signed-in) when the SW response omits sessions", () => {
    const accounts: readonly AccountMeta[] = [
      {
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        accountId: "123456789012",
        username: "admin",
        mfaEnabled: false,
      },
    ];

    const sessions = extractSessions({ accounts });
    const items = mergeAccountsWithSessions(accounts, sessions);

    expect(items).toHaveLength(1);
    expect(items[0]?.session).toBeUndefined();
  });
});

describe("isExistingSessionForegrounded", () => {
  it("returns true when startLogin resolved by foregrounding an existing session ({ tabId })", () => {
    // message-router.ts の startLogin は、SessionManager.switchTo が既存セッションを前面化した場合
    // のみ `{ tabId }` を含めて返す（task 6.1）。
    expect(isExistingSessionForegrounded({ tabId: 77 })).toBe(true);
  });

  it("returns false when startLogin started a brand-new login flow (value: undefined)", () => {
    // 新規ログインフロー開始時は value: undefined を返すので inFlight へ追加すべきと判断できる。
    expect(isExistingSessionForegrounded(undefined)).toBe(false);
  });

  it("returns false for malformed/unexpected shapes (defensive boundary guard)", () => {
    expect(isExistingSessionForegrounded(null)).toBe(false);
    expect(isExistingSessionForegrounded("not-an-object")).toBe(false);
    expect(isExistingSessionForegrounded({ tabId: "77" })).toBe(false);
    expect(isExistingSessionForegrounded({})).toBe(false);
  });
});
