# Copilot App Extensions

[GitHub Copilot App](https://github.com/features/copilot) 向けの拡張機能（Extension）を集めたリポジトリです。作者: yamapan（[@aktsmm](https://github.com/aktsmm)）

> ⚠️ 非公式の個人プロジェクトです。GitHub / Microsoft とは関係ありません。Copilot App の拡張 API（canvas など）は experimental のため、将来変更される可能性があります。

## 拡張機能一覧

| 拡張 | 概要 | フォルダ |
| --- | --- | --- |
| 🥷 **Agent Skills Ninja** | Agent Skills（SKILL.md）の検索・インストール・更新・管理。約 2,060 スキルを同梱し、説明は日本語対応（約 1,870 件）。種別（公式/コミュニティ）での絞り込み、キャンバス UI、VS Code 版との連携つき | [`.github/extensions/skill-ninja`](.github/extensions/skill-ninja/README.md) |

## インストール

**GitHub Release やパッケージは不要です。** このリポジトリの URL を渡すだけで入ります（Copilot App の `install_extension` が、リポジトリ内のフォルダ URL から直接取得するため）。

### いちばん簡単な方法

Copilot App のチャットで次のように頼みます。

> 「`https://github.com/aktsmm/copilot-app-extensions/tree/main/.github/extensions/skill-ninja` を install_extension でインストールして」

- 入れる場所は `user`（全プロジェクト共通・おすすめ）、`project`（そのリポジトリのみ）、`session`（このセッションのみ）から選べます。
- 入れたあとは自動で再読み込みされます。「Agent Skills Ninja を開いて」と頼むとキャンバスが開きます。

### 他の拡張を入れるとき

```
https://github.com/aktsmm/copilot-app-extensions/tree/main/.github/extensions/<name>
```

`<name>` は上の「拡張機能一覧」のフォルダ名です。

### 更新するには

同じ URL でもう一度 `install_extension` を実行すると、最新の main の内容に置き換わります。

### 補足

- このリポジトリを開いたセッションでは、`.github/extensions/` 配下の拡張がインストールなしでそのまま読み込まれます。
- `install_extension` には **1 ファイル 1,000,000 バイトまで**という上限があります。大きなデータを同梱する拡張は、この範囲に収めてください（Agent Skills Ninja のカタログは約 0.76MB、日本語訳は約 0.3MB で、いずれも別ファイル。`scripts/sync-catalog.mjs` と `test/limits.test.mjs` が超過をチェックします）。
- 動作確認済み: 現在の main の URL から、実際にインストールできることを検証しました。

> `install_extension` で URL を指定するには、リポジトリが公開されているか、GitHub へのアクセス権（private の場合）が必要です。

## リポジトリ構成

```
.github/extensions/
  <name>/
    extension.mjs     エントリ（.mjs 必須）
    core/             ロジック（拡張ごとに自己完結）
    test/             node:test
    README.md         拡張ごとのドキュメント
LICENSE               リポジトリ全体のライセンス
```

各拡張は**フォルダ単位で自己完結**させます（フォルダ URL だけでインストールできるように、他の拡張やルートのファイルへ依存しません）。

## 新しい拡張を追加する

> 開発者・エージェント向けの注意は [AGENTS.md](AGENTS.md) にまとめています（特に `install_extension` の 1 ファイル 1,000,000 バイト上限）。

1.  `.github/extensions/<name>/extension.mjs` を作成（Copilot App の `extensions_manage` の `scaffold` が使えます）
2. `README.md` と `test/` を同じフォルダに置く
3. 上の「拡張機能一覧」に 1 行追加する
4. `extensions_reload` で読み込みを確認し、`node --test` を通す

## ライセンス

[CC BY-NC-SA 4.0](LICENSE)（表示・非営利・継承）。Copyright (c) 2025-2026 aktsmm。
各拡張が取り込む外部データ（カタログ内のスキル本体など）の権利は、それぞれの作者・リポジトリに帰属します。
