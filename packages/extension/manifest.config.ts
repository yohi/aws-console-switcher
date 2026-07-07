import { defineManifest } from "@crxjs/vite-plugin";
import {
  resolveBuildFlags,
  resolveExtensionKey,
} from "./src/build/manifest-flags.js";

/** サインイン系ホスト（汎用エントリ + アカウント別 URL）。requirements 4.1。 */
const SIGNIN_MATCHES = [
  "https://signin.aws.amazon.com/*",
  "https://*.signin.aws.amazon.com/*",
];
/** ログイン後コンソール（現ログイン状態の検出用）。 */
const CONSOLE_HOST = "https://console.aws.amazon.com/*";
/** `bw serve` 代替経路。本番ビルドからは常に除外される（2.1.2, 9.2）。 */
const BW_SERVE_HOST = "http://localhost:8087/*";

/**
 * MV3 manifest をビルドモードに応じて出し分ける（design.md「Build & Deployment Notes」）。
 * - `key`: `ACS_EXTENSION_KEY` があれば拡張 ID を固定（ネイティブホスト manifest の
 *   `allowed_origins` と一致させるため。README 参照, m-7）。
 * - `host_permissions`: `localhost:8087` は非本番かつ `ACS_BW_SERVE` 有効時のみ含める。
 * - CSP: リモートコード（`eval`）を排除する厳格 CSP（4.1）。
 */
export default defineManifest((env) => {
  const flags = resolveBuildFlags({ mode: env.mode, env: process.env });
  const key = resolveExtensionKey(process.env);

  const hostPermissions = [...SIGNIN_MATCHES, CONSOLE_HOST];
  if (flags.includeBwServe) {
    hostPermissions.push(BW_SERVE_HOST);
  }

  return {
    manifest_version: 3,
    name: "AWS Console Switcher",
    version: "0.1.0",
    description:
      "Switch between multiple AWS IAM console accounts, using a Bitwarden Vault as the credential SSOT via a Native Messaging host.",
    // 開発時の unpacked 拡張 ID を固定するための key（未設定なら Web Store 固定 ID を用いる）。
    ...(key !== undefined ? { key } : {}),
    // 最小権限（cookies は含めない, D-2）。
    permissions: ["nativeMessaging", "storage", "tabs", "scripting", "alarms"],
    host_permissions: hostPermissions,
    background: {
      service_worker: "src/service-worker/service-worker.ts",
      type: "module",
    },
    // NOTE(task 5.3, 実装済み): console-detector-content-script.ts の検出ロジックは
    // content_scripts/web_accessible_resources には列挙しない。SW の
    // service-worker/console-state-detector.ts が `chrome.scripting.executeScript` の **func 方式**
    // （`func` + `args`）で自己完結関数（`injectableDetectConsoleState`）を対象タブへ直接注入する。
    // 選定理由: `func` は Chrome によりコード自体がシリアライズされ対象ページの孤立ワールドで評価されるため
    // dist に存在するファイルを作る必要がなく（files 方式とは違い）、
    // @crxjs/vite-plugin の web_accessible_resources・追加ビルドエントリ配線を一切必要としない。
    // この選定により、旧 TODO（task 5.3 定義時および task 9.2 調査時の web_accessible_resources
    // 未配線の指摘）は解消した。詳細は console-state-detector.ts のファイル先頭コメントを参照。
    content_scripts: [
      {
        matches: SIGNIN_MATCHES,
        js: ["src/content-scripts/signin-content-script.ts"],
        run_at: "document_idle",
      },
    ],
    action: {
      default_popup: "src/popup/popup.html",
      default_title: "AWS Console Switcher",
    },
    // リモートコード（eval）を排除する厳格 CSP（4.1）。
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
});
