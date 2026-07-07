/**
 * Popup エントリ（DOM 配線, task 7.1 / 7.2）。
 *
 * ビジネスロジック（一覧結合・検索・状態判定・エラー写像）は純粋関数として
 * `account-list.ts` / `error-presentation.ts` に切り出し単体テスト済み。本ファイルは
 * それらを DOM と `chrome.runtime` メッセージングに配線する薄いグルーに徹する。
 * DOM 依存部はファイル末尾で `typeof document !== "undefined"` ガードし、非ブラウザの
 * 型検査コンテキストでも import 可能に保つ（content-scripts と同じ規約）。
 *
 * 秘匿境界（最重要）: マスターパスワードは入力欄から読み取り後ただちに欄をクリアし、
 * `unlock` メッセージ送信の同期呼び出し以外ではいかなる変数にも保持しない（4.1.1, design.md 秘匿境界）。
 *
 * MVP 上の簡略化:
 * - セッション状態の一次情報源（`SessionRecord`）を Popup へ返す経路は task 5.3 / 8.1 で
 *   実装するため、現時点では空配列で結合する（全アカウントが「未ログイン」表示になる）。
 *   結合・状態判定の純粋関数は将来のセッション供給に備えて実装・検証済み。
 * - 待機中アカウントの追跡は Popup メモリ上の楽観的集合で行い（サーバ側フロー状態の
 *   正本ではない）、「サインイン」押下で待機扱いにして「キャンセル」を提示する。
 */
import type {
  AccountMeta,
  ExtMessage,
  FlowError,
  SessionRecord,
} from "@acs/shared";
import { isAccountMeta, isFlowError, makeFlowError } from "@acs/shared";
import {
  type AccountListItem,
  type SessionStateLabel,
  describeSessionState,
  filterAccounts,
  mergeAccountsWithSessions,
} from "./account-list.js";
import { presentError } from "./error-presentation.js";

/** ルーター応答の Popup 側表現（SW の `RouterResponse` に対応）。 */
type PopupResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: FlowError };

/** Popup が配線対象とする DOM 要素の束。 */
interface PopupElements {
  readonly search: HTMLInputElement;
  readonly list: HTMLUListElement;
  readonly syncBtn: HTMLButtonElement;
  readonly lockBtn: HTMLButtonElement;
  readonly unlockForm: HTMLFormElement;
  readonly unlockSection: HTMLElement;
  readonly password: HTMLInputElement;
  readonly banner: HTMLElement;
}

/**
 * セッション記録は現状 Popup へ供給されない（MVP 簡略化, task 5.3 / 8.1 で対応）。
 * 空配列で結合し、状態判定を保守的に「未ログイン」へ倒す。
 */
const EMPTY_SESSIONS: readonly SessionRecord[] = [];

/** 値が `PopupResponse` の形か判定する境界ガード（未知応答を弾く）。 */
function isPopupResponse(value: unknown): value is PopupResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["ok"] === true) {
    return true;
  }
  if (record["ok"] === false) {
    return isFlowError(record["error"]);
  }
  return false;
}

/** `{ accounts: AccountMeta[] }` 形の応答値から健全な `AccountMeta` のみ取り出す。 */
function extractAccounts(value: unknown): readonly AccountMeta[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const accounts = (value as Record<string, unknown>)["accounts"];
  if (!Array.isArray(accounts)) {
    return [];
  }
  return accounts.filter(isAccountMeta);
}

/** 状態ラベルを控えめなエンドユーザー向け日本語へ写像する（3.1「不確定」表示）。 */
function stateText(state: SessionStateLabel): string {
  switch (state) {
    case "signed-in":
      return "ログイン中";
    case "unknown":
      return "不確定";
    case "not-signed-in":
      return "未ログイン";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** 必須 DOM 要素を型安全に解決する。1 つでも欠ければ `null`（欠落要素名は console.error で報告する）。 */
function queryElements(doc: Document): PopupElements | null {
  const search = doc.getElementById("search");
  const list = doc.getElementById("account-list");
  const syncBtn = doc.getElementById("sync-btn");
  const lockBtn = doc.getElementById("lock-btn");
  const unlockForm = doc.getElementById("unlock-form");
  const unlockSection = doc.getElementById("unlock-section");
  const password = doc.getElementById("master-password");
  const banner = doc.getElementById("banner");
  if (
    search instanceof HTMLInputElement &&
    list instanceof HTMLUListElement &&
    syncBtn instanceof HTMLButtonElement &&
    lockBtn instanceof HTMLButtonElement &&
    unlockForm instanceof HTMLFormElement &&
    unlockSection instanceof HTMLElement &&
    password instanceof HTMLInputElement &&
    banner instanceof HTMLElement
  ) {
    return {
      search,
      list,
      syncBtn,
      lockBtn,
      unlockForm,
      unlockSection,
      password,
      banner,
    };
  }
  const missing = Object.entries({
    search,
    list,
    syncBtn,
    lockBtn,
    unlockForm,
    unlockSection,
    password,
    banner,
  })
    .filter(([, el]) => el === null)
    .map(([name]) => name);
  console.error(
    `Popup の必須 DOM 要素を解決できませんでした（popup.html の構造変更を確認してください）。` +
      (missing.length > 0
        ? `欠落した要素: ${missing.join(", ")}`
        : "要素は存在するが期待する型と一致しません。"),
  );
  return null;
}

/**
 * Popup を初期化し、DOM とメッセージングを配線する。
 * 状態はすべてこのクロージャ内に閉じ込め、モジュールスコープを汚さない。
 */
function bootstrapPopup(doc: Document): void {
  const resolved = queryElements(doc);
  if (resolved === null) {
    return;
  }
  // クロージャ内でも非 null 型を保つため、絞り込み済みの値を非 null 型の const へ束ねる。
  const els: PopupElements = resolved;

  // --- Popup ローカル状態 -------------------------------------------------
  let accounts: readonly AccountMeta[] = [];
  let query = "";
  /** 楽観的な待機中集合（キャンセル提示用。サーバ側フロー状態の正本ではない）。 */
  const inFlight = new Set<string>();

  // --- メッセージング境界 --------------------------------------------------
  async function send(message: ExtMessage): Promise<PopupResponse> {
    const raw: unknown = await chrome.runtime.sendMessage(message);
    if (isPopupResponse(raw)) {
      return raw;
    }
    return {
      ok: false,
      error: makeFlowError(
        "host_disconnected",
        "Service Worker から予期しない応答を受信しました。",
      ),
    };
  }

  // --- バナー --------------------------------------------------------------
  function clearBanner(): void {
    els.banner.replaceChildren();
    els.banner.hidden = true;
  }

  function showBanner(error: FlowError, retry?: () => void): void {
    const presentation = presentError(error);
    els.banner.replaceChildren();

    const headline = doc.createElement("p");
    headline.className = "banner-headline";
    headline.textContent = presentation.headline;
    els.banner.appendChild(headline);

    const isVaultLocked =
      error.category === "precondition" && error.code === "vault_locked";
    if (isVaultLocked || retry !== undefined) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = presentation.action;
      button.addEventListener("click", () => {
        if (isVaultLocked) {
          els.unlockSection.hidden = false;
          els.password.focus();
        } else if (retry !== undefined) {
          retry();
        }
      });
      els.banner.appendChild(button);
    } else {
      // Popup から解決できない行動（例: bw login・手動確認）はヒント表示に留める。
      const hint = doc.createElement("span");
      hint.className = "banner-action";
      hint.textContent = `対応: ${presentation.action}`;
      els.banner.appendChild(hint);
    }
    els.banner.hidden = false;
  }

  // --- 描画 ----------------------------------------------------------------
  function renderRow(item: AccountListItem): HTMLLIElement {
    const row = doc.createElement("li");
    row.className = "account-row";

    const info = doc.createElement("div");
    info.className = "account-info";
    const name = doc.createElement("span");
    name.className = "account-name";
    name.textContent = item.meta.alias ?? item.meta.accountId;
    const sub = doc.createElement("span");
    sub.className = "account-meta";
    sub.textContent = `${item.meta.accountId} · ${item.meta.username}`;
    info.append(name, sub);

    const state = describeSessionState(item);
    const badge = doc.createElement("span");
    badge.className = `state-badge state-${state}`;
    badge.textContent = stateText(state);

    const uuid = item.meta.uuid;
    const action = doc.createElement("button");
    action.type = "button";
    if (inFlight.has(uuid)) {
      action.textContent = "キャンセル";
      action.addEventListener("click", () => {
        void onCancel(uuid);
      });
    } else {
      action.textContent = "サインイン";
      action.className = "primary";
      action.addEventListener("click", () => {
        void onSignIn(uuid);
      });
    }

    row.append(info, badge, action);
    return row;
  }

  function render(): void {
    const items = filterAccounts(
      mergeAccountsWithSessions(accounts, EMPTY_SESSIONS),
      query,
    );
    els.list.replaceChildren();
    if (items.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "empty";
      empty.textContent =
        accounts.length === 0
          ? "アカウントがありません。アンロックまたは同期してください。"
          : "一致するアカウントがありません。";
      els.list.appendChild(empty);
      return;
    }
    for (const item of items) {
      els.list.appendChild(renderRow(item));
    }
  }

  // --- アクション ----------------------------------------------------------
  async function loadAccounts(
    message: { readonly kind: "listAccounts" } | { readonly kind: "syncAccounts" },
  ): Promise<void> {
    clearBanner();
    const response = await send(message);
    if (!response.ok) {
      showBanner(response.error);
      return;
    }
    accounts = extractAccounts(response.value);
    render();
  }

  async function onSignIn(uuid: string): Promise<void> {
    clearBanner();
    const response = await send({ kind: "startLogin", uuid });
    if (!response.ok) {
      // 失敗状態からの再試行操作を提供する（3.5, M-5）。
      showBanner(response.error, () => {
        void onRetry(uuid);
      });
      return;
    }
    inFlight.add(uuid);
    render();
  }

  async function onCancel(uuid: string): Promise<void> {
    clearBanner();
    const response = await send({ kind: "cancelLogin", uuid });
    if (!response.ok) {
      showBanner(response.error);
      return;
    }
    inFlight.delete(uuid);
    render();
  }

  async function onRetry(uuid: string): Promise<void> {
    clearBanner();
    // 失敗フローを idle へ戻してから再度サインインを試みる（M-5）。
    await send({ kind: "retryLogin", uuid });
    inFlight.delete(uuid);
    await onSignIn(uuid);
  }

  async function onUnlock(): Promise<void> {
    clearBanner();
    // 秘匿境界: 入力欄から読み取り後、送信の同期呼び出し前に欄をクリアする。
    // 以降 masterPassword はこのローカル定数以外に一切保持しない。
    const masterPassword = els.password.value;
    els.password.value = "";
    const response = await send({ kind: "unlock", masterPassword });
    if (!response.ok) {
      showBanner(response.error);
      return;
    }
    // アンロック応答はメタデータ再同期結果（accounts）を含む（message-router unlock）。
    els.unlockSection.hidden = true;
    accounts = extractAccounts(response.value);
    render();
  }

  async function onLock(): Promise<void> {
    clearBanner();
    const response = await send({ kind: "lock" });
    if (!response.ok) {
      showBanner(response.error);
      return;
    }
    els.unlockSection.hidden = false;
  }

  // --- イベント配線 --------------------------------------------------------
  els.search.addEventListener("input", () => {
    query = els.search.value;
    render();
  });
  els.syncBtn.addEventListener("click", () => {
    void loadAccounts({ kind: "syncAccounts" });
  });
  els.lockBtn.addEventListener("click", () => {
    void onLock();
  });
  els.unlockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void onUnlock();
  });

  // 初回ロード: 一覧取得。Vault ロック等は precondition エラーとしてバナー表示される。
  void loadAccounts({ kind: "listAccounts" });
}

// 動的ブートストラップ（実ブラウザでのみ実行。型検査/非 DOM import は素通り）。
if (
  typeof document !== "undefined" &&
  typeof chrome !== "undefined" &&
  chrome.runtime?.sendMessage !== undefined
) {
  bootstrapPopup(document);
}
