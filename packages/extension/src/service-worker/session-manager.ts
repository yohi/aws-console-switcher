/**
 * SessionManager（複数セッション併存・前面化・LRU 退避, task 6.1 / 6.2）。
 *
 * design.md「Ports（将来 SSO 対応の抽象, 4.2）」の `SessionManager` 契約
 * （`getActiveSessions` / `switchTo` / `evictIfNeeded`）と requirements 3.2.1 を実装する。
 * 将来の SSO 移行を見据え、message-router / Chrome API から疎結合な独立ポートとして構築する。
 *
 * 主要な設計判断（design.md「Ports」直下の 3 箇条）:
 * - **switchTo の実体（C-3）**: `SessionRecord.tabId` を用い `tabs.update(tabId, {active:true})`
 *   ＋ `windows.update(windowId, {focused:true})` で前面化する。`tabId` が無効（タブ閉鎖）なら
 *   新規ログインへフォールバックする。
 * - **evictIfNeeded の実体（M-6）**: `lastAccessedAt` 昇順で最古を選び `SessionRecord` のみ削除する
 *   （AWS 側サインアウト DOM 操作は行わない）。上限判定は `getActiveSessions().length >= 5` の場合のみ。
 * - **並行 switchTo の排他制御（TOCTOU 対策, 3.2.1）**: 「上限判定 → 退避 → 追加」のクリティカル
 *   セクションを SW インメモリの単一 Promise チェーン（直列化キュー）でラップし、同時に 1 呼び出しの
 *   みが進入できるようにする。SW は単一インスタンス・シングルスレッドのため、`chrome.storage.local`
 *   側ロックは不要（SW 休止・再起動時はキューも進行中呼び出しも共に失われるため整合性は保たれる）。
 * - **lastAccessedAt の更新**: `done` 時に `signedInAt` と同値で初期化（task 4.3 の recordSession）、
 *   `switchTo` 実行時に現在時刻へ更新、さらに `tabs.onActivated` で追跡中セッションの `tabId` と一致
 *   した活性化を反映する（switchTo 非経由の利用が LRU 退避対象になるのを防ぐ, Issue 4）。
 */
import {
  type FlowError,
  type Result,
  type SessionRecord,
  makeFlowError,
  ok,
} from "@acs/shared";
import {
  type StorageArea,
  loadSessionRecords,
  removeSessionRecord,
  saveSessionRecord,
} from "./storage.js";

/** 同時併存できるセッションの上限（design.md 3.2.1）。 */
export const MAX_CONCURRENT_SESSIONS = 5;

/**
 * `chrome.tabs` から SessionManager が必要とするメソッドのみを切り出した抽象
 * （既存の `TabsApi` / `AlarmsApi` と同じ DI スタイル）。
 */
export interface SessionTabsApi {
  /**
   * 対象タブを活性化する。
   *
   * 前提（フォールバック検知の根拠）: `chrome.tabs.update` は**閉鎖済み/無効な tabId に対して
   * Promise を reject する**（"No tab with id: N."）。本実装は reject（throw）を「タブ無効」と
   * 見なし新規ログインへフォールバックする。成功時は前面化対象の `windowId` を含む Tab を返す。
   */
  update(
    tabId: number,
    updateProperties: { active?: boolean },
  ): Promise<{ id?: number; windowId?: number } | undefined>;
  /**
   * タブ活性化イベント。ユーザーの直接タブ操作を lastAccessedAt に反映するために購読する。
   * コールバック戻り値はテスト観測のため `void | Promise<void>` を許容する（既存 tab-watchers の
   * `TabsApi` と同じ規約。本番では Chrome が戻り値を無視するため fire-and-forget）。
   */
  onActivated: {
    addListener(
      callback: (activeInfo: { tabId: number }) => void | Promise<void>,
    ): void;
  };
}

/**
 * `chrome.windows` から SessionManager が必要とするメソッドのみを切り出した抽象。
 */
export interface SessionWindowsApi {
  update(
    windowId: number,
    updateProperties: { focused?: boolean },
  ): Promise<unknown>;
}

/**
 * SessionManager が依存する外部リソース。
 */
export interface SessionManagerDeps {
  readonly storage: StorageArea;
  readonly tabs: SessionTabsApi;
  readonly windows: SessionWindowsApi;
  /**
   * 「tabId 無効 or 未サインイン」時の新規ログイン起動コールバック。
   * 呼び出し側（例: message-router.ts）が実際の `startLogin` 起動クロージャを供給し、
   * 本モジュールを message-router から疎結合に保つ。
   */
  readonly onNewLoginRequired: (uuid: string) => Promise<void> | void;
}

/**
 * セッションマネージャ・ポート（design.md「Ports（将来 SSO 対応の抽象, 4.2）」）。
 */
export interface SessionManager {
  getActiveSessions(): Promise<readonly SessionRecord[]>;
  /** 既存は前面化、未サインイン/タブ無効は新規ログインへフォールバックする。 */
  switchTo(uuid: string): Promise<Result<void, FlowError>>;
  /** 同時上限 5 超過時に LRU 退避する（standalone 公開 API）。 */
  evictIfNeeded(): Promise<void>;
}

/**
 * SessionManager を生成する。構築時に一度だけ `tabs.onActivated` を購読する。
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  // TOCTOU 対策の直列化キュー（SW インスタンス内メモリ, design.md「並行 switchTo の排他制御」）。
  let serializationQueue: Promise<unknown> = Promise.resolve();

  /**
   * `fn` を直列化キューへ連結し、同時に 1 つのみ実行されることを保証する。
   * キュー追跡用の代入には `.catch(() => {})` を挟み、ある区間の reject が後続を恒久的に
   * 壊さないようにしつつ、実際の結果/エラーは呼び出し元へそのまま伝播する（既知パターン）。
   */
  function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = serializationQueue.then(fn);
    serializationQueue = result.catch(() => {});
    return result;
  }

  /**
   * 上限判定 → 最古退避のクリティカルセクション本体（未直列化のコア）。
   * `evictIfNeeded()` と `switchTo` の新規ログイン経路の双方が同一キュー経由で呼び出す。
   * `getActiveSessions().length >= 5` の場合のみ `lastAccessedAt` 昇順で最古 1 件を削除する。
   */
  async function evictOldestIfAtCap(): Promise<void> {
    const sessions = await loadSessionRecords(deps.storage);
    if (sessions.length < MAX_CONCURRENT_SESSIONS) {
      return;
    }
    let oldest = sessions[0];
    if (oldest === undefined) {
      return;
    }
    for (const session of sessions) {
      if (session.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = session;
      }
    }
    await removeSessionRecord(deps.storage, oldest.uuid);
  }

  /**
   * 活性化タブが追跡中セッションの `tabId` と一致したら lastAccessedAt を現在時刻へ更新する
   * （switchTo 非経由のタブ利用が LRU 退避対象になるのを防ぐ, Issue 4）。一致しなければ何もしない。
   * `uuid` ではなく `tabId` で引く点に注意。
   */
  async function touchSessionByTabId(tabId: number): Promise<void> {
    const sessions = await loadSessionRecords(deps.storage);
    const match = sessions.find((session) => session.tabId === tabId);
    if (match === undefined) {
      return;
    }
    await saveSessionRecord(deps.storage, {
      ...match,
      lastAccessedAt: new Date().toISOString(),
    });
  }

  deps.tabs.onActivated.addListener((activeInfo) =>
    touchSessionByTabId(activeInfo.tabId),
  );

  async function getActiveSessions(): Promise<readonly SessionRecord[]> {
    return loadSessionRecords(deps.storage);
  }

  /**
   * 新規ログイン経路（未サインイン or タブ無効）。上限判定 → 退避 → onNewLoginRequired を
   * 単一クリティカルセクションとして直列化する。onNewLoginRequired が（最終的な）新規セッション
   * 追加のトリガーであるため、追加トリガーごと直列化しなければ並行呼び出しが上限判定を素通りして
   * 一時的に上限を超過しうる（design.md「並行 switchTo の排他制御」）。
   */
  async function triggerNewLogin(uuid: string): Promise<Result<void, FlowError>> {
    try {
      await runSerialized(async () => {
        await evictOldestIfAtCap();
        await deps.onNewLoginRequired(uuid);
      });
      return ok(undefined);
    } catch (error) {
      // switchTo の Result 契約（reject しない）を守るため、onNewLoginRequired 由来の例外を
      // FlowError へ変換して返す（runSerialized 自体は fn() の reject をそのまま伝播するため）。
      return {
        ok: false,
        error: makeFlowError(
          "invalid_configuration",
          `Failed to start a new login flow: ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }
  }

  /**
   * 対象アカウントを前面化する。既存セッションがあり対象タブが有効なら前面化し、
   * 未サインイン or タブ無効なら新規ログインへフォールバックする。
   *
   * 実装メモ: 本ポートの switchTo の責務は「前面化 vs 新規ログイン」の判定と正しい経路の起動まで。
   * 実際の DOM ログイン自動化は task 4 の LoginStateMachine / startLogin（`onNewLoginRequired`
   * 経由で起動される非同期フロー）が担うため、新規ログイン経路では起動後ただちに成功で返す。
   */
  async function switchTo(uuid: string): Promise<Result<void, FlowError>> {
    const sessions = await loadSessionRecords(deps.storage);
    const record = sessions.find((session) => session.uuid === uuid);
    if (record !== undefined) {
      try {
        const updated = await deps.tabs.update(record.tabId, { active: true });
        const windowId = updated?.windowId;
        if (windowId !== undefined) {
          try {
            await deps.windows.update(windowId, { focused: true });
          } catch {
            // windows.update の失敗はタブの有効性と無関係の best-effort。前面化自体は続行する。
          }
        }
        await saveSessionRecord(deps.storage, {
          ...record,
          lastAccessedAt: new Date().toISOString(),
        });
        return ok(undefined);
      } catch {
        // tabs.update の reject = タブ閉鎖/無効。新規ログインへフォールバックする（C-3）。
      }
    }
    return triggerNewLogin(uuid);
  }

  async function evictIfNeeded(): Promise<void> {
    await runSerialized(() => evictOldestIfAtCap());
  }

  return { getActiveSessions, switchTo, evictIfNeeded };
}
