/**
 * Signin Content Script（task 5.2, design.md「SigninContentScript」/ 3.2, 3.5）。
 *
 * `signin.aws.amazon.com` / `*.signin.aws.amazon.com` に静的注入され、以下を担う:
 * - サインイン各ステップの DOM 検知（アカウント ID／認証情報／MFA／認証エラー）
 * - SW からの注入コマンド受信 → 値注入＋送信
 * - `MutationObserver` による SPA 的遷移の補完監視 → `signinDomEvent` 送出
 * - CAPTCHA 検知時の手動介入フォールバック（best-effort）
 *
 * 設計方針（selectors.ts と同じ）: DOM ロジックは **注入された DOM 参照**（`ParentNode` /
 * `Document` / `Element`）に対して動作する純粋関数として実装し、`document` / `chrome.*` の
 * グローバル参照はファイル末尾の薄いブートストラップ結線（item 10）にのみ閉じ込める。
 * これにより本体（items 1-9）は jsdom フィクスチャで単体テスト可能となる。
 *
 * 設計判断（SW → CS 注入コマンドの型）:
 * `LoginMessenger`（login-state-machine.ts）は SW 側の抽象であり、CS はそれを実装しない。
 * 代わりに SW が `chrome.tabs.sendMessage` で送る注入コマンドを CS が
 * `chrome.runtime.onMessage` で受信する。既存の「SW → CS」メッセージ形が無かったため、
 * 本モジュール固有の判別共用体 `SigninInjectionCommand` を新規定義する（最小・単体テスト可能）。
 */
import {
  type ExtMessage,
  type SelectorSet,
  type SigninDomEvent,
} from "@acs/shared";
import {
  DEFAULT_SELECTOR_SET,
  pickFirstMatch,
  resolveSelectorSet,
} from "./selectors.js";

/**
 * サインインページの分類状態。どの `SigninDomEvent` を送出するかを駆動する。
 * `accountId`（汎用エントリ）と `credentials`（Cookie 記憶済み）の区別が
 * design.md「アカウント ID 入力欄の有無で汎用エントリと Cookie 記憶済みを判別」に対応する
 * （専用関数は不要: この分類がそのまま判別結果となる）。
 */
export type PageState =
  | "accountId"
  | "credentials"
  | "mfa"
  | "authError"
  | "unknown";

/**
 * SW → CS の値注入コマンド（本モジュール固有の判別共用体）。
 * SW は `chrome.tabs.sendMessage(tabId, command)` で送り、CS は
 * `chrome.runtime.onMessage` で受信して `handleInjectionCommand` に委譲する。
 * 各コマンドは SW 側 `LoginMessenger`（injectAccountId / injectCredentials / injectTotp）の
 * CS 側対応物である。
 */
export type SigninInjectionCommand =
  | { readonly kind: "injectAccountId"; readonly accountId: string }
  | {
      readonly kind: "injectCredentials";
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: "injectTotp"; readonly code: string };

/** 検出済み認証情報フィールドの組。いずれも見つからなければ `null`。 */
export interface CredentialFields {
  readonly username: Element | null;
  readonly password: Element | null;
}

// --- 1. 検出器（1 SelectorSet フィールドにつき 1 純粋関数, pickFirstMatch パターン） ---

/** アカウント ID 入力欄を順序付きフォールバックで検出する。 */
export function detectAccountIdField(
  doc: ParentNode,
  selectors: SelectorSet,
): Element | null {
  return pickFirstMatch(selectors.accountIdInput, (sel) =>
    doc.querySelector(sel),
  );
}

/** ユーザー名・パスワード入力欄を検出する（Cookie 記憶分岐の判別材料）。 */
export function detectCredentialFields(
  doc: ParentNode,
  selectors: SelectorSet,
): CredentialFields {
  return {
    username: pickFirstMatch(selectors.usernameInput, (sel) =>
      doc.querySelector(sel),
    ),
    password: pickFirstMatch(selectors.passwordInput, (sel) =>
      doc.querySelector(sel),
    ),
  };
}

/** MFA（TOTP）入力欄を検出する。 */
export function detectMfaField(
  doc: ParentNode,
  selectors: SelectorSet,
): Element | null {
  return pickFirstMatch(selectors.mfaInput, (sel) => doc.querySelector(sel));
}

/** 認証失敗マーカー（M-4）を検出する。 */
export function detectAuthErrorMarker(
  doc: ParentNode,
  selectors: SelectorSet,
): Element | null {
  return pickFirstMatch(selectors.authErrorMarker, (sel) =>
    doc.querySelector(sel),
  );
}

/** 送信ボタンを検出する。 */
export function detectSubmitButton(
  doc: ParentNode,
  selectors: SelectorSet,
): Element | null {
  return pickFirstMatch(selectors.submitButton, (sel) =>
    doc.querySelector(sel),
  );
}

// --- 2-3. 値注入・送信（純粋・防御的） ---

/**
 * 要素へ値を注入し、フレームワークのリアクティブ監視向けに `input` イベントを発火する。
 * 要素が見つからず／`HTMLInputElement` でない（値設定不可）場合は `false` を返す。
 * @returns 注入に成功したか。
 */
export function injectValue(el: Element | null, value: string): boolean {
  // 防御的: null と非 input を弾く。instanceof で HTMLInputElement へ絞り込む
  // （ブラウザ／jsdom いずれも HTMLInputElement を提供する）。
  if (!(el instanceof HTMLInputElement)) {
    return false;
  }
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/**
 * 送信ボタンをクリックする。要素が無い／`HTMLElement` でない場合は `false`。
 * @returns 送信操作に成功したか。
 */
export function submitForm(button: Element | null): boolean {
  if (!(button instanceof HTMLElement)) {
    return false;
  }
  button.click();
  return true;
}

// --- 4. ページ状態分類（純粋。送出イベントを駆動） ---

/**
 * ページ状態を優先度順に分類する:
 * 認証エラー → MFA → 認証情報（username+password 両方）→ アカウント ID → unknown。
 * `accountId` / `credentials` の分岐が Cookie 記憶分岐の判別に対応する（design.md 3.2 Step 1）。
 */
export function classifyPageState(
  doc: ParentNode,
  selectors: SelectorSet,
): PageState {
  if (detectAuthErrorMarker(doc, selectors) !== null) {
    return "authError";
  }
  if (detectMfaField(doc, selectors) !== null) {
    return "mfa";
  }
  const credentials = detectCredentialFields(doc, selectors);
  if (credentials.username !== null && credentials.password !== null) {
    return "credentials";
  }
  if (detectAccountIdField(doc, selectors) !== null) {
    return "accountId";
  }
  return "unknown";
}

/**
 * ページ状態を対応する `SigninDomEvent` に写像する。`unknown` は送出イベント無し（`null`）。
 * `consoleRedirect` は SW の `tabs.onUpdated` で検知するため含めない（C-2）。
 */
export function pageStateToDomEvent(state: PageState): SigninDomEvent | null {
  switch (state) {
    case "accountId":
      return "accountIdFieldShown";
    case "credentials":
      return "credentialFieldShown";
    case "mfa":
      return "mfaScreenShown";
    case "authError":
      return "authError";
    case "unknown":
      return null;
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      return null;
    }
  }
}

// --- 5. MutationObserver による状態監視（薄いラッパ。分類は純粋関数） ---

/**
 * `classifyPageState` を `MutationObserver` で包み、DOM 変化（SPA 的遷移）ごとに再判定する。
 * 初回状態を同期的に 1 度通知し、以降は状態が変化したときのみ `onStateChange` を呼ぶ。
 * @returns 監視を停止する disconnect 関数。
 */
export function observePageState(
  doc: Document,
  selectors: SelectorSet,
  onStateChange: (state: PageState) => void,
): () => void {
  let lastState: PageState | null = null;
  const check = (): void => {
    const state = classifyPageState(doc, selectors);
    if (state !== lastState) {
      lastState = state;
      onStateChange(state);
    }
  };
  // 初期状態を同期通知（document_idle 時点で既に描画済みのケースを捕捉）。
  check();
  const observer = new MutationObserver(check);
  const target: Node = doc.body ?? doc.documentElement;
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  return () => observer.disconnect();
}

// --- 6. メッセージ送信ヘルパ（CS → SW） ---

/**
 * `signinDomEvent` を `chrome.runtime.sendMessage` で SW へ送出する。
 * DOM 検知イベントには常に `uuid` を含める（C-1）。
 */
export function sendSigninDomEvent(
  runtime: Pick<typeof chrome.runtime, "sendMessage">,
  tabId: number,
  uuid: string,
  event: SigninDomEvent,
): void {
  const message: Extract<ExtMessage, { kind: "signinDomEvent" }> = {
    kind: "signinDomEvent",
    tabId,
    uuid,
    event,
  };
  void runtime.sendMessage(message);
}

// --- 7. 注入コマンド処理（SW → CS 受信ハンドラの本体, 純粋） ---

/**
 * SW からの `SigninInjectionCommand` を該当検出器＋注入器へ振り分け、注入に成功した場合のみ
 * 送信ボタンをクリックする（design.md「アカウント ID／認証情報／TOTP を注入して送信する」）。
 * 送信は「注入成功」を前提とする best-effort（注入失敗時・送信ボタン未検出時は送信しない）で、
 * 返り値も **注入の成否**を表す（送信結果とは独立）。
 * @returns 対象フィールドへの値注入がすべて成功したか。
 */
export function handleInjectionCommand(
  doc: ParentNode,
  selectors: SelectorSet,
  command: SigninInjectionCommand,
): boolean {
  switch (command.kind) {
    case "injectAccountId": {
      const injected = injectValue(
        detectAccountIdField(doc, selectors),
        command.accountId,
      );
      if (injected) {
        submitForm(detectSubmitButton(doc, selectors));
      }
      return injected;
    }
    case "injectCredentials": {
      const fields = detectCredentialFields(doc, selectors);
      const usernameInjected = injectValue(fields.username, command.username);
      const passwordInjected = injectValue(fields.password, command.password);
      const injected = usernameInjected && passwordInjected;
      if (injected) {
        submitForm(detectSubmitButton(doc, selectors));
      }
      return injected;
    }
    case "injectTotp": {
      const injected = injectValue(
        detectMfaField(doc, selectors),
        command.code,
      );
      if (injected) {
        submitForm(detectSubmitButton(doc, selectors));
      }
      return injected;
    }
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return false;
    }
  }
}

// --- 9. CAPTCHA / ボット検知フォールバック（best-effort スタブ） ---

/** 一般的な CAPTCHA / bot-detection マーカー（best-effort。網羅は目的としない）。 */
const CAPTCHA_SELECTORS: readonly string[] = [
  "[data-captcha]",
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  ".g-recaptcha",
];

/**
 * CAPTCHA / bot-detection の兆候を検知する（best-effort）。
 * design.md「高速なプログラム的送信は CAPTCHA を誘発しうるため、検知時は手動介入へ
 * フォールバックする」に基づき、検知時は自動送信を差し控える判断材料とする
 * （自動 CAPTCHA 解決は行わない）。
 */
export function detectCaptcha(doc: ParentNode): boolean {
  return CAPTCHA_SELECTORS.some((sel) => doc.querySelector(sel) !== null);
}

// --- 10. ブートストラップ（chrome.* 結線, 薄い未テスト境界） ---
//
// 設計トレードオフ（tabId / uuid）:
// content script は自身の tabId を取得する native な手段を持たない（chrome.tabs は
// content script から利用不可、chrome.tabs.getCurrent() も content script では undefined）。
// 同様に、フローを識別する uuid は SW の FlowContext（tabId キー）にのみ存在し CS は知らない。
// 一方 ExtMessage.signinDomEvent は tabId: number と uuid: string を必須とする。
//
// 本実装は tabId をセンチネル -1、uuid を空文字で初期化し、SW が将来「初期化コマンド」で
// これらを通知する経路（chrome.tabs.sendMessage 経由）を追加した時点で更新できる構造とする。
// 現状の message-router.handleSigninDomEvent は message.tabId で FlowContext を引くため、
// センチネル値のままでは突合に失敗する。したがって送信系ブートストラップは best-effort であり、
// 正しい tabId/uuid の供給は SW 側配線（本 task 5.2 の対象外・変更禁止領域）に依存する。
//
// この結線は service-worker.ts と同様の「薄い未テスト境界シム」であり、
// 本モジュールの成果物は純粋関数（items 1-9）である。型検査が通ることのみを保証する。
const CS_TABID_SENTINEL = -1;

/** 受信値が `SigninInjectionCommand` か軽量に判定する（境界バリデーション）。 */
function isSigninInjectionCommand(
  value: unknown,
): value is SigninInjectionCommand {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const command = value as Record<string, unknown>;
  switch (command["kind"]) {
    case "injectAccountId":
      return typeof command["accountId"] === "string";
    case "injectCredentials":
      return (
        typeof command["username"] === "string" &&
        typeof command["password"] === "string"
      );
    case "injectTotp":
      return typeof command["code"] === "string";
    default:
      return false;
  }
}

/**
 * content script の実行時結線。実 DOM と chrome ランタイムが存在する場合のみ起動する。
 * 純粋関数（上記）を実 `document` / `chrome.runtime` に束ねるだけの薄いシム。
 */
function bootstrapSigninContentScript(): void {
  const selectors = resolveSelectorSet(DEFAULT_SELECTOR_SET);
  // SW が初期化コマンドで上書きするまではセンチネル（上記トレードオフ参照）。
  let currentTabId = CS_TABID_SENTINEL;
  let currentUuid = "";

  // SW → CS: 注入コマンドを受信し、CAPTCHA 未検知時のみ注入＋送信する。
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isSigninInjectionCommand(message)) {
      return;
    }
    if (detectCaptcha(document)) {
      // 手動介入へフォールバック: 自動送信を差し控える（CAPTCHA 誘発回避）。
      return;
    }
    handleInjectionCommand(document, selectors, message);
  });

  // CS → SW: 状態変化を監視し、対応する signinDomEvent を送出する。
  observePageState(document, selectors, (state) => {
    if (detectCaptcha(document)) {
      return;
    }
    const event = pageStateToDomEvent(state);
    if (event !== null) {
      sendSigninDomEvent(chrome.runtime, currentTabId, currentUuid, event);
    }
  });
}

if (
  typeof document !== "undefined" &&
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage !== undefined
) {
  bootstrapSigninContentScript();
}
