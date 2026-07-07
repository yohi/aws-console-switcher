/**
 * Service Worker 用 storage ヘルパー（task 4.1）。
 *
 * `chrome.storage.local` を抽象化し、FlowContext 等の非秘匿データの
 * 読み書きをテスト可能にする。
 */
import {
  type AccountMeta,
  type FlowContext,
  type SessionRecord,
} from "@acs/shared";

/**
 * `chrome.storage.StorageArea` から必要なメソッドのみを切り出した抽象。
 */
export interface StorageArea {
  get(
    keys: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function flowContextKey(tabId: number): string {
  return `flow:${tabId}`;
}

/**
 * FlowContext を `tabId` キーで保存する。
 */
export async function saveFlowContext(
  storage: StorageArea,
  ctx: FlowContext,
): Promise<void> {
  await storage.set({ [flowContextKey(ctx.tabId)]: ctx });
}

/**
 * `tabId` に対応する FlowContext を読み込む。存在しない場合は undefined。
 */
export async function loadFlowContext(
  storage: StorageArea,
  tabId: number,
): Promise<FlowContext | undefined> {
  const result = await storage.get(flowContextKey(tabId));
  const value = result[flowContextKey(tabId)];
  if (value === undefined) {
    return undefined;
  }
  return value as FlowContext;
}

/**
 * `tabId` に対応する FlowContext を削除する。
 */
export async function removeFlowContext(
  storage: StorageArea,
  tabId: number,
): Promise<void> {
  await storage.remove(flowContextKey(tabId));
}

function sessionKey(uuid: string): string {
  return `session:${uuid}`;
}

/**
 * セッション記録を保存する。
 */
export async function saveSessionRecord(
  storage: StorageArea,
  record: SessionRecord,
): Promise<void> {
  await storage.set({ [sessionKey(record.uuid)]: record });
}

/**
 * 全セッション記録を読み込む。
 */
export async function loadSessionRecords(
  storage: StorageArea,
): Promise<readonly SessionRecord[]> {
  const all = await storage.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith("session:"))
    .map(([, value]) => value as SessionRecord);
}

/**
 * UUID に対応するセッション記録を削除する。
 */
export async function removeSessionRecord(
  storage: StorageArea,
  uuid: string,
): Promise<void> {
  await storage.remove(sessionKey(uuid));
}

/** 拡張設定の既定アイドルロック分数（design.md 4.1.2）。 */
export const DEFAULT_IDLE_LOCK_MINUTES = 20;

/** 拡張設定の既定 TOTP 最小残秒数（design.md 3.5）。 */
export const DEFAULT_TOTP_MIN_REMAINING_SECONDS = 5;

/** 拡張設定の永続化キー。 */
const EXTENSION_SETTINGS_KEY = "settings:extension";

/** NH へ伝達する非秘匿の拡張設定値。 */
export interface ExtensionSettings {
  idleLockMinutes: number;
  totpMinRemainingSeconds: number;
}

/**
 * 拡張設定を読み込む。未保存の項目は既定値で補完する。
 */
export async function loadExtensionSettings(
  storage: StorageArea,
): Promise<ExtensionSettings> {
  const result = await storage.get(EXTENSION_SETTINGS_KEY);
  const stored = result[EXTENSION_SETTINGS_KEY] as
    | Partial<ExtensionSettings>
    | undefined;
  return {
    idleLockMinutes: stored?.idleLockMinutes ?? DEFAULT_IDLE_LOCK_MINUTES,
    totpMinRemainingSeconds:
      stored?.totpMinRemainingSeconds ?? DEFAULT_TOTP_MIN_REMAINING_SECONDS,
  };
}

/**
 * 拡張設定を部分更新して保存する。既存値（未保存は既定値）へマージして永続化する。
 */
export async function saveExtensionSettings(
  storage: StorageArea,
  settings: { idleLockMinutes?: number; totpMinRemainingSeconds?: number },
): Promise<void> {
  const current = await loadExtensionSettings(storage);
  const next: ExtensionSettings = {
    idleLockMinutes: settings.idleLockMinutes ?? current.idleLockMinutes,
    totpMinRemainingSeconds:
      settings.totpMinRemainingSeconds ?? current.totpMinRemainingSeconds,
  };
  await storage.set({ [EXTENSION_SETTINGS_KEY]: next });
}

/** 非秘匿メタデータキャッシュの永続化キー（task 8.1, requirements 3.4）。 */
const ACCOUNT_META_CACHE_KEY = "cache:accounts";

/**
 * 非秘匿の `AccountMeta[]`（UUID・アカウント ID・エイリアス・表示用ユーザー名・MFA 有無）を
 * 単一キーへ上書き保存する（requirements 3.4「再同期時は…キャッシュを上書き更新する」）。
 *
 * パスワード・TOTP シードは含めない（含めてはならない, requirements 3.3）。
 */
export async function saveAccountMetaCache(
  storage: StorageArea,
  accounts: readonly AccountMeta[],
): Promise<void> {
  await storage.set({ [ACCOUNT_META_CACHE_KEY]: accounts });
}

/**
 * キャッシュ済み `AccountMeta[]` を読み込む。未保存の場合は空配列を返す（task 8.1）。
 */
export async function loadAccountMetaCache(
  storage: StorageArea,
): Promise<readonly AccountMeta[]> {
  const result = await storage.get(ACCOUNT_META_CACHE_KEY);
  const value = result[ACCOUNT_META_CACHE_KEY];
  if (value === undefined) {
    return [];
  }
  return value as readonly AccountMeta[];
}

/**
 * 指定 UUID のエントリをキャッシュから除去して再永続化する（task 8.2, requirements 3.4 (a), S-3）。
 *
 * 真のオブジェクト欠落（アイテム削除・無効 UUID）を検知した際の即時無効化に用いる。
 * 該当エントリが無い（空キャッシュ含む）場合は現状維持の no-op。
 */
export async function invalidateAccountMetaEntry(
  storage: StorageArea,
  uuid: string,
): Promise<void> {
  const cached = await loadAccountMetaCache(storage);
  const next = cached.filter((account) => account.uuid !== uuid);
  if (next.length === cached.length) {
    return;
  }
  await saveAccountMetaCache(storage, next);
}
