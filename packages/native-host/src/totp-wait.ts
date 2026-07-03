import { err, ok, type FlowError, type Result } from "@acs/shared";

/** Default TOTP period used when the authenticator entry does not expose a custom period. */
const DEFAULT_TOTP_PERIOD_SECONDS = 30;
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * Calculates the remaining seconds in the current TOTP window.
 * @param nowMs - Current timestamp in milliseconds.
 * @param periodSeconds - TOTP period in seconds; defaults to {@link DEFAULT_TOTP_PERIOD_SECONDS}.
 */
export function remainingTotpSeconds(
  nowMs: number = Date.now(),
  periodSeconds: number = DEFAULT_TOTP_PERIOD_SECONDS,
): number {
  return periodSeconds - (Math.floor(nowMs / MILLISECONDS_PER_SECOND) % periodSeconds);
}
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

  try {
    await sleep((initialRemainingSeconds + 1) * MILLISECONDS_PER_SECOND, options.signal);
  } catch (error) {
    if (error instanceof TotpWaitAbortedError) {
      return err({
        category: "precondition",
        code: "host_disconnected",
        message: "TOTP wait was aborted.",
        retriable: false,
      });
    }
    throw error;
  }

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
