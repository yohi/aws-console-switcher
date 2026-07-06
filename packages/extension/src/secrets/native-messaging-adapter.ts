/**
 * Native Messaging アダプタ（task 3.1）。
 *
 * 拡張 ↔ Native Host 間の単一共有ポートを管理し、`requestId` ベースで応答を demux する。
 * ポート切断時は保留中の全要求を `host_disconnected` で reject する。
 */
import {
  type HostRequest,
  type HostResponse,
  isHostResponse,
  type Result,
  type FlowError,
  generateRequestId,
  hasRequestId,
} from "@acs/shared";

/**
 * テスト可能な最小限の `chrome.runtime.Port` 抽象。
 * `chrome.runtime.connectNative` の戻り値から必要なメソッドのみを切り出す。
 */
export interface ChromeRuntimePort {
  readonly name: string;
  postMessage(message: HostRequest): void;
  disconnect(): void;
  onMessage: {
    addListener(fn: (message: unknown) => void): void;
    removeListener(fn: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(fn: () => void): void;
    removeListener(fn: () => void): void;
  };
}

/**
 * `chrome.runtime` から `connectNative` のみを切り出した抽象。
 */
export interface ChromeRuntime {
  connectNative(name: string): ChromeRuntimePort;
}

/**
 * SecretSourceAdapter の Native Messaging 実装。
 *
 * Design.md §2.1.1, §3.3: 拡張側は `BW_SESSION` を保持せず、メッセージパッシングのみを行う。
 */
export class NativeMessagingAdapter {
  private readonly runtime: ChromeRuntime;
  private readonly hostName: string;
  private port: ChromeRuntimePort | null = null;
  private readonly pending = new Map<
    string,
    (response: Result<HostResponse, FlowError>) => void
  >();

  constructor(
    runtime: ChromeRuntime,
    hostName: string,
  ) {
    this.runtime = runtime;
    this.hostName = hostName;
  }

  /**
   * 要求を送信し、対応する `requestId` の応答を非同期に返す。
   */
  send(request: Omit<HostRequest, "requestId">): Promise<Result<HostResponse, FlowError>> {
    return new Promise((resolve) => {
      const port = this.getOrCreatePort();
      const requestId = generateRequestId();
      const fullRequest = { ...request, requestId } as HostRequest;

      this.pending.set(requestId, resolve);
      port.postMessage(fullRequest);
    });
  }

  private getOrCreatePort(): ChromeRuntimePort {
    if (this.port) {
      return this.port;
    }
    const port = this.runtime.connectNative(this.hostName);
    this.port = port;

    port.onMessage.addListener((message: unknown) => {
      this.handleMessage(message);
    });

    port.onDisconnect.addListener(() => {
      this.handleDisconnect();
    });

    return port;
  }

  private handleMessage(message: unknown): void {
    const requestId = hasRequestId(message) ? message.requestId : undefined;
    if (!requestId) {
      return;
    }
    const resolve = this.pending.get(requestId);
    if (!resolve) {
      return;
    }
    if (!isHostResponse(message)) {
      this.pending.delete(requestId);
      resolve({
        ok: false,
        error: {
          category: "precondition",
          code: "host_malformed_response",
          message: "Native host sent a malformed response.",
          retriable: true,
        },
      });
      return;
    }
    this.pending.delete(requestId);
    resolve({ ok: true, value: message });
  }

  private handleDisconnect(): void {
    const error: FlowError = {
      category: "precondition",
      code: "host_disconnected",
      message: "Native Messaging host disconnected. Please start the host and retry.",
      retriable: true,
    };
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    this.port = null;
    for (const resolve of pending) {
      resolve({ ok: false, error });
    }
    this.pending.clear();
    this.port = null;
    for (const resolve of pending.values()) {
      resolve({ ok: false, error });
    }
  }
}
