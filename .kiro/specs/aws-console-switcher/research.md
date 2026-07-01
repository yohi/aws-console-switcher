# Research & Design Decisions: AWS Console Multi-Account Switcher

---

**Purpose**: 設計判断の根拠となる調査結果・トレードオフ・参照を記録する。詳細比較を design.md から分離して保持する。

---

## Summary

- **Feature**: `aws-console-switcher`
- **Discovery Scope**: New Feature（greenfield）。ただし発見的調査の大半は要件定義書 v6 のセルフレビュー（Oracle 独立レビュー × 3 弾）と一次情報調査で完了済み。本ログはその要約と設計時決定を記録する。
- **Key Findings**:
  - 拡張からクラウド API で Vault を直接復号する経路は存在せず、ローカル複合化クライアント（`bw`）経由が必須。
  - MV3 Service Worker は数十秒で終了しうるため、フロー状態を SW メモリに保持する設計は破綻する。
  - AWS は 1 ブラウザで最大 5 識別情報を同時サインイン可能で、"switcher" の意図に複数セッション併存が合致する。

## Research Log

### シークレット取得経路

- **Context**: 拡張が Bitwarden Vault のシークレットを安全に取得する経路の選定。
- **Sources Consulted**: Bitwarden CLI / Serve Mode / Encrypted Data ドキュメント、Chrome Native Messaging（要件 付録A）。
- **Findings**: Vault 復号は認証済みローカルクライアントに限定。Native Messaging は TCP ポートを公開せず `allowed_origins` で拡張 ID 限定が可能。`bw serve` は `--disable-origin-protection` が必要となり DNS リバインド防衛線を無効化する。
- **Implications**: Native Messaging を第一経路（`SecretSourceAdapter` 既定実装）、`bw serve` は開発/デバッグ代替に降格（C-1）。

### MV3 Service Worker ライフサイクル

- **Context**: 複数ページ遷移をまたぐログインフローの状態管理。
- **Sources Consulted**: Chrome Service worker lifecycle（付録A）。
- **Findings**: SW はアイドルで終了されうる。遷移合間の終了はサイレント失敗を招く。
- **Implications**: SW はステートレス・プロキシとし、フロー状態は `chrome.storage.local` の `FlowContext`（tabId キー）で永続化し SW 再起動耐性を持たせる（Oracle C-1 反映）。各ステップは都度取得。これは要件 §2.2 の「CS＋URL パターンで管理」を、再起動耐性のため非秘匿メタデータとして storage.local に置く形で精綻化したもの。

### TOTP シード形式

- **Context**: 拡張内 TOTP 生成のパース仕様確定。
- **Findings**: `bw get item` の `login.totp` が otpauth URI か Base32 かは未確定。
- **Implications**: PoC #6 で確認。Web Crypto（HMAC-SHA1, RFC 6238）実装はパーサを抽象化。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
| --- | --- | --- | --- | --- |
| Native Messaging | ホストが `bw` をラップし stdio 通信 | ポート非公開・拡張 ID 限定・DNS リバインド構造的回避 | ホスト登録・OS 別 manifest 配置が必要 | 採用（第一候補, 2.1） |
| bw serve | ローカル REST API（localhost:8087） | `fetch` で手軽 | Origin 保護無効化で DNS リバインドリスク | 代替（開発/デバッグ, 2.1.2） |
| Secrets Manager | machine account + token で KV 取得 | — | ログイン項目・TOTP 不可、SSOT 崩壊 | 不採用（2.1） |
| クラウド API 直接 | 拡張から直接復号 | — | 技術的に不可能 | 不採用（2.1） |

## Design Decisions

### Decision: ステートレス・プロキシ＋オンデマンド取得

- **Context**: MV3 SW のライフサイクル制約。
- **Selected Approach**: SW は状態を持たず中継のみ。各 Content Script ステップが DOM 検知時点で SW 経由に値を要求し注入後破棄。
- **Rationale**: SW 終了に耐性を持つ唯一の堅牢策。秘匿揮発性要件とも整合。
- **Trade-offs**: 取得呼び出し回数増。ネイティブ往復の遅延は許容範囲。

### Decision: ポート＆アダプタによる将来 SSO 対応

- **Context**: 暫定ツールから恒久運用（SSO）への移行余地。
- **Selected Approach**: `CredentialProvider` / `SessionManager` / `SecretSourceAdapter` で分離。
- **Rationale**: 認証フロー差し替えを実装注入で完結（4.2）。
- **Trade-offs**: 初期の抽象化コスト。境界が明確になりテスト容易性が向上。

### Decision: 型付きエラー（Result + FailureCategory）

- **Context**: 3.5 の 3 分類を一貫して扱う必要。
- **Selected Approach**: `Result<T, FlowError>` と `category` 判別共用体。
- **Rationale**: 例外送出を避け型安全に UX 分岐。再試行可否を `retriable` で明示。

## Risks & Mitigations

- AWS サインイン DOM 変更 — `SelectorSet` 順序付きフォールバック＋設定ファイル動的更新（6 #5）。
- MFA 実効退化 — 方式1＋アイドル自動ロックでアンロック窓に限定。暫定前提で受容（4.1.2）。
- `bw serve` 採用時の DNS リバインド — `localhost` 限定バインド・リスク受容明記（2.1.2）。
- UUID 陳腐化 — 真欠落のみ無効化、一時エラーはキャッシュ保持（S-3）。

## References

- Bitwarden CLI / Serve Mode / Encrypted Data / Secrets Manager FAQ — 要件定義書 付録A
- AWS IAM ユーザーサインイン / 最大5識別情報 / MFA sign-in — 要件定義書 付録A
- Chrome Native messaging / Service worker lifecycle — 要件定義書 付録A
