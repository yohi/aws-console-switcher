# Changelog

## [0.2.0](https://github.com/yohi/aws-console-switcher/compare/aws-console-switcher-v0.1.0...aws-console-switcher-v0.2.0) (2026-07-07)


### Features

* **extension:** Content Scripts(セレクタフォールバック・サインインDOM検知・コンソール状態検出)を実装 ([478699e](https://github.com/yohi/aws-console-switcher/commit/478699ecc082f168088dadb21646c2aacb9d3367))
* **extension:** MV3拡張プロジェクトの初期化とビルド構成 ([9adbb87](https://github.com/yohi/aws-console-switcher/commit/9adbb87d58371340782e7287a794052a059d160f))
* **extension:** Popup UI(アカウント一覧・検索・アンロック・エラー通知)を実装 ([c097eb9](https://github.com/yohi/aws-console-switcher/commit/c097eb91a8d6076ca1b14f44c96c08b428ecbcd9))
* **extension:** Service Worker のフロー永続化・タイムアウト監視・ログイン自動化を実装 ([9a20e44](https://github.com/yohi/aws-console-switcher/commit/9a20e443f18bf99a90169c4eaf6f10e9bbf2b043))
* **extension:** Service Workerのbootstrap配線とconsoleState補正を実装 ([8295b79](https://github.com/yohi/aws-console-switcher/commit/8295b79288e81d89b2cdb838089982aa275e79e8))
* **extension:** シークレット取得ポート(Native Messagingアダプタ/Bitwardenプロバイダ)を追加 ([49dbe24](https://github.com/yohi/aws-console-switcher/commit/49dbe24a8c4f5428186cfe65603a06c07cc16767))
* **extension:** セッションマネージャ(複数セッション前面化とLRU退避)を実装 ([bd3c084](https://github.com/yohi/aws-console-switcher/commit/bd3c084d1854948b5c9a37e159cbea56de7574e4))
* Native Messaging ホストの実装（task 2） ([3e6fc31](https://github.com/yohi/aws-console-switcher/commit/3e6fc31c766b9e7e67c5397096b5f049f0c68e42))
* Native Messaging ホストの実装（task 2） ([4396f4c](https://github.com/yohi/aws-console-switcher/commit/4396f4c10219176c1442ba6c8efa6c52def700fc))
* Service Worker・Content Scripts・Popup UI の実装（tasks.md 4.3-9.2, 10.1-10.2） ([2440495](https://github.com/yohi/aws-console-switcher/commit/2440495c6bdfe810ec72a36358be5928025eb3e6))
* **shared:** native-host 用エラーコード malformed_request / invalid_configuration を追加 ([9ee2053](https://github.com/yohi/aws-console-switcher/commit/9ee2053b89d2e2414e8c6b45885a264538d45340))
* **shared:** 全ポート境界の共有型・メッセージ契約を定義 ([fdffaa4](https://github.com/yohi/aws-console-switcher/commit/fdffaa450843c3d74a2d9e464a7f5e228d9b762d))
* **shared:** 拡張設定変更メッセージ種別(updateSettings)を追加 ([5429f3c](https://github.com/yohi/aws-console-switcher/commit/5429f3c171323a5ecf57735fc05289e0356b3aaf))
* プロジェクト基盤と共有契約のセットアップ (tasks.md 1.1/1.2) ([5bd6c54](https://github.com/yohi/aws-console-switcher/commit/5bd6c54808a3485ac475bafb29214969d74a68fc))


### Bug Fixes

* @types/nodeを最低サポートバージョン(Node 20)に整合 ([571adac](https://github.com/yohi/aws-console-switcher/commit/571adace5d3dcef7977997a54e86ce89c3f6fdad))
* **extension:** console状態補正でリージョナルホストとexecuteScript失敗を正しく処理する ([f0ca2a4](https://github.com/yohi/aws-console-switcher/commit/f0ca2a473f0b46a9b67be187e4b11f8ad00ff437))
* **extension:** handleAwaitingAccountIdにconsoleRedirect処理を追加 ([4149692](https://github.com/yohi/aws-console-switcher/commit/414969234b3ee1965d40c76a59a658f081b8a3ea))
* **extension:** popupのキャンセル処理順序と要素解決失敗のログを修正 ([24c9ba2](https://github.com/yohi/aws-console-switcher/commit/24c9ba2b4e8cfeb0a138d6a03ceb9ca8bdef0c8a))
* **extension:** recordSessionのaccountId解決を存在しないキー参照から修正 ([6072110](https://github.com/yohi/aws-console-switcher/commit/6072110083607d9289e5d97fa387d8b82784bd30))
* **extension:** resetFlowでflowTimeoutアラームが残存する不整合を修正 ([4138727](https://github.com/yohi/aws-console-switcher/commit/4138727d5aeab3db67fcc7e521a353f443b93879))
* **extension:** switchToのタブ閉鎖フォールバックでstaleなSessionRecordを削除する ([816e769](https://github.com/yohi/aws-console-switcher/commit/816e769244c4a8355fa8c764dd41449581764e04))
* **extension:** switchToの例外伝播とwindows.update誤フォールバックを修正 ([c066443](https://github.com/yohi/aws-console-switcher/commit/c066443761a0d53976ad3b234fa833dcfe0b3148))
* **extension:** 値注入失敗時にサインインフォームを送信しないよう修正 ([532ddcd](https://github.com/yohi/aws-console-switcher/commit/532ddcddceb07ee33c74ef0417d09f2c9dcd7d25))
* **extension:** 応答型不一致をhost_malformed_responseで分類 ([d983df6](https://github.com/yohi/aws-console-switcher/commit/d983df62f4677e55b547be1bf587e24e9ac05144))
* **extension:** 既存セッション前面化時にinFlightへ誤追加されるのを修正 ([9903777](https://github.com/yohi/aws-console-switcher/commit/990377751b8c567eb139c8a3cf2e801c44dff173))
* **extension:** 網羅性チェック分岐のエラーコードをinvalid_configurationに修正 ([7d52d73](https://github.com/yohi/aws-console-switcher/commit/7d52d730945c94da333699abd532149ac71d888b))
* isAccountMetaでuuid/accountIdのフォーマットも検証する ([785edea](https://github.com/yohi/aws-console-switcher/commit/785edea64f3ab80e9e08d832abfb8e90e1407b5e))
* **native-host:** bw unlock の host_not_running 分類と spawn タイムアウトを追加 ([4d820c8](https://github.com/yohi/aws-console-switcher/commit/4d820c81af418f831bd1d8b290bd1b2b8566b1b9))
* **native-host:** configure() で idleLockMinutes と totpMinRemainingSeconds を検証 ([b66f123](https://github.com/yohi/aws-console-switcher/commit/b66f123da76cd68aaa512992965cb58cf9350cbf))
* **native-host:** Errorインスタンス以外の例外を再スローする ([c9b7f7e](https://github.com/yohi/aws-console-switcher/commit/c9b7f7e7feac8ec6253dd6eda1fa4ff26435caa0))
* **native-host:** idle-lock で lock 完了時に sessionToken が変わっていないか再確認 ([6ca8cd1](https://github.com/yohi/aws-console-switcher/commit/6ca8cd13e9c8c54ba8af7f9b178a828455abe937))
* **native-host:** idle-lock で lock 結果を確認し in-flight ガードを安全に解放 ([21dcb6c](https://github.com/yohi/aws-console-switcher/commit/21dcb6c9174650615681cec7ee8078b8cc8ac115))
* **native-host:** runNativeHost クラッシュ時に stderr へエラーを出力 ([1189bdb](https://github.com/yohi/aws-console-switcher/commit/1189bdb404bd933c99b00b006e868b3b75f2dda5))
* **native-host:** TOTP 待機の abort を Result に変換 ([5b35221](https://github.com/yohi/aws-console-switcher/commit/5b35221cc57797b22ba4d91d2bc881df058580f3))
* **native-host:** unlockVault の非 Error 例外を再 throw し重複 preconditionError を makeFlowError に置換 ([e4f900d](https://github.com/yohi/aws-console-switcher/commit/e4f900d4fedf293c951510f7ea8e268bdecaeca0))
* **shared:** FlowErrorCodeにhost_malformed_responseを追加 ([a7a0fa3](https://github.com/yohi/aws-console-switcher/commit/a7a0fa3f4bd3be7c2374151c89342310bb83732f))
* 各パッケージにcleanスクリプトを追加しroot cleanを実効化 ([ef5e1a3](https://github.com/yohi/aws-console-switcher/commit/ef5e1a366a2e00198c66d5ff4a22e5e51986988e))
* 拡張の本番ビルドでsourcemapを無効化 ([38fe277](https://github.com/yohi/aws-console-switcher/commit/38fe277915bcfbe2640b60a8a8254b3778257293))


### Performance Improvements

* **extension:** セッション状態補正を並列化しlistAccounts応答遅延の積算を防止 ([0b8f56c](https://github.com/yohi/aws-console-switcher/commit/0b8f56c925c83e6e1e0c373af14c0e6854c805ad))
