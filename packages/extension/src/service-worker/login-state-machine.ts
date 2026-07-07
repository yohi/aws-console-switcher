/**
 * ログイン自動化ステートマシン（task 4.2）。
 *
 * ルーティング → アカウント ID（条件付き）→ 認証情報 → MFA（条件付き）→ 完了/失敗
 * の遷移を純粋関数＋副作用インジェクションで実装する。
 */
import {
  type AccountMeta,
  type FlowContext,
  type FlowError,
  type Result,
  makeFlowError,
} from "@acs/shared";
import { type CredentialProvider } from "../secrets/bitwarden-credential-provider.js";
import { type StorageArea } from "./storage.js";
import { classifyAndHandleSecretFetchError } from "./uuid-resync.js";
import { MFA_RETRY_LIMIT } from "./flow-alarms.js";

/**
 * Content Script への値注入を抽象化したポート。
 * 実際の `chrome.tabs.sendMessage` は adapter 実装で行う。
 */
export interface LoginMessenger {
  injectAccountId(
    tabId: number,
    accountId: string,
  ): Promise<Result<void, FlowError>>;
  injectCredentials(
    tabId: number,
    username: string,
    password: string,
  ): Promise<Result<void, FlowError>>;
  injectTotp(tabId: number, code: string): Promise<Result<void, FlowError>>;
}

/**
 * ステートマシンに入力される外部イベント。
 * `consoleRedirect` は SW の tabs.onUpdated から発行される（C-2）。
 */
export type LoginEvent =
  | { readonly event: "accountIdFieldShown" }
  | { readonly event: "credentialFieldShown" }
  | { readonly event: "mfaScreenShown" }
  | { readonly event: "authError" }
  | { readonly event: "consoleRedirect" }
  | { readonly event: "domTimeout" };

/**
 * ステートマシン処理結果。
 */
export type LoginAction =
  | { readonly step: FlowContext["step"]; readonly ctx?: FlowContext }
  | { readonly step: "done" }
  | { readonly step: "failed"; readonly error: FlowError };

/**
 * ログイン自動化ステートマシン。
 *
 * 揮発性シークレット（パスワード/TOTP）はこのクラスのメソッド呼び出し内のみで
 * 保持し、返却・永続化しない。
 */
export class LoginStateMachine {
  private readonly provider: CredentialProvider;
  private readonly messenger: LoginMessenger;
  /** 非秘匿メタデータキャッシュ。真のオブジェクト欠落時の UUID 無効化に用いる（task 8.2）。 */
  private readonly storage: StorageArea;

  constructor(
    provider: CredentialProvider,
    messenger: LoginMessenger,
    storage: StorageArea,
  ) {
    this.provider = provider;
    this.messenger = messenger;
    this.storage = storage;
  }

  async handleEvent(
    ctx: FlowContext,
    event: LoginEvent,
  ): Promise<LoginAction> {
    switch (ctx.step) {
      case "routing":
        return this.handleRouting(ctx, event);
      case "awaiting_account_id":
        return this.handleAwaitingAccountId(ctx, event);
      case "awaiting_credentials":
        return this.handleAwaitingCredentials(ctx, event);
      case "awaiting_mfa":
        return this.handleAwaitingMfa(ctx, event);
      default: {
        const _exhaustive: never = ctx.step;
        return { step: "failed", error: makeFlowError("invalid_configuration", `Unexpected step: ${_exhaustive}`) };
      }
    }
  }

  private async handleRouting(
    ctx: FlowContext,
    event: LoginEvent,
  ): Promise<LoginAction> {
    if (event.event === "accountIdFieldShown") {
      return { step: "awaiting_account_id" };
    }
    if (event.event === "credentialFieldShown") {
      return this.injectCredentials(ctx);
    }
    if (event.event === "mfaScreenShown") {
      // Cookie 記憶済みの MFA 有効アカウント等、まれに認証情報入力をスキップするケース
      return this.injectTotp(ctx);
    }
    if (event.event === "consoleRedirect") {
      return { step: "done" };
    }
    if (event.event === "authError" || event.event === "domTimeout") {
      return { step: "failed", error: makeFlowError("bad_password", "Authentication failed at routing step.") };
    }
    return { step: ctx.step };
  }

  private async handleAwaitingAccountId(
    ctx: FlowContext,
    event: LoginEvent,
  ): Promise<LoginAction> {
    if (event.event === "accountIdFieldShown") {
      const account = await this.loadAccount(ctx.uuid);
      if (!account.ok) {
        return { step: "failed", error: account.error };
      }
      const injectResult = await this.messenger.injectAccountId(
        ctx.tabId,
        account.value.accountId,
      );
      if (!injectResult.ok) {
        return { step: "failed", error: injectResult.error };
      }
      return { step: "awaiting_credentials" };
    }
    if (event.event === "credentialFieldShown") {
      // 既にアカウント ID が Cookie 記憶済みの場合
      return this.injectCredentials(ctx);
    }
    if (event.event === "authError" || event.event === "domTimeout") {
      return { step: "failed", error: makeFlowError("bad_password", "Failed to submit account ID.") };
    }
    return { step: ctx.step };
  }

  private async handleAwaitingCredentials(
    ctx: FlowContext,
    event: LoginEvent,
  ): Promise<LoginAction> {
    if (event.event === "credentialFieldShown") {
      return this.injectCredentials(ctx);
    }
    if (event.event === "mfaScreenShown") {
      return this.injectTotp(ctx);
    }
    if (event.event === "consoleRedirect") {
      return { step: "done" };
    }
    if (event.event === "authError") {
      return { step: "failed", error: makeFlowError("bad_password", "AWS rejected username or password.") };
    }
    if (event.event === "domTimeout") {
      return { step: "failed", error: makeFlowError("page_not_rendered", "Credentials form was not rendered in time.") };
    }
    return { step: ctx.step };
  }

  private async handleAwaitingMfa(
    ctx: FlowContext,
    event: LoginEvent,
  ): Promise<LoginAction> {
    if (event.event === "mfaScreenShown") {
      return this.injectTotp(ctx);
    }
    if (event.event === "consoleRedirect") {
      return { step: "done" };
    }
    if (event.event === "authError") {
      // design.md「Error Categories」: totp_rejected は残秒数を保証した次コードで 1 回のみ自動
      // 再試行する（M-2）。mfaRetryCount が上限未満なら新コードを取得して再注入し、上限到達時は
      // 自動再試行を打ち切って retriable:false で手動確認へ誘導する（error-presentation と整合）。
      if (ctx.mfaRetryCount < MFA_RETRY_LIMIT) {
        return this.retryTotp(ctx);
      }
      return {
        step: "failed",
        error: makeFlowError(
          "totp_rejected",
          "AWS rejected the TOTP code after the automatic retry limit.",
          { retriable: false },
        ),
      };
    }
    if (event.event === "domTimeout") {
      return { step: "failed", error: makeFlowError("page_not_rendered", "MFA form was not rendered in time.") };
    }
    return { step: ctx.step };
  }

  private async injectCredentials(ctx: FlowContext): Promise<LoginAction> {
    const credentials = await this.provider.getCredentials(ctx.uuid);
    if (!credentials.ok) {
      // task 8.2: 真のオブジェクト欠落時のみ当該 UUID をキャッシュから無効化し自動ログインを
      // 停止する。一時的前提条件エラーはキャッシュを保持したまま元のエラーを返す（3.4, S-3）。
      const error = await classifyAndHandleSecretFetchError(
        this.storage,
        ctx.uuid,
        credentials.error,
      );
      return { step: "failed", error };
    }
    const injectResult = await this.messenger.injectCredentials(
      ctx.tabId,
      credentials.value.username,
      credentials.value.password,
    );
    if (!injectResult.ok) {
      return { step: "failed", error: injectResult.error };
    }
    return { step: "awaiting_credentials" };
  }

  private async injectTotp(ctx: FlowContext): Promise<LoginAction> {
    const totp = await this.provider.getTotp(ctx.uuid);
    if (!totp.ok) {
      // task 8.2: getTotp の真のオブジェクト欠落も同様に UUID 無効化へ回す（3.4, S-3）。
      const error = await classifyAndHandleSecretFetchError(
        this.storage,
        ctx.uuid,
        totp.error,
      );
      return { step: "failed", error };
    }
    const injectResult = await this.messenger.injectTotp(
      ctx.tabId,
      totp.value.code,
    );
    if (!injectResult.ok) {
      return { step: "failed", error: injectResult.error };
    }
    return { step: "awaiting_mfa" };
  }

  /**
   * awaiting_mfa で totp_rejected を受けた際の 1 回限りの自動再試行（design.md「Error Categories」M-2）。
   *
   * 新しい TOTP コードを取得して再注入し、mfaRetryCount をインクリメントした FlowContext を
   * LoginAction.ctx に載せて呼び出し側へ返す（呼び出し側が storage へ永続化し、SW 再起動をまたいで
   * 上限を判定する）。取得・注入失敗時は該当エラーで failed とする。
   */
  private async retryTotp(ctx: FlowContext): Promise<LoginAction> {
    const totp = await this.provider.getTotp(ctx.uuid);
    if (!totp.ok) {
      const error = await classifyAndHandleSecretFetchError(
        this.storage,
        ctx.uuid,
        totp.error,
      );
      return { step: "failed", error };
    }
    const injectResult = await this.messenger.injectTotp(
      ctx.tabId,
      totp.value.code,
    );
    if (!injectResult.ok) {
      return { step: "failed", error: injectResult.error };
    }
    return {
      step: "awaiting_mfa",
      ctx: { ...ctx, mfaRetryCount: ctx.mfaRetryCount + 1 },
    };
  }

  private async loadAccount(
    uuid: string,
  ): Promise<Result<AccountMeta, FlowError>> {
    const accounts = await this.provider.listAccounts();
    if (!accounts.ok) {
      return accounts;
    }
    const account = accounts.value.find((a: AccountMeta) => a.uuid === uuid);
    if (!account) {
      return {
        ok: false,
        error: makeFlowError("invalid_configuration", `Account ${uuid} not found in cache.`),
      };
    }
    return { ok: true, value: account };
  }
}
