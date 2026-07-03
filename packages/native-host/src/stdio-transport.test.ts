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
