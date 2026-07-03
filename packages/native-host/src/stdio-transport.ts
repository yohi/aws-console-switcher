import { err, makeFlowError, ok, type FlowError, type Result } from "@acs/shared";
import type { Writable } from "node:stream";

const HEADER_BYTES = 4;

export type NativeMessageParseResult = Result<unknown, FlowError>;

export class NativeMessageParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): readonly NativeMessageParseResult[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const results: NativeMessageParseResult[] = [];

    while (this.buffer.byteLength >= HEADER_BYTES) {
      const payloadBytes = this.buffer.readUInt32LE(0);
      const frameBytes = HEADER_BYTES + payloadBytes;

      if (this.buffer.byteLength < frameBytes) {
        break;
      }

      const payload = this.buffer.subarray(HEADER_BYTES, frameBytes).toString("utf8");
      this.buffer = this.buffer.subarray(frameBytes);
      results.push(parseJsonPayload(payload));
    }

    return results;
  }

  finish(): NativeMessageParseResult | undefined {
    if (this.buffer.byteLength === 0) {
      return undefined;
    }

    this.buffer = Buffer.alloc(0);
    return err(
      makeFlowError(
        "host_disconnected",
        "Native Messaging stream ended before a complete frame was received.",
      ),
    );
  }
}

export function encodeNativeMessage(message: unknown): Buffer {
  const json = JSON.stringify(message);
  if (typeof json !== "string") {
    throw new TypeError("Native Messaging payload must be JSON serializable.");
  }

  const payload = Buffer.from(json, "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export async function writeNativeMessage(
  output: Writable,
  message: unknown,
): Promise<void> {
  const frame = encodeNativeMessage(message);
  await new Promise<void>((resolve, reject) => {
    output.write(frame, (error: Error | null | undefined) => {
      if (error instanceof Error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseJsonPayload(payload: string): NativeMessageParseResult {
  try {
    const message: unknown = JSON.parse(payload);
    return ok(message);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return err(
        makeFlowError("host_not_running", "Malformed Native Messaging JSON payload."),
      );
    }
    throw error;
  }
}
