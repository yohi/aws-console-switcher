/**
 * Service Worker エントリ（ステートレス・プロキシの基盤）。
 *
 * NOTE: メッセージルーティング・フロー調停・tabs 監視・requestId demux は task 4 で実装する。
 * 本エントリは共有契約（@acs/shared）とビルド配線の疎通を示し、受信メッセージを境界で検証する
 * のみに留める（tech.md「validate inputs at boundaries」, MUST NOT: task 4 のロジックは書かない）。
 */
import { isExtMessage } from "@acs/shared";

function handleInboundMessage(message: unknown): void {
  if (!isExtMessage(message)) {
    // 不正な形状のメッセージは無視する（境界バリデーション）。
    return;
  }
  // 実際のルーティング／フロー調停は task 4（Service Worker）で実装する。
}

chrome.runtime.onMessage.addListener((message) => {
  handleInboundMessage(message);
  // 同期応答（非同期応答チャネルは task 4 で必要に応じて開く）。
  return false;
});
