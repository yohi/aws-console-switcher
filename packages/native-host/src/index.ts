/**
 * Native Messaging host エントリポイント（`bw` CLI ラッパー）— SKELETON。
 *
 * 本基盤（task 1.1）では Node.js / TypeScript 前提のパッケージ土台（workspace 構成・
 * ディレクトリ分離）のみを用意する。ホスト本体は **task 2** で実装する:
 * - stdin/stdout の Native Messaging stdio プロトコル（ホスト manifest の
 *   `allowed_origins` に本拡張 ID のみを登録し、ネットワークポートを一切公開しない）
 * - `unlock` / `lock` / `status` と `BW_SESSION` の自プロセス限定保持
 * - フォルダ／アイテム列挙・シークレット取得（`getItem` / `getTotp`）
 * - アイドル自動ロックタイマー・設定受領（`configure`）
 * - ホスト側 TOTP 待機制御
 *
 * 共有契約（`HostRequest` / `HostResponse` 等）は `@acs/shared` を参照する。
 * MUST NOT: 本基盤ではホストのロジックを実装しない（task 2 のスコープ）。
 */
export {};
