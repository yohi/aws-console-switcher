import { err, ok, type FlowError, type Result } from "@acs/shared";

const TOTP_WINDOW_SECONDS = 30;
const MILLISECONDS_PER_SECOND = 1_000;

export interface TotpCodeWithRemainingSeconds {
  readonly code: string;
  readonly remainingSeconds: number;
}

export type TotpCodeFetcher = () => Promise<Result<string, FlowError>>;
export type TotpClock = () => number;
export type TotpSleep = (durationMs: number, signal?: AbortSignal) => Promise<void>;

export interface TotpWindowWaitOptions {
  readonly minRemainingSeconds: number;
  readonly fetchCode: TotpCodeFetcher;
  readonly nowMs?: TotpClock;
  readonly sleep?: TotpSleep;
  readonly signal?: AbortSignal;
}

export class TotpWaitAbortedError extends Error {
  constructor() {
    super("TOTP wait was aborted.");
    this.name = "TotpWaitAbortedError";
  }
}

export function remainingTotpSeconds(nowMs: number = Date.now()): number {
  return TOTP_WINDOW_SECONDS - (Math.floor(nowMs / MILLISECONDS_PER_SECOND) % TOTP_WINDOW_SECONDS);
}

export async function getTotpCodeWithWindowWait(
  options: TotpWindowWaitOptions,
): Promise<Result<TotpCodeWithRemainingSeconds, FlowError>> {
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const initialResult = await options.fetchCode();
  if (!initialResult.ok) {
    return err(initialResult.error);
  }

  const initialRemainingSeconds = remainingTotpSeconds(nowMs());
  if (initialRemainingSeconds >= options.minRemainingSeconds) {
    return ok({ code: initialResult.value.trim(), remainingSeconds: initialRemainingSeconds });
  }

  await sleep((initialRemainingSeconds + 1) * MILLISECONDS_PER_SECOND, options.signal);

  const refreshedResult = await options.fetchCode();
  if (!refreshedResult.ok) {
    return err(refreshedResult.error);
  }

  return ok({
    code: refreshedResult.value.trim(),
    remainingSeconds: remainingTotpSeconds(nowMs()),
  });
}

export function sleepFor(durationMs: number, signal?: AbortSignal): Promise<void> {
  const abortSignal = signal;
  if (abortSignal?.aborted) {
    return Promise.reject(new TotpWaitAbortedError());
  }

  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      abortSignal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", abort);
      reject(new TotpWaitAbortedError());
    };
    const timeout = setTimeout(finish, durationMs);
    abortSignal?.addEventListener("abort", abort, { once: true });
  });
}
