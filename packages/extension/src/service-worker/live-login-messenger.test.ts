/**
 * ライブ LoginMessenger 実装のユニットテスト（cross-cutting integration: tasks 4.2/5.2 の結線）。
 *
 * SW → CS の値注入を `chrome.tabs.sendMessage` で送信する `createLiveLoginMessenger` を、
 * 送信メッセージ形状（SigninInjectionCommand と一致）と reject 時のエラー写像の観点で検証する。
 */
import { describe, expect, it, vi } from "vitest";
import {
  type TabMessageSender,
  createLiveLoginMessenger,
} from "./live-login-messenger.js";

function createFakeSender(
  impl?: (tabId: number, message: unknown) => Promise<unknown>,
): TabMessageSender & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn(impl ?? (async () => undefined)),
  };
}

describe("createLiveLoginMessenger", () => {
  it("sends an injectAccountId command and resolves ok", async () => {
    const sender = createFakeSender();
    const messenger = createLiveLoginMessenger(sender);

    const result = await messenger.injectAccountId(42, "123456789012");

    expect(result.ok).toBe(true);
    expect(sender.sendMessage).toHaveBeenCalledWith(42, {
      kind: "injectAccountId",
      accountId: "123456789012",
    });
  });

  it("sends an injectCredentials command and resolves ok", async () => {
    const sender = createFakeSender();
    const messenger = createLiveLoginMessenger(sender);

    const result = await messenger.injectCredentials(7, "admin", "secret");

    expect(result.ok).toBe(true);
    expect(sender.sendMessage).toHaveBeenCalledWith(7, {
      kind: "injectCredentials",
      username: "admin",
      password: "secret",
    });
  });

  it("sends an injectTotp command and resolves ok", async () => {
    const sender = createFakeSender();
    const messenger = createLiveLoginMessenger(sender);

    const result = await messenger.injectTotp(9, "123456");

    expect(result.ok).toBe(true);
    expect(sender.sendMessage).toHaveBeenCalledWith(9, {
      kind: "injectTotp",
      code: "123456",
    });
  });

  it("maps a rejected sendMessage (tab closed / no listener) to a host_disconnected failure", async () => {
    const sender = createFakeSender(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const messenger = createLiveLoginMessenger(sender);

    const result = await messenger.injectTotp(42, "123456");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("host_disconnected");
    }
  });
});
