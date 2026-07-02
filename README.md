# AWS Console Multi-Account Switcher

複数の AWS IAM ユーザーアカウント間のコンソール切り替えを最小化する Chrome 拡張機能（Manifest V3）。
Bitwarden Password Manager の Vault をシークレットの Single Source of Truth（SSOT）とし、ローカルの
`bw` CLI を Native Messaging ホスト経由でラップしてオンデマンドにシークレットを取得する。

> 本ツールは IAM ユーザー運用時の**暫定措置**であり、恒久的なベストプラクティスではない。
> 設計の詳細は [`.kiro/specs/aws-console-switcher/`](./.kiro/specs/aws-console-switcher/) を参照。

## モノレポ構成（npm workspaces）

| パッケージ | 役割 |
| --- | --- |
| [`packages/shared`](./packages/shared) (`@acs/shared`) | 全ポート境界で共有する契約: `Result` / 型付きエラー、非秘匿データモデル、拡張内メッセージ判別共用体、Native Messaging プロトコル判別共用体、`requestId` 生成/検証 |
| [`packages/extension`](./packages/extension) (`@acs/extension`) | Chrome MV3 拡張（Service Worker / Content Scripts / Popup）。Vite + `@crxjs/vite-plugin` でビルド |
| [`packages/native-host`](./packages/native-host) (`@acs/native-host`) | Native Messaging ホスト（`bw` CLI ラッパー）。Node.js/TypeScript 前提の**土台のみ**（本体は task 2 で実装） |

秘匿境界（最重要）: パスワード・マスターパスワード・TOTP シード/コード・`BW_SESSION` は
`@acs/shared` のどのデータモデル型にも存在せず、拡張・`chrome.storage` にも永続化しない。
`bw serve` 代替経路は本番ビルドから構造的に除外される（下記フラグ参照）。

## 必要環境

- Node.js `>=20`（開発検証は Node 26 系）
- npm 11 系（workspaces）

## セットアップとコマンド

```sh
npm install            # 依存解決 + ワークスペースのリンク

npm run build          # @acs/shared → @acs/extension の順にビルド
npm test               # 全ワークスペースのユニットテスト（vitest）
npm run typecheck      # 全ワークスペースの型チェック（tsc, strict）
```

パッケージ個別に実行する場合は `-w @acs/<pkg>` を付ける（例: `npm run build -w @acs/extension`）。

## ビルド時フラグ

拡張の `manifest.json` は `@crxjs/vite-plugin` の `defineManifest((env) => ...)` によりビルド時に生成し、
以下の環境変数で出し分ける（純粋関数 `packages/extension/src/build/manifest-flags.ts` が解決し、
ユニットテストで検証済み）。

### 1. 拡張 ID 固定用 `key` フィールド（`ACS_EXTENSION_KEY`）

開発時の unpacked 拡張は ID が変動しうる。ネイティブホスト manifest の `allowed_origins`
（`chrome-extension://<id>/`）と一致させ続けるため、`manifest.json` の `key` フィールドで拡張 ID を固定する。

```sh
# 開発用に拡張 ID を固定してビルド（<BASE64_PUBLIC_KEY> は開発鍵の公開鍵 Base64）
ACS_EXTENSION_KEY="<BASE64_PUBLIC_KEY>" npm run build:dev -w @acs/extension
```

- `ACS_EXTENSION_KEY` が設定されていれば `manifest.key` に注入される。
- 未設定なら `key` は省略され、本番（CRX / Web Store）では**ストアが割り当てる固定 ID** を用いる。
- 手順: Chrome で一度 unpacked ロード → 生成された ID に対応する公開鍵を `key` に設定、
  またはローカルで鍵ペアを生成し公開鍵の Base64（PEM ヘッダ除去）を `ACS_EXTENSION_KEY` に渡す。
  確定した固定 ID をネイティブホスト manifest の `allowed_origins` に登録する（PoC #1 で疎通確認）。

### 2. `bw serve` 代替経路の `http://localhost:8087`（`ACS_BW_SERVE`）

`bw serve`（ローカル REST API）は DNS リバインディングリスクを伴う**開発/デバッグ専用の代替経路**。
本番の第一候補は Native Messaging であり、`localhost:8087` の `host_permission` は本番から必ず除外する。

```sh
# localhost:8087 を含める（非本番ビルドかつ明示有効化時のみ）
ACS_BW_SERVE=1 npm run build:dev -w @acs/extension
```

| ビルドモード | `ACS_BW_SERVE` | `localhost:8087` の host_permission |
| --- | --- | --- |
| production (`npm run build`) | 任意（無視） | **常に除外** |
| development (`npm run build:dev`) | 未設定 / falsy | 除外（既定） |
| development (`npm run build:dev`) | `1`/`true`/`yes`/`on` | 含める |

## セキュリティ / 権限

- CSP: リモートコード（`eval`）を排除する厳格 CSP（`script-src 'self'; object-src 'self'`）。
- 権限は最小構成: `nativeMessaging` / `storage` / `tabs` / `scripting` / `alarms`（`cookies` は不要）。
- Popup から `localhost` への直接 `fetch` は禁止。通信は必ず Service Worker 経由。

## ライセンス

MIT
