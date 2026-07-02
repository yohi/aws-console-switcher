import type { BwCli } from "./bw-cli.js";
import type { SessionManager } from "./session.js";

const DEFAULT_IDLE_LOCK_CHECK_INTERVAL_MS = 30_000;
const MILLISECONDS_PER_MINUTE = 60_000;

export interface IdleLockTimer {
  readonly stop: () => void;
}

export interface IdleLockTimerDependencies {
  readonly bwCli: BwCli;
  readonly session: SessionManager;
  readonly clock?: () => Date;
  readonly intervalMs?: number;
}

export function startIdleLockTimer(deps: IdleLockTimerDependencies): IdleLockTimer {
  const clock = deps.clock ?? (() => new Date());
  let lockInFlight = false;

  const checkIdleLock = async (): Promise<void> => {
    if (lockInFlight) {
      return;
    }

    const sessionToken = deps.session.currentSession();
    if (sessionToken === undefined) {
      return;
    }

    if (!hasExceededIdleLimit(deps.session.status().lastUsedAt, deps.session.settings().idleLockMinutes, clock)) {
      return;
    }

    lockInFlight = true;
    await deps.bwCli.lock(sessionToken);
    deps.session.lock();
    lockInFlight = false;
  };

  const timer = setInterval(() => {
    void checkIdleLock();
  }, deps.intervalMs ?? DEFAULT_IDLE_LOCK_CHECK_INTERVAL_MS);
  unrefTimer(timer);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

function hasExceededIdleLimit(
  lastUsedAt: string,
  idleLockMinutes: number,
  clock: () => Date,
): boolean {
  const lastUsedMs = Date.parse(lastUsedAt);
  if (!Number.isFinite(lastUsedMs)) {
    return false;
  }
  const idleMs = clock().getTime() - lastUsedMs;
  return idleMs > idleLockMinutes * MILLISECONDS_PER_MINUTE;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unref = timer.unref;
    if (typeof unref === "function") {
      unref.call(timer);
    }
  }
}
