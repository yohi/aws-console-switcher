/**
 * UUID 再同期トリガーの分類と自動ログイン制御（task 8.2, requirements 3.4, S-3）。
 *
 * 秘匿値取得（`getCredentials` / `getTotp`）が特定 UUID で失敗した際に、失敗を
 * design.md「Consistency & Integrity」の基準で 2 分類する:
 *
 * - **真のオブジェクト欠落**（`item_not_found` / `invalid_uuid`, 3.4 (a)）:
 *   当該 UUID を即時にキャッシュから無効化し、再同期完了まで自動ログインを停止する。
 *   呼び出し元へは行動可能なメッセージへ差し替えた FlowError を返す（3.5 (a) 準拠）。
 * - **一時的前提条件エラー**（Vault ロック・ホスト未起動等）およびその他のコード:
 *   キャッシュを一切変更せず、UUID 無効化・再同期を行わない。元の FlowError を
 *   そのまま返し、解消後に再試行できるようにする（requirements 3.4, S-3）。
 */
import {
  type FlowError,
  isTrueObjectMissing,
  makeFlowError,
} from "@acs/shared";
import { invalidateAccountMetaEntry, type StorageArea } from "./storage.js";

/**
 * 秘匿値取得エラーを分類し、真のオブジェクト欠落時のみキャッシュを無効化する
 * （task 8.2, requirements 3.4 (a), S-3）。
 *
 * 副作用は「真のオブジェクト欠落時の 1 回の `invalidateAccountMetaEntry`」のみに限定する。
 * 一時的前提条件エラー・その他のコードではストレージへ触れず、元のエラーを不変で返す。
 *
 * @param storage 非秘匿メタデータキャッシュを保持する StorageArea。
 * @param uuid 秘匿値取得に失敗した Bitwarden アイテム UUID。
 * @param error `getCredentials` / `getTotp` が返した FlowError。
 * @returns 真欠落時は無効化済みを示す行動可能な新規 FlowError、それ以外は元の error。
 */
export async function classifyAndHandleSecretFetchError(
  storage: StorageArea,
  uuid: string,
  error: FlowError,
): Promise<FlowError> {
  if (isTrueObjectMissing(error.code)) {
    // 3.4 (a): 真のオブジェクト欠落のみ当該 UUID を即時無効化し自動ログインを停止する（S-3）。
    await invalidateAccountMetaEntry(storage, uuid);
    return makeFlowError(
      error.code,
      "このアカウントはキャッシュから無効化されました。再同期してください。",
    );
  }
  // 一時的前提条件エラー・その他はキャッシュ保持。元のエラーをそのまま返す（3.4, S-3）。
  return error;
}
