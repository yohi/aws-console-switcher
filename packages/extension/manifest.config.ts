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
