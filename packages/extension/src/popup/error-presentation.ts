/**
 * Popup エラー表示ロジック（task 7.2, requirements 3.5 / design.md
 * 「Error Categories and Responses」）。
 *
 * 失敗 3 分類（`precondition` / `aws_auth` / `dom_timeout`）を行動可能な通知へ写像する
 * 純粋関数。DOM に依存せず単体テスト可能に保つ（バナー描画は popup.ts の責務）。
 * 表示文言はエンドユーザー向けのため日本語で記述する（AGENTS.md 言語ポリシー）。
 */
import type { FlowError } from "@acs/shared";

/** バナーに表示する見出しと推奨アクションのラベル。 */
export interface ErrorPresentation {
  /** 状況と原因を伝えるエンドユーザー向けの見出し。 */
  readonly headline: string;
  /** 次にとるべき行動を表す短いラベル（ボタン文言等に用いる）。 */
  readonly action: string;
}

/**
 * `FlowError` を行動可能な通知へ写像する（requirements 3.5 の 3 分類 UX）。
 * カテゴリで大分岐し、`precondition` は解決手段がコードごとに異なるため細分化する。
 */
export function presentError(error: FlowError): ErrorPresentation {
  switch (error.category) {
    case "precondition":
      return presentPrecondition(error);
    case "aws_auth":
      return presentAwsAuth(error);
    case "dom_timeout":
      return presentDomTimeout(error);
    default: {
      const _exhaustive: never = error.category;
      return _exhaustive;
    }
  }
}

/**
 * (a) 前提条件エラー。ホスト起動・アンロック・`bw login` など解決手段が
 * コードで異なるため、行動可能となるようコード別に文言を出し分ける（design.md 表）。
 */
function presentPrecondition(error: FlowError): ErrorPresentation {
  switch (error.code) {
    case "vault_locked":
      return {
        headline:
          "Vault がロックされています。マスターパスワードでアンロックしてください。",
        action: "アンロック",
      };
    case "bw_not_logged_in":
      return {
        headline:
          "Bitwarden CLI にログインしていません。ターミナルで bw login を実行してください（Popup からは解決できません）。",
        action: "手動ログインを継続",
      };
    case "host_not_running":
      return {
        headline:
          "ネイティブホストが起動していません。ホストを起動してから再試行してください。",
        action: "ホストを起動",
      };
    case "host_disconnected":
      return {
        headline:
          "ネイティブホストとの接続が切れました。ホストを再接続してから再試行してください。",
        action: "再接続",
      };
    default:
      return {
        headline:
          "前提条件が満たされていません。ホストの起動とアンロック状態を確認してください。",
        action: "アンロック",
      };
  }
}

/**
 * (b) AWS 認証エラー。TOTP 拒否は次コードで 1 回のみ自動再試行し、上限超過・
 * パスワード誤り・アカウントロックはフローを停止して手動確認へ誘導する（design.md 表, M-2）。
 */
function presentAwsAuth(error: FlowError): ErrorPresentation {
  if (error.code === "totp_rejected" && error.retriable) {
    return {
      headline:
        "TOTP コードが拒否されました。残秒数を確保した次のコードで1回のみ自動的に再試行します。",
      action: "自動再試行中",
    };
  }
  switch (error.code) {
    case "bad_password":
      return {
        headline:
          "パスワードが正しくありません。認証情報を確認してから再試行してください。",
        action: "手動確認",
      };
    case "account_locked":
      return {
        headline:
          "アカウントがロックアウトされています。時間をおいて状態を確認してください。",
        action: "手動確認",
      };
    case "totp_rejected":
      return {
        headline:
          "TOTP コードが繰り返し拒否されました。自動再試行の上限に達したため手動で確認してください。",
        action: "手動確認",
      };
    default:
      return {
        headline: "AWS 認証に失敗しました。認証情報を確認してください。",
        action: "手動確認",
      };
  }
}

/**
 * (c) DOM 検知タイムアウト。既定時間で停止し、手動ログイン継続へフォールバックする
 * （requirements 3.5, design.md 表）。CAPTCHA 検知も同じ手動介入経路をとる。
 */
function presentDomTimeout(error: FlowError): ErrorPresentation {
  switch (error.code) {
    case "selector_not_found":
      return {
        headline:
          "ログイン画面の要素を検出できませんでした。手動ログインへ切り替えてください。",
        action: "手動ログインへ切替",
      };
    case "page_not_rendered":
      return {
        headline:
          "ページが所定時間内に描画されませんでした。手動ログインへ切り替えてください。",
        action: "手動ログインへ切替",
      };
    case "captcha_detected":
      return {
        headline:
          "CAPTCHA / ボット検知が発生しました。手動ログインへ切り替えて対応してください。",
        action: "手動ログインへ切替",
      };
    default:
      return {
        headline:
          "自動検知がタイムアウトしました。手動ログインへ切り替えてください。",
        action: "手動ログインへ切替",
      };
  }
}
