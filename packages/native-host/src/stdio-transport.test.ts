import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { NativeMessageParser, encodeNativeMessage, writeNativeMessage } from "./stdio-transport.js";

describe("Native Messaging stdio framing", () => {
  it("writes a 4-byte little-endian length followed by UTF-8 JSON", async () => {
    // Given: a response object and an in-memory writable stream.
    const message = { requestId: "r-frame", type: "locked" };
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));

    // When: the message is written using Native Messaging framing.
    await writeNativeMessage(output, message);

    // Then: the prefix is a little-endian byte length and the payload is JSON.
    const frame = Buffer.concat(chunks);
    const length = frame.readUInt32LE(0);
    const payload = frame.subarray(4).toString("utf8");
    expect(length).toBe(Buffer.byteLength(payload, "utf8"));
    expect(JSON.parse(payload)).toEqual(message);
  });

  it("reads a complete length-prefixed JSON message across chunk boundaries", () => {
    // Given: a framed message split across header and payload boundaries.
    const frame = encodeNativeMessage({ requestId: "r-read", type: "status" });
    const parser = new NativeMessageParser();

    // When: the frame arrives in multiple chunks.
    const first = parser.push(frame.subarray(0, 2));
    const second = parser.push(frame.subarray(2, 7));
    const third = parser.push(frame.subarray(7));

    // Then: no partial message is emitted until the full frame is present.
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([
      { ok: true, value: { requestId: "r-read", type: "status" } },
    ]);
  });

  it("returns a typed malformed-input error for invalid JSON payloads", () => {
    // Given: a frame whose payload is not valid JSON.
    const parser = new NativeMessageParser();
    const invalidPayload = Buffer.from("{not-json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(invalidPayload.byteLength, 0);

    // When: the malformed frame is parsed.
    const results = parser.push(Buffer.concat([header, invalidPayload]));

    // Then: parsing fails with a precondition FlowError, not a thrown exception.
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0]?.ok === false) {
      expect(results[0].error.category).toBe("precondition");
      expect(results[0].error.code).toBe("host_not_running");
    }
  });

  it("returns host_disconnected only when the stream ends mid-frame", () => {
    // Given: a parser with an incomplete frame buffered.
    const parser = new NativeMessageParser();
    const frame = encodeNativeMessage({ requestId: "r-short", type: "lock" });
    parser.push(frame.subarray(0, frame.byteLength - 1));

    // When: the stream finishes before the declared payload length arrives.
    const result = parser.finish();

    // Then: the error is the stream-disconnection code.
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.error.category).toBe("precondition");
      expect(result.error.code).toBe("host_disconnected");
    }
  });
});

describe("task 10.2 Native Messaging stream lifecycle", () => {
  it("returns undefined from finish() when the stream ends on a frame boundary", () => {
    // Given: a parser that has fully consumed a complete frame (clean disconnect).
    const parser = new NativeMessageParser();
    const results = parser.push(encodeNativeMessage({ requestId: "r-clean", type: "locked" }));

    // When: the stream ends with no bytes left buffered.
    const result = parser.finish();

    // Then: a clean end is not misreported as a disconnection error.
    expect(results).toHaveLength(1);
    expect(result).toBeUndefined();
  });

  it("emits one result per frame when several complete frames arrive in a single chunk", () => {
    // Given: three framed messages concatenated into a single buffer (pipelined requests).
    const parser = new NativeMessageParser();
    const combined = Buffer.concat([
      encodeNativeMessage({ requestId: "r-1", type: "status" }),
      encodeNativeMessage({ requestId: "r-2", type: "lock" }),
      encodeNativeMessage({ requestId: "r-3", type: "locked" }),
    ]);

    // When: the batched buffer is pushed at once.
    const results = parser.push(combined);

    // Then: each frame is decoded in arrival order within the same push.
    expect(results).toEqual([
      { ok: true, value: { requestId: "r-1", type: "status" } },
      { ok: true, value: { requestId: "r-2", type: "lock" } },
      { ok: true, value: { requestId: "r-3", type: "locked" } },
    ]);
  });

  it("reports host_disconnected when the stream ends after only part of the length header", () => {
    // Given: fewer than the four header bytes have arrived (mid-header disconnect).
    const parser = new NativeMessageParser();
    const partialHeader = parser.push(Buffer.from([0x01, 0x00]));

    // When: the stream finishes before the length prefix is complete.
    const result = parser.finish();

    // Then: no frame is emitted and the truncated header is a stream disconnection.
    expect(partialHeader).toEqual([]);
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.error.category).toBe("precondition");
      expect(result.error.code).toBe("host_disconnected");
    }
  });
});
