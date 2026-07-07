# タスク10.3「E2Eテスト（PoC連動）」実施手順書

> **本書の位置づけ**: tasks.md タスク10.3 は実際の Bitwarden Vault・AWS IAM アカウント・実 Chrome ブラウザ・
> OS へのネイティブホスト登録を要する**手動検証**であり、ユニット/統合テスト（vitest, task 10.1/10.2）で
> 代替できない。本書はその実施手順をチェックリスト化したものであり、**実装コードは変更しない**。
> 対応する検証項目は requirements.md §6「技術検証（PoC）事項」と design.md「Testing Strategy」の
> E2E（PoC 連動, 6章）節に定義された #1〜#6 に一致する。
>
> 全項目に ✅ が付いたら、tasks.md の `- [ ] 10.3` を `- [x]` に更新してよい（本書はチェックのみ、
> チェックボックスの更新自体は別途実施すること）。

## 0. 前提条件（すべての PoC の共通準備）

### 0.1 環境

- [ ] Node.js `>=20`（`package.json` `engines.node`）。開発検証は Node 26 系（README 記載）。
- [ ] Chrome（最新安定版。`chrome://version` でバージョン確認）。
- [ ] [Bitwarden CLI (`bw`)](https://bitwarden.com/help/cli/) がインストール済みで、検証用 Bitwarden
      アカウントに `bw login` 済み（`bw login --check` で確認）。
- [ ] **検証専用**の AWS IAM ユーザー（最低1、複数セッション検証用に理想は2〜3）が用意されている。
      本番用アカウントでの検証は避ける。

### 0.2 Bitwarden Vault のデータモデル準備（requirements.md §3.4 / D-4 / D-5）

- [ ] フォルダ名 `AWS Accounts`（既定値。`ExtensionSettings.folderName` で変更可）を Bitwarden に作成。
- [ ] 検証用アイテムを当該フォルダに作成し、以下のカスタムフィールドを設定:
  - `aws_account_id`（必須, 12桁の AWS アカウント ID）
  - `aws_account_alias`（任意, サインイン URL のエイリアス部分）
  - ログイン情報: ユーザー名・パスワード（実際に AWS IAM コンソールへログインできる値）
  - MFA 検証用アイテムには TOTP（`bw get totp <id>` で 6 桁コードが返る状態）も設定する。
    MFA 未設定アカウントの検証用に、TOTP 無しアイテムも最低1つ用意する（3.2 Step 3 のブランチ確認用）。
  - `URI` にサインイン URL（`https://<alias-or-account-id>.signin.aws.amazon.com/console/`）を設定。
- [ ] `bw unlock` → `bw list items --folderid <folder-id>` で上記アイテムが取得できることを CLI で確認。

### 0.3 ビルド

```sh
npm install
npm run build            # @acs/shared → @acs/extension（本番相当ビルド, localhost:8087 は除外）
```

拡張 ID を固定したい場合（推奨、ネイティブホスト `allowed_origins` と一致させる必要があるため）:

```sh
# 開発鍵ペアを用意し、公開鍵の Base64（PEM ヘッダ除去）を渡す
ACS_EXTENSION_KEY="<BASE64_PUBLIC_KEY>" npm run build:dev -w @acs/extension
```

- [ ] `packages/extension/dist/` が生成されている。
- [ ] Chrome `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」
      → `packages/extension/dist` を選択。
- [ ] 拡張が読み込まれ、拡張 ID（32文字の英小文字ID）を確認・記録する。
      （`ACS_EXTENSION_KEY` 未設定の場合、拡張を再読み込みすると ID が変わりうる点に注意。
      その都度ネイティブホスト manifest の `allowed_origins` を更新すること。）

### 0.4 ネイティブホストのビルドと登録

> **既知の準備事項**: `packages/native-host` には現時点で `build`/`dist` 出力を作る npm script が
> 無い（`tsconfig.json` は `noEmit: true`）。ネイティブメッセージングホストは OS から直接実行できる
> エントリポイントを要求するため、以下いずれかの方法で実行可能な形にすること（本書はどちらでもよい。
> 実装への追加は本タスクのスコープ外のため、ここでは検証用の回避策として案内する）。

**方法 A: `tsx` でソースを直接実行するラッパースクリプトを使う（追加ビルド不要）**

```sh
npm install -g tsx   # またはリポジトリの devDependencies に一時的に追加
```

`native-host-launcher.sh`（実行権限 `chmod +x`）を用意し、ホスト manifest の `path` にこの絶対パスを指定:

```sh
#!/usr/bin/env bash
exec npx tsx "$(dirname "$0")/packages/native-host/src/index.ts"
```

**方法 B: `tsc` で一時的に `dist` を生成する**

```sh
npx tsc -p packages/native-host/tsconfig.json --outDir packages/native-host/dist --noEmit false --module esnext --moduleResolution bundler
node packages/native-host/dist/index.js   # 動作確認（stdin/stdout で待機状態になることを確認 → Ctrl+C）
```

ホスト manifest の `path` は `packages/native-host/dist/index.js` を起動するラッパー（`node <path>` を
`exec` するシェルスクリプト、または Windows なら `.bat`）を指定する。

**ホスト名（変更不可の固定値）**: `packages/extension/src/native-host-name.ts` の
`NATIVE_HOST_NAME` = `"com.ohmyopencodes.aws_console_switcher"`。ネイティブホスト manifest の
`name` フィールドは**この値と完全一致**させること（不一致だと `chrome.runtime.connectNative` が
`host_not_running` 相当のエラーで即時失敗する）。

ネイティブホスト manifest（`com.ohmyopencodes.aws_console_switcher.json`）の例:

```json
{
  "name": "com.ohmyopencodes.aws_console_switcher",
  "description": "AWS Console Switcher native messaging host",
  "path": "/absolute/path/to/native-host-launcher.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<0.3で確認した拡張ID>/"
  ]
}
```

OS 別の配置先（[Chrome 公式ドキュメント](https://developer.chrome.com/docs/apps/nativeMessaging/)参照）:

- [ ] Linux: `~/.config/google-chrome/NativeMessagingHosts/com.ohmyopencodes.aws_console_switcher.json`
- [ ] macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ohmyopencodes.aws_console_switcher.json`
- [ ] Windows: レジストリ `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.ohmyopencodes.aws_console_switcher` に manifest パスを登録。

---

## PoC #1【最優先】Native Messaging 疎通

> requirements.md §6-1 / design.md「Native Host」節

- [ ] 0.4 のホスト manifest 登録後、拡張の Service Worker から `chrome.runtime.connectNative`
      が例外なく接続できる（Chrome DevTools でエラーが出ない）。
- [ ] Popup を開き、`listAccounts`/`syncAccounts` 相当の操作（アカウント一覧表示・同期ボタン）を実行し、
      ホスト経由で Vault からアカウント一覧が取得できる（`bw get item <id>` / `bw list items` の
      呼び出しが実行されている）ことを確認する。
- [ ] `allowed_origins` に登録していない別拡張 ID から接続を試みた場合（例: 拡張 ID をわざと変えて
      再読み込みし、manifest 側は更新しないまま接続を試す）、Chrome が接続を拒否することを確認する
      （`allowed_origins` による拡張 ID 限定が機能していることの確認）。
- [ ] ホストプロセスを起動したまま `ps`/タスクマネージャで確認し、**リスニングポートを一切開いていない**
      こと（`lsof -i` 等でポート待受が無いこと）を確認する（stdio のみの疎通であることの確認）。

## PoC #2【最優先】方式1＋アイドル自動ロックの実装検証

> requirements.md §6-2 / §4.1.1 / design.md「NativeHost」節

- [ ] Popup の unlock 入力欄にマスターパスワードを入力して送信し、`bw unlock --passwordenv` 相当の
      処理でアンロックされ、以降 `listAccounts` 等がパスワード入力なしで動作することを確認する。
- [ ] アンロック直後、拡張がホストへ `configure`（`idleLockMinutes`・`totpMinRemainingSeconds`）を
      送信していることを確認する（ホスト側ログ、または一時的に `console.error` 等で確認してもよい）。
- [ ] `idleLockMinutes` を短い値（例: 1分、Popup の設定 UI か直接 storage 経由）に変更した状態で
      アイドル状態を維持し、設定時間経過後にホストが自動的に `bw lock` 相当を実行し、以降の
      `getItem`/`getTotp` 呼び出しが `vault_locked` エラーになることを確認する。
- [ ] ロック中に Popup を開くと `vault_locked` に対応する行動可能な通知（マスターパスワード再入力誘導）
      が表示されることを確認する（design.md Error Handling 節 / task 9.1）。

## PoC #3 MV3 SW ライフサイクル下のフロー維持

> requirements.md §6-3 / design.md「FlowContext」（SW 再起動耐性, C-1）

- [ ] サインインフローを開始し（Popup からアカウントを選択）、認証情報入力画面（`awaiting_credentials`）
      まで進める。
- [ ] `chrome://serviceworker-internals` または `chrome://extensions` の拡張詳細 →
      「service worker」→「Service Worker を終了」（あるいは DevTools の Application タブ →
      Service Workers → “Stop” ボタン）で Service Worker を強制終了する。
- [ ] フローを続行（例: 認証情報を送信、MFA 画面へ進む）した際に、SW が再起動され
      `chrome.storage.local` の `FlowContext`（`flow:{tabId}`）から状態を復元し、フローが破綻なく
      継続することを確認する（`chrome.tabs.onUpdated`/アラーム発火での再起動を含む）。
- [ ] MFA 待機中に SW を強制終了し、`flowTimeout:{tabId}` アラーム発火（design.md 既定 35 秒窓）で
      SW が起床し、`mfaRetryCount` に基づいて TOTP 再発行またはタイムアウト失敗へ正しく遷移することを
      確認する。

## PoC #4 AWS サインイン DOM 自動化＋複数セッション UI

> requirements.md §6-4 / design.md「SessionManager」Ports 節

- [ ] アカウント ID 入力欄が表示される汎用エントリ（未 Cookie 記憶）でのサインインが、
      アカウント ID → ユーザー名/パスワード → （MFA 設定時のみ）TOTP の順で自動入力・送信されることを
      確認する。
- [ ] 同一ブラウザで一度サインイン済みの AWS アカウントに対し Cookie 記憶済み状態で再度サインインを
      開始した場合、アカウント ID 入力欄がスキップされ認証情報入力から始まることを確認する
      （3.2 Step 1 のブランチ）。
- [ ] MFA 未設定アカウントでサインインした場合、MFA 画面が描画されずに直接コンソールへリダイレクトされ、
      これが失敗として扱われず正常に `done` へ遷移することを確認する。
- [ ] 異なる2〜3個の AWS アカウントへ順にサインインし、**Popup から既存セッションへ切り替えた際に
      新規タブを開かず既存タブが前面化される**ことを確認する（`SessionManager.switchTo`, task 6.1）。
- [ ] 6個目のアカウントへサインインした際、最も `lastAccessedAt` が古いセッション記録が1件だけ退避され
      （AWS 側のサインアウト操作は行われない = 元タブはバックグラウンドに残る）、同時上限5が
      一時的にも超過しないことを確認する（task 6.2, 3.2.1）。
- [ ] TOTP の残秒数が閾値未満（既定5秒未満）のタイミングでログインを試みた場合、ホストが次コードを
      待機して返し、AWS 側のコード再利用拒否によるログイン失敗が発生しないことを確認する（3.2 Step 3）。

## PoC #5 セレクタ耐性

> requirements.md §6-5 / design.md「SelectorSet」節

- [ ] 現行 AWS サインイン画面の実 DOM を調査し、`packages/extension/src/content-scripts/selectors.ts`
      の `DEFAULT_SELECTOR_SET` に定義された暫定セレクタ配列（`accountIdInput` /
      `usernameInput` / `passwordInput` / `mfaInput` / `submitButton` / `authErrorMarker` /
      `consoleReadyMarker`）が実際に対象要素を捕捉できるか1つずつ確認する。
- [ ] 捕捉できないセレクタがあれば、実 DOM から採取した正しいセレクタ値へ `DEFAULT_SELECTOR_SET`
      を更新する（この更新自体は本チェックリストの範囲外の実装修正であり、別タスクとして起票する）。
- [ ] 意図的に誤った第一候補セレクタを設定した状態で、フォールバック（配列内の次の候補）が
      正しく機能することを確認する。
- [ ] `SelectorSet.version` を更新した設定を注入し、同梱既定値より新しい場合に上書き採用されることを
      確認する（動的更新機構, task 5.1）。
- [ ] 誤ったパスワードでの認証失敗時、`authErrorMarker` の検知で `signinDomEvent.authError` が
      正しく送出され、フローが失敗として扱われることを確認する。

## PoC #6 `login.totp` のフォーマット確認

> requirements.md §6-6 (m-14) / design.md「Open Questions（PoC で確定）」

- [ ] TOTP 設定済みアイテムに対し `bw get item <id>` を実行し、応答 JSON の `login.totp` フィールドの
      値を確認する。
- [ ] 値が otpauth URI（`otpauth://totp/...?secret=...`）形式か、Base32 シード単体かを判別する。
- [ ] 本設計は `bw get totp <id>`（ホストが生成済み6桁コードを返す方式）に一本化されており、
      `HostResponse.item` にシードを含めない（C-4）ことを確認する（`bw get totp` の応答が
      6桁コード＋残秒数として正しく返ることの確認のみで、拡張内 Web Crypto 実装は本設計の対象外）。
- [ ] 上記確認結果を関係者へ共有し、将来的に拡張内 TOTP 生成へ切り替える場合の追加検討事項として
      記録する（design.md の Open Questions 節を更新するかどうかは別途判断）。

---

## 実施後の対応

- [ ] 全項目（#1〜#6 のチェックボックス）が完了したら、`.kiro/specs/aws-console-switcher/tasks.md`
      の `- [ ] 10.3 E2E テスト（PoC 連動）` を `- [x]` に更新する。
- [ ] PoC #5 でセレクタ不一致が見つかった場合は、`DEFAULT_SELECTOR_SET` 更新を別タスクとして起票する。
- [ ] 未解決の問題（`allowed_origins` 不一致、ホスト起動失敗等）が見つかった場合は、本書には追記せず
      別途 issue 化し、解消後に該当項目を再検証する。
