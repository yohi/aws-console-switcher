/**
 * 本番用ネイティブメッセージングホスト名（task 3.1 / 4.1, design.md 2.1.1）。
 *
 * `chrome.runtime.connectNative(NATIVE_HOST_NAME)` に渡す reverse-DNS 形式のホスト名。
 * この値は Service Worker から接続する唯一のホスト識別子であり、拡張全体で 1 箇所に定義する
 * （他モジュールは必ず本定数を import して参照し、文字列リテラルを重複させない）。
 *
 * IMPORTANT: この値は OS 規定の場所に登録するネイティブホスト manifest の `name` フィールドと
 * 完全に一致させる必要がある。加えて、そのホスト manifest の `allowed_origins` には本拡張の ID
 * （`chrome-extension://<id>/`）のみを列挙し、登録拡張以外からの到達を構造的に遮断する
 * （requirements 2.1.1 / design.md「Native Messaging」）。PoC #1 で疎通確認する（m-7）。
 *
 * NOTE: テスト専用のダミー値（例: `com.example.host`）とは別物。README.md / PoC ドキュメントで
 * 後から変更しやすいよう、変更点を本定数の 1 箇所に集約している。
 */
export const NATIVE_HOST_NAME = "com.ohmyopencodes.aws_console_switcher";
