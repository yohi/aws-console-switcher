# Tech Stack & Standards

## Architecture

Manifest V3 Chrome extension composed of a **stateless Service Worker proxy**, **Content Scripts** (per sign-in step), and a **Popup**, communicating over `chrome.runtime` messaging. Secrets are retrieved through a **Native Messaging host** that wraps the Bitwarden CLI (`bw`) and holds `BW_SESSION` in its own process only. Network ports are not exposed (stdio message passing).

## Core Technologies

- **Platform:** Chrome Extension, Manifest V3 (Service Worker, Content Scripts, Popup/Action)
- **Extension Language:** TypeScript (strict; recommended)
- **Native Host:** Local process wrapping the `bw` CLI — runtime (Node.js / Python) to be confirmed in PoC #1
- **Secret Store:** Bitwarden Password Manager Vault via `bw` CLI (`bw get item|totp`, `bw list items --folderid`)
- **MFA / TOTP:** `bw get totp`, or in-extension generation via Web Crypto (HMAC-SHA1, RFC 6238)

## Key Decisions (requirements §7, all confirmed)

- **D-1 Secret path:** Native Messaging first; `bw serve` only as a dev/debug fallback (DNS-rebinding risk).
- **D-2 Sessions:** Plan B — multiple concurrent sessions (max 5); `chrome.cookies` not required.
- **D-3 Unlock:** Method 1 (popup → host `bw unlock --passwordenv`) + host-side idle auto-lock (default 15–30 min).
- **D-4 Scope:** Personal use = Bitwarden folder (`--folderid`).
- **D-5 Data model:** Custom fields `aws_account_id` (required) / `aws_account_alias` (optional); default folder `AWS Accounts`; `URI` = sign-in URL.
- **MV3 lifecycle:** Service Worker treated as ephemeral → stateless, per-step on-demand fetch (no in-SW flow state).

## Development Standards

- **Type Safety:** TypeScript strict mode; no `any`; validate inputs at boundaries (DOM, native messages).
- **Security / CSP:** No remote code (`eval`); strict MV3 CSP; Popup must not `fetch` localhost directly (route via SW).
- **Least Privilege:** `permissions` = nativeMessaging, storage, tabs, scripting, alarms (no cookies).
- **Secret Handling:** Never persist password/TOTP; discard immediately after injection.

## Permissions (manifest, provisional — requirements §4.1)

`permissions`: nativeMessaging, storage, tabs, scripting, alarms.

`host_permissions`: `https://signin.aws.amazon.com/*`, `https://*.signin.aws.amazon.com/*`, `https://console.aws.amazon.com/*` (and `http://localhost:8087/*` only if the `bw serve` fallback is adopted).

---

*Document standards and decisions, not every dependency.*
