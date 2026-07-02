import { pathToFileURL } from "node:url";
import { stdin, stdout } from "node:process";
import type { Writable } from "node:stream";
import {
  defaultHostDispatcherDependencies,
  handleIncomingMessage,
  makeErrorResponse,
} from "./dispatcher.js";
import { startIdleLockTimer } from "./idle-lock.js";
import { NativeMessageParser, writeNativeMessage } from "./stdio-transport.js";

export async function runNativeHost(
  input: AsyncIterable<Buffer | string>,
  output: Writable,
): Promise<void> {
  const parser = new NativeMessageParser();
  const idleLockTimer = startIdleLockTimer(defaultHostDispatcherDependencies());

  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const results = parser.push(buffer);

      for (const result of results) {
        const response = result.ok
          ? await handleIncomingMessage(result.value)
          : makeErrorResponse("unknown", result.error);
        await writeNativeMessage(output, response);
      }
    }

    const finalResult = parser.finish();
    if (finalResult?.ok === false) {
      await writeNativeMessage(output, makeErrorResponse("unknown", finalResult.error));
    }
  } finally {
    idleLockTimer.stop();
  }
}

const entryPath = process.argv[1];

if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await runNativeHost(stdin, stdout);
  } catch (error) {
    if (error instanceof Error) {
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
