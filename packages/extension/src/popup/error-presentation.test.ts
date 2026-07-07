/**
 * Popup エラー表示ロジック（失敗 3 分類の行動可能な通知）のユニットテスト
 * （task 7.2, requirements 3.5 / design.md「Error Categories and Responses」）。
 *
 * DOM 非依存の純粋関数 `presentError` のみを対象とする。
 */
import { describe, expect, it } from "vitest";
import { makeFlowError } from "@acs/shared";
import { presentError } from "./error-presentation.js";

describe("presentError - precondition (a)", () => {
  it("guides to unlock for a locked vault", () => {
    const p = presentError(makeFlowError("vault_locked", "locked"));
    expect(p.action).toBe("アンロック");
    expect(p.headline).toContain("アンロック");
    expect(p.headline.length).toBeGreaterThan(0);
  });

  it("guides to terminal bw login when the CLI is not logged in", () => {
    const p = presentError(makeFlowError("bw_not_logged_in", "no login"));
    expect(p.action).toBe("手動ログインを継続");
    expect(p.headline).toContain("bw login");
  });

  it("guides to start the native host when it is not running", () => {
    const p = presentError(makeFlowError("host_not_running", "no host"));
    expect(p.action).toBe("ホストを起動");
    expect(p.headline).toContain("ホスト");
  });

  it("guides to reconnect when the native host disconnected", () => {
    const p = presentError(makeFlowError("host_disconnected", "gone"));
    expect(p.action).toBe("再接続");
    expect(p.headline).toContain("接続");
  });
});

describe("presentError - aws_auth (b)", () => {
  it("mentions automatic retry for a retriable totp rejection", () => {
    const error = makeFlowError("totp_rejected", "reused");
    expect(error.retriable).toBe(true);
    const p = presentError(error);
    expect(p.headline).toContain("自動");
    expect(p.headline).toContain("再試行");
    expect(p.action).toBe("自動再試行中");
  });

  it("falls back to manual check when a totp rejection is no longer retriable", () => {
    const error = makeFlowError("totp_rejected", "exhausted", {
      retriable: false,
    });
    const p = presentError(error);
    expect(p.action).toBe("手動確認");
  });

  it("stops and notifies on a bad password", () => {
    const p = presentError(makeFlowError("bad_password", "wrong"));
    expect(p.action).toBe("手動確認");
    expect(p.headline).toContain("パスワード");
  });

  it("stops and notifies on an account lockout", () => {
    const p = presentError(makeFlowError("account_locked", "locked out"));
    expect(p.action).toBe("手動確認");
    expect(p.headline).toContain("ロック");
  });
});

describe("presentError - dom_timeout (c)", () => {
  it("falls back to manual login when selectors are not found", () => {
    const p = presentError(makeFlowError("selector_not_found", "no match"));
    expect(p.action).toBe("手動ログインへ切替");
    expect(p.headline).toContain("手動");
  });

  it("falls back to manual login when the page did not render", () => {
    const p = presentError(makeFlowError("page_not_rendered", "blank"));
    expect(p.action).toBe("手動ログインへ切替");
    expect(p.headline).toContain("手動");
  });
});

describe("presentError - invariants", () => {
  it("always returns non-empty headline and action strings", () => {
    for (const code of [
      "vault_locked",
      "bw_not_logged_in",
      "host_not_running",
      "host_disconnected",
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
    ] as const) {
      const p = presentError(makeFlowError(code, "msg"));
      expect(p.headline.length).toBeGreaterThan(0);
      expect(p.action.length).toBeGreaterThan(0);
    }
  });
});
