/**
 * Console 状態検出スクリプト（基盤のみ）。
 *
 * 静的 content_scripts の対象外である `console.aws.amazon.com` に対し、Service Worker が
 * `chrome.scripting.executeScript` で動的注入する想定のスクリプト。現ログイン識別情報の読み取りと、
 * 動的注入用ビルド成果物としての manifest 配線（web_accessible_resource 等）は task 5.3 で実装する
 *（本基盤ではソース構造のみ用意し typecheck 対象とする。MUST NOT: ここではロジックを書かない）。
 */
export {};
