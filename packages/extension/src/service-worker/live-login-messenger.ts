/**
 * ライブ LoginMessenger 実装（cross-cutting integration: tasks 4.2/5.2 の結線）。
 *
 * `LoginStateMachine`（login-state-machine.ts）が要求する `LoginMessenger` ポートを、
 * 実際の `chrome.tabs.sendMessage(tabId, command)` で満たす実装。SW は値注入コマンドを送信し、
 * CS 側 `chrome.runtime.onMessage`（signin-content-script.ts）が `SigninInjectionCommand` として
 * 受信・注入する。送信メッセージ形状は CS 側契約 `SigninInjectionCommand` と型レベルで一致させる。
 *
 * エラー写像: タブ閉鎖・CS 未リスニング等で `sendMessage` が reject した場合は
 * `host_disconnected` の `FlowError` へ写像し、ステートマシンが失敗遷移を駆動できるようにする
 * （成功＝例外なしは `{ ok: true, value: undefined }`）。
 *
 * 秘匿境界: username / password / TOTP code はメソッド引数として受け取りコマンドへ載せて送るのみで、
 * 本モジュールでは永続化・ログ出力しない。
 */
import { type FlowError, type Result, makeFlowError } from "@acs/shared";
import { type SigninInjectionCommand } from "../content-scripts/signin-content-script.js";
import { type LoginMessenger } from "./login-state-machine.js";

/**
 * `chrome.tabs.sendMessage` からライブメッセンジャーが必要とするメソッドのみを切り出した抽象。
 * `MessageRouterDeps["tabs"]`（TabsApi）がこの形状を満たすため、`deps.tabs` をそのまま渡せる。
 */
export interface TabMessageSender {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/**
 * `chrome.tabs.sendMessage` ベースの `LoginMessenger` を生成する。
 * ステートレスなため要求ごとに `deps.tabs` から都度合成してよい。
 */
export function createLiveLoginMessenger(
  tabs: TabMessageSender,
): LoginMessenger {
  return {
    injectAccountId: (tabId, accountId) =>
      sendInjectionCommand(tabs, tabId, {
        kind: "injectAccountId",
        accountId,
      }),
    injectCredentials: (tabId, username, password) =>
      sendInjectionCommand(tabs, tabId, {
        kind: "injectCredentials",
        username,
        password,
      }),
    injectTotp: (tabId, code) =>
      sendInjectionCommand(tabs, tabId, { kind: "injectTotp", code }),
  };
}

/**
 * 注入コマンドを CS へ送信し、結果を `Result<void, FlowError>` へ写像する。
 * `sendMessage` の reject（タブ閉鎖・受信側不在など）は `host_disconnected` として扱う。
 */
async function sendInjectionCommand(
  tabs: TabMessageSender,
  tabId: number,
  command: SigninInjectionCommand,
): Promise<Result<void, FlowError>> {
  try {
    await tabs.sendMessage(tabId, command);
    return { ok: true, value: undefined };
  } catch {
    return {
      ok: false,
      error: makeFlowError(
        "host_disconnected",
        "Failed to deliver the injection command to the sign-in content script.",
      ),
    };
  }
}
