# Product: AWS Console Multi-Account Switcher

## Purpose

A Chrome extension (Manifest V3) that minimizes context-switching between multiple AWS IAM user console accounts. It automates the AWS Management Console sign-in flow using a **Bitwarden Password Manager Vault as the Single Source of Truth (SSOT)** for credentials. Positioned as an **interim measure** for static IAM-user operations, with a pluggable auth layer for future migration to AssumeRole or IAM Identity Center (SSO).

## Core Capabilities

- **Account List & State UI:** Popup lists switchable accounts (alias, account ID, IAM user) with incremental search and a "currently signed-in" indicator.
- **Automated Sign-in Flow:** Routing → account ID (conditional) → username/password → MFA/TOTP (conditional), driven by DOM detection rather than fixed timing.
- **Bitwarden Vault Integration:** Secrets fetched on-demand from the Vault via a local `bw` CLI wrapped by a Native Messaging host (no cloud-API decryption path exists).
- **Multi-Session Coexistence:** Keeps up to 5 AWS sessions signed in simultaneously and brings the target to the foreground (LRU eviction beyond 5).
- **Secret Volatility:** Passwords and TOTP seeds/codes are never persisted; fetched per injection step and discarded immediately. Only non-secret metadata is cached.

## Target Use Cases

Engineers who operate many AWS IAM user accounts and switch consoles frequently, while keeping credentials centralized in Bitwarden.

## Value Proposition

Near zero-touch login (single unlock per active-use window) with secrets centralized in Bitwarden, structurally avoiding TCP port exposure and DNS-rebinding risk via Native Messaging, and a pluggable architecture that survives a future move to SSO.

---

*Interim measure for IAM-user operations; not a permanent best practice (see requirements §1).*
