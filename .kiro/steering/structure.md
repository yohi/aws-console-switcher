# Project Structure

> **Status:** Greenfield — no implementation yet. This describes the *intended* organization derived from requirements §4.2 (pluggable architecture). Update once code lands.

## Organization Philosophy

Separate the **what** (credential source) from the **how** (login automation) behind interfaces, so the secret-retrieval path and the session/login logic can each be swapped without touching the other. This enables a future move from IAM-user + Bitwarden to IAM Identity Center (SSO) by replacing implementations, not the structure.

## Intended Components / Boundaries

- **Extension (MV3):** Service Worker (stateless message router / proxy), Content Scripts (sign-in step handlers + console state detector), Popup (account list / search / state / unlock entry).
- **Native Host:** `bw` CLI wrapper, session/unlock manager, idle auto-lock timer. Sole holder of `BW_SESSION`.
- **Shared contracts:** message protocol (Popup ↔ SW ↔ Native Host), DOM selector config, non-secret metadata cache schema.

## Key Abstractions (requirements §4.2)

- **CredentialProvider:** retrieves IAM credentials/metadata (Bitwarden today; SSO later).
- **SessionManager:** performs/observes login + multi-session foreground/eviction.
- **SecretSourceAdapter:** swappable transport for secret retrieval (Native Messaging today; `bw serve` fallback).

## Conventions (proposed)

- **Files:** kebab-case (`session-manager.ts`); descriptive suffixes (`-service`, `-adapter`, `-store`).
- **Type Safety:** TypeScript strict; interface-first for the three abstractions above.

---

*Patterns over file trees. New code following these boundaries shouldn't require steering updates.*
