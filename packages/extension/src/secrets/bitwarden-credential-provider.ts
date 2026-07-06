/**
 * Bitwarden 用 CredentialProvider（task 3.2）。
 *
 * SecretSourceAdapter（NativeMessagingAdapter 等）を通じて Vault から
 * オンデマンドにアカウントメタデータ・認証情報・TOTP を取得する。
 */
import {
  type AccountMeta,
  type FlowError,
  type HostRequest,
  type HostResponse,
  type Result,
  isAccountMeta,
  makeFlowError,
} from "@acs/shared";

/**
 * SecretSourceAdapter ポート。
 * design.md §4.2: 取得経路（Native Messaging / bw serve）を差し替え可能にする。
 */
export interface SecretSourceAdapter {
  send(request: Omit<HostRequest, "requestId">): Promise<Result<HostResponse, FlowError>>;
}

/**
 * CredentialProvider ポート（design.md §4.2）。
 * 中核は本抽象にのみ依存し、Bitwarden 固有処理は実装に閉じる。
 */
export interface CredentialProvider {
  listAccounts(): Promise<Result<readonly AccountMeta[], FlowError>>;
  getCredentials(
    uuid: string,
  ): Promise<Result<{ readonly username: string; readonly password: string }, FlowError>>;
  getTotp(
    uuid: string,
  ): Promise<Result<{ readonly code: string; readonly remainingSeconds: number }, FlowError>>;
}

/**
 * Bitwarden Vault 用 CredentialProvider 実装。
 */
export class BitwardenCredentialProvider implements CredentialProvider {
  private readonly adapter: SecretSourceAdapter;
  private readonly folderName: string;

  constructor(
    adapter: SecretSourceAdapter,
    folderName = "AWS Accounts",
  ) {
    this.adapter = adapter;
    this.folderName = folderName;
  }

  async listAccounts(): Promise<Result<readonly AccountMeta[], FlowError>> {
    const foldersResult = await this.adapter.send({ type: "listFolders" } as Omit<HostRequest, "requestId">);
    if (!foldersResult.ok) {
      return foldersResult;
    }
    if (foldersResult.value.type !== "folders") {
      return {
        ok: false,
        error: makeFlowError(
          "host_disconnected",
          "Expected folders response from native host.",
        ),
      };
    }
    const folder = foldersResult.value.folders.find(
      (f: { readonly id: string; readonly name: string }) => f.name === this.folderName,
    );
    if (!folder) {
      return {
        ok: false,
        error: makeFlowError(
          "invalid_configuration",
          `Bitwarden folder "${this.folderName}" not found.`,
        ),
      };
    }

    const itemsResult = await this.adapter.send({
      type: "listItems",
      folderId: folder.id,
    } as Omit<HostRequest, "requestId">);
    if (!itemsResult.ok) {
      return itemsResult;
    }
    if (itemsResult.value.type !== "items") {
      return {
        ok: false,
        error: makeFlowError(
          "host_disconnected",
          "Expected items response from native host.",
        ),
      };
    }

    const items = itemsResult.value.items;
    if (!items.every(isAccountMeta)) {
      return {
        ok: false,
        error: makeFlowError(
          "host_disconnected",
          "Native host returned malformed account metadata.",
        ),
      };
    }

    return { ok: true, value: items };
  }

  async getCredentials(
    uuid: string,
  ): Promise<Result<{ readonly username: string; readonly password: string }, FlowError>> {
    const result = await this.adapter.send({ type: "getItem", uuid } as Omit<HostRequest, "requestId">);
    if (!result.ok) {
      return result;
    }
    const response = result.value;
    if (response.type !== "item") {
      return {
        ok: false,
        error: makeFlowError(
          "host_disconnected",
          "Expected item response from native host.",
        ),
      };
    }
    return {
      ok: true,
      value: {
        username: response.username,
        password: response.password,
      },
    };
  }

  async getTotp(
    uuid: string,
  ): Promise<Result<{ readonly code: string; readonly remainingSeconds: number }, FlowError>> {
    const result = await this.adapter.send({ type: "getTotp", uuid } as Omit<HostRequest, "requestId">);
    if (!result.ok) {
      return result;
    }
    const response = result.value;
    if (response.type !== "totp") {
      return {
        ok: false,
        error: makeFlowError(
          "host_disconnected",
          "Expected TOTP response from native host.",
        ),
      };
    }
    return {
      ok: true,
      value: {
        code: response.code,
        remainingSeconds: response.remainingSeconds,
      },
    };
  }
}
