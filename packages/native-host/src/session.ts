export interface VaultSessionStatus {
  readonly unlocked: boolean;
  readonly lastUsedAt: string;
}

export interface HostSettings {
  readonly idleLockMinutes: number;
  readonly totpMinRemainingSeconds: number;
}

export interface SessionManager {
  readonly unlock: (sessionToken: string) => void;
  readonly lock: () => void;
  readonly touch: () => void;
  readonly configure: (settings: HostSettings) => void;
  readonly settings: () => HostSettings;
  readonly status: () => VaultSessionStatus;
  readonly currentSession: () => string | undefined;
}

const INITIAL_LAST_USED_AT = "1970-01-01T00:00:00.000Z";

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  idleLockMinutes: 20,
  totpMinRemainingSeconds: 5,
} as const;

export function createSessionManager(clock = (): Date => new Date()): SessionManager {
  let sessionToken: string | undefined;
  let lastUsedAt = INITIAL_LAST_USED_AT;
  let currentSettings = DEFAULT_HOST_SETTINGS;

  const markUsed = (): void => {
    lastUsedAt = clock().toISOString();
  };

  return {
    unlock(token: string): void {
      sessionToken = token;
      markUsed();
    },
    lock(): void {
      sessionToken = undefined;
    },
    touch(): void {
      markUsed();
    },
    configure(settings: HostSettings): void {
      if (!Number.isFinite(settings.idleLockMinutes) || settings.idleLockMinutes <= 0) {
        throw new RangeError("idleLockMinutes must be a finite positive number.");
      }
      if (
        !Number.isFinite(settings.totpMinRemainingSeconds) ||
        settings.totpMinRemainingSeconds < 0
      ) {
        throw new RangeError("totpMinRemainingSeconds must be a finite non-negative number.");
      }
      currentSettings = settings;
    },
    settings(): HostSettings {
      return currentSettings;
    },
    status(): VaultSessionStatus {
      return { unlocked: sessionToken !== undefined, lastUsedAt };
    },
    currentSession(): string | undefined {
      return sessionToken;
    },
  };
}
