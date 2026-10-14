# Copilot App Extensions

[GitHub Copilot App](https://github.com/features/copilot) 向けの拡張機能（Extension）を集めたリポジトリです。作者: yamapan（[@aktsmm](https://github.com/aktsmm)）

> ⚠️ 非公式の個人プロジェクトです。GitHub / Microsoft とは関係ありません。Copilot App の拡張 API（canvas など）は experimental のため、将来変更される可能性があります。

## 拡張機能一覧

| 拡張 | 概要 | フォルダ |
| --- | --- | --- |
| 🥷 **Agent Skills Ninja** | Agent Skills（SKILL.md）の検索・インストール・更新・管理。キャンバス UI、VS Code 版との連携つき | [`.github/extensions/skill-ninja`](.github/extensions/skill-ninja/README.md) |

## インストール

Copilot App で、`install_extension` に**拡張フォルダの URL**を渡します（`<name>` を下の表から選びます）。

```
https://github.com/aktsmm/copilot-app-extensions/tree/main/.github/extensions/<name>
```

例: Agent Skills Ninja

```
https://github.com/aktsmm/copilot-app-extensions/tree/main/.github/extensions/skill-ninja
```

- このリポジトリをプロジェクトとして開いたセッションでは、`.github/extensions/` 配下の拡張がそのまま読み込まれます。
- インストール先は `user`（全プロジェクト共通）と `project`（そのリポジトリのみ）から選べます。

> リポジトリを公開するまでは、`install_extension` で URL 指定するには GitHub へのアクセス権（private の場合）が必要です。

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

1. `.github/extensions/<name>/extension.mjs` を作成（Copilot App の `extensions_manage` の `scaffold` が使えます）
2. `README.md` と `test/` を同じフォルダに置く
3. 上の「拡張機能一覧」に 1 行追加する
4. `extensions_reload` で読み込みを確認し、`node --test` を通す

## ライセンス

[CC BY-NC-SA 4.0](LICENSE)（表示・非営利・継承）。Copyright (c) 2025-2026 aktsmm。
各拡張が取り込む外部データ（カタログ内のスキル本体など）の権利は、それぞれの作者・リポジトリに帰属します。
