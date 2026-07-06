/**
 * Native Messaging アダプタのユニットテスト（task 3.1）。
 *
 * Chrome `chrome.runtime.connectNative` をモックし、共有ポート上の
 * requestId ベース demux・切断時の reject を検証する。
 */
import { describe, expect, it, vi } from "vitest";
import {
  type HostRequest,
  type HostResponse,
} from "@acs/shared";
import {
  type ChromeRuntimePort,
  NativeMessagingAdapter,
} from "./native-messaging-adapter.js";

function createFakePort(): ChromeRuntimePort {
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const sent: HostRequest[] = [];

  const port: ChromeRuntimePort & {
    _notifyMessage: (message: HostResponse) => void;
    _sent: HostRequest[];
  } = {
    name: "com.ohmyopencodes.aws_console_switcher",
    postMessage: (message: HostRequest) => {
      sent.push(message);
    },
    disconnect: () => {
      disconnectListeners.forEach((fn) => fn());
    },
    onMessage: {
      addListener: (fn: (message: unknown) => void) => listeners.add(fn),
      removeListener: (fn: (message: unknown) => void) => listeners.delete(fn),
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.add(fn),
      removeListener: (fn: () => void) => disconnectListeners.delete(fn),
    },
    _notifyMessage: (message: HostResponse) => listeners.forEach((fn) => fn(message)),
    _sent: sent,
  };
  return port;
}

function createFakeRuntime() {
  const port = createFakePort();
  return {
    connectNative: vi.fn((_name: string) => port),
    getPort: () => port,
  };
}

describe("NativeMessagingAdapter", () => {
  it("sends a request with a generated requestId", async () => {
    const runtime = createFakeRuntime();
    const adapter = new NativeMessagingAdapter(runtime as unknown as typeof chrome.runtime, "com.example.host");
    const promise = adapter.send({ type: "status" } as HostRequest);

    const port = runtime.getPort();
    expect(port._sent).toHaveLength(1);
    const req = port._sent[0];
    expect(req.type).toBe("status");
    expect(typeof req.requestId).toBe("string");
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);

    port._notifyMessage({ type: "status", requestId: req.requestId, unlocked: true, lastUsedAt: "2026-07-03T00:00:00Z" });
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("demuxes out-of-order responses by requestId", async () => {
    const runtime = createFakeRuntime();
    const adapter = new NativeMessagingAdapter(runtime as unknown as typeof chrome.runtime, "com.example.host");

    const p1 = adapter.send({ type: "getItem", uuid: "a" } as HostRequest);
    const p2 = adapter.send({ type: "getItem", uuid: "b" } as HostRequest);

    const port = runtime.getPort();
    const [r1, r2] = port._sent;

    // 逆順で応答を返す
    port._notifyMessage({ type: "item", requestId: r2.requestId, username: "u2", password: "p2" });
    port._notifyMessage({ type: "item", requestId: r1.requestId, username: "u1", password: "p1" });

    const res1 = await p1;
    const res2 = await p2;
    if (res1.ok && res2.ok) {
      expect(res1.value).toMatchObject({ type: "item", username: "u1" });
      expect(res2.value).toMatchObject({ type: "item", username: "u2" });
    } else {
      throw new Error("expected both ok");
    }
  });

  it("rejects pending requests when the port disconnects", async () => {
    const runtime = createFakeRuntime();
    const adapter = new NativeMessagingAdapter(runtime as unknown as typeof chrome.runtime, "com.example.host");

    const promise = adapter.send({ type: "status" } as HostRequest);
    const port = runtime.getPort();
    port.disconnect();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("precondition");
      expect(result.error.code).toBe("host_disconnected");
    }
  });

  it("rejects malformed responses", async () => {
    const runtime = createFakeRuntime();
    const adapter = new NativeMessagingAdapter(runtime as unknown as typeof chrome.runtime, "com.example.host");
    const promise = adapter.send({ type: "status" } as HostRequest);

    const port = runtime.getPort();
    const req = port._sent[0];
    port._notifyMessage({ type: "status", requestId: req.requestId, unlocked: "yes" } as unknown as HostResponse);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("precondition");
      expect(result.error.code).toBe("host_malformed_response");
    }
  });

  it("ignores responses with unknown requestId", async () => {
    const runtime = createFakeRuntime();
    const adapter = new NativeMessagingAdapter(runtime as unknown as typeof chrome.runtime, "com.example.host");
    const promise = adapter.send({ type: "status" } as HostRequest);

    const port = runtime.getPort();
    const req = port._sent[0];
    port._notifyMessage({ type: "totp", requestId: "00000000-0000-0000-0000-000000000000", code: "123456", remainingSeconds: 30 });
    port._notifyMessage({ type: "status", requestId: req.requestId, unlocked: true, lastUsedAt: "2026-07-03T00:00:00Z" });

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("rejects ALL pending requests with host_disconnected when the port disconnects mid-flight", async () => {
    const runtime = createFakeRuntime();
    const adapter = new NativeMessagingAdapter(runtime as unknown as typeof chrome.runtime, "com.example.host");

    // 複数の要求を同一共有ポート上で並行 in-flight にしておく。
    const p1 = adapter.send({ type: "status" } as HostRequest);
    const p2 = adapter.send({ type: "getItem", uuid: "a" } as HostRequest);
    const p3 = adapter.send({ type: "getItem", uuid: "b" } as HostRequest);

    const port = runtime.getPort();
    expect(port._sent).toHaveLength(3);
    port.disconnect();

    // 切断で保留中の全要求が同一エラーで reject される（一部だけ残らない）。
    const results = await Promise.all([p1, p2, p3]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("precondition");
        expect(result.error.code).toBe("host_disconnected");
      }
    }
  });
});
