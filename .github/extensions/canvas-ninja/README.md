# Agent Canvas Ninja for GitHub Copilot App

Copilot App の **Canvas 拡張・公式プラグインを探して、リスクをレビューして、インストール**する拡張です（[Agent Skills Ninja](../skill-ninja/README.md) の拡張版）。日本語 / English 切替、テーマ 8 種。

## 機能

- **キャンバス UI**: 左に一覧、右に詳細の 2 ペイン。検索、ソース / 種別（キャンバス・プラグイン）絞り込み、★お気に入り、📌ピン、`/` で検索
- **公式タブ**: GitHub / Microsoft（github, microsoft, Azure, MicrosoftDocs, dotnet）発行のキャンバス・プラグインに ✔ 公式バッジ。**おすすめセット**（Azure キャンバス スターター / Azure 運用 / Microsoft AI・ドキュメント）をまとめてレビュー → インストール。`az` / `az login` の前提条件も表示
- **カタログ**: `github/awesome-copilot` の `extensions/` と **プラグイン マーケットプレイス（`.github/plugin/marketplace.json`）**、`aktsmm/copilot-app-extensions` を同梱。GitHub から再スキャン可能
- **リスクレポート**（ヒューリスティック）: フォルダ全体を解析（child_process、環境変数、ネットワーク、書き込み、フック、難読化、MCP サーバー起動など）。**安全の保証ではありません**。公式でも省略しません
- **レビュー済みの内容だけをインストール**: レビューごとに ID（30 分有効）を発行し、インストールはその ID が必須（UI もエージェントツールも同じ）。レビュー時のバイト列をそのまま配置します。リスク「高」は確認チェック必須、依存パッケージ / インストールスクリプトのある拡張はブロック
- **種別ごとの導入方法**
  - 拡張フォルダ（`extension.mjs`）: `~/.copilot/extensions`（user）または `.github/extensions`（project）へ原子的に配置（上書きに失敗しても元に戻る）。反映は拡張の再読み込み
  - プラグイン: Copilot App 標準のプラグイン管理（`session.rpc.plugins.install`）で `name@marketplace` を導入。マーケットプレイスの固定コミットがレビュー後に変わっていたら失敗扱い。反映は新しいセッション
- **インストール済み / 更新検知 / ソース管理**: user / project スコープ、セッション内の起動状態、tree SHA による更新検知、GitHub 検索、失敗ソースの分類（SSO・404・レート制限・認証）と無視・URL 変更、古いソースの更新（30 日超を最大 5 件）
- **エージェント用ツール**: `canvas_ninja_search` / `review_extension` / `install_extension`（`review_id` 必須）/ `uninstall_extension` / `list_installed` / `check_updates` / `add_source` / `remove_source` / `update_index` / `source_problems` / `manage_source` / `web_search` / `localize`

## 使い方

「Agent Canvas Ninja を開いて」と依頼します。インストール後は拡張の再読み込み（画面のバナー）。キャンバスは開き直されます。

```
https://github.com/aktsmm/copilot-app-extensions/tree/main/.github/extensions/canvas-ninja
```

## 安全設計

- UI サーバーは `127.0.0.1` ＋ ランダムトークン ＋ Host/Origin 検証 ＋ CSP ＋ `Referrer-Policy: no-referrer`。README は HTML を無効化して表示
- 名前・パス検証、シンボリックリンク除外、サイズ上限、一時ディレクトリ経由の原子的配置とバックアップ復元、状態ファイルの直列書き込み
- 本アプリは取得したコードを実行せず、`npm install` も行いません
- トークンが SSO 未認可でも、公開リポジトリは匿名アクセスで読み取ります

## 保存先

`~/.copilot/canvas-ninja.json`（設定・言語・テーマ）、`canvas-ninja-index-cache.json`、`canvas-ninja-installed.json`。`CANVAS_NINJA_HOME` で変更可。

## カタログ更新 / テスト

```
node scripts/sync-catalog.mjs
node --test test/core.test.mjs
```

CC BY-NC-SA 4.0 — Copyright (c) aktsmm
