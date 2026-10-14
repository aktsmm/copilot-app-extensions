# Agent Canvas Ninja for GitHub Copilot App

Copilot App の **Canvas 拡張を探して、リスクをレビューして、インストール**するための拡張です（[Agent Skills Ninja](../skill-ninja/README.md) の拡張版）。

## 機能

- **キャンバス UI**: 左に一覧、右に詳細の 2 ペイン。検索、ソース絞り込み、★お気に入り、📌ピン、テーマ 6 種、`/` で検索
- **カタログ**: `github/awesome-copilot` の `extensions/`（external 含む）と `aktsmm/copilot-app-extensions` を同梱。GitHub から再スキャン可能
- **リスクレポート**（ヒューリスティック）: フォルダ全体を解析し、`child_process`、環境変数要求、ネットワーク、ファイル書き込み、フック、難読化、依存パッケージなどを表示。**安全の保証ではありません**
- **コミット固定インストール**: レビューしたコミット SHA と内容ハッシュを検証してから配置（レビュー後のすり替えを防止）。リスク「高」は確認チェックが必須
- **インストール済み**: user / project スコープ、セッション内の起動状態、削除（手動導入は force 確認）
- **更新検知**: 導入時のディレクトリ tree SHA と上流を比較
- **ソース管理**: 追加 / 削除 / 再スキャン / 古いソースの更新（30 日超を最大 5 件）/ GitHub 検索 / 失敗の分類（SSO・404・レート制限・認証）と無視・URL 変更
- **エージェント用ツール**: `canvas_ninja_search` / `review_extension` / `install_extension` / `uninstall_extension` / `list_installed` / `check_updates` / `add_source` / `remove_source` / `update_index` / `source_problems` / `manage_source` / `web_search` / `localize`

## 使い方

「Agent Canvas Ninja を開いて」と依頼します。インストール後は拡張の再読み込みが必要です（画面のバナーから実行。キャンバスは開き直されます）。

```
https://github.com/aktsmm/copilot-app-extensions/tree/main/.github/extensions/canvas-ninja
```

## 安全設計

- UI サーバーは `127.0.0.1` ＋ ランダムトークン ＋ Host/Origin 検証 ＋ CSP。README は HTML を無効化して表示
- 拡張名・パス検証、シンボリックリンク除外、サイズ上限、一時ディレクトリ経由の原子的配置
- 本アプリは拡張のコードを実行せず、`npm install` も行いません

## 保存先

`~/.copilot/canvas-ninja.json`（設定）、`canvas-ninja-index-cache.json`、`canvas-ninja-installed.json`。`CANVAS_NINJA_HOME` で変更可。

## カタログ更新 / テスト

```
node scripts/sync-catalog.mjs
node --test test/core.test.mjs
```

CC BY-NC-SA 4.0 — Copyright (c) aktsmm
