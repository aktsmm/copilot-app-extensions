# Agent Skills Ninja for GitHub Copilot App

GitHub Copilot App 向けの Agent Skills（SKILL.md）検索・インストール・管理拡張機能です。
[VS Code 版 Agent Skills Ninja](https://github.com/aktsmm/vscode-agent-skill-ninja) のコアロジックを `vscode` 非依存で移植しています。

## 機能

- **キャンバス UI**（右パネルの `Agent Skills Ninja`）
  - 探す: キーワード検索、ソース絞り込み、★のみ表示、24 件ずつのページング、`/` で検索欄にフォーカス
  - インストール状態の表示（「✓ インストール済み」→「削除」ボタン、他スコープ導入済み、手動導入、更新あり）
  - ★お気に入り / 📌ピン留め（ピンは一覧の先頭に表示）
  - `SKILL.md` のプレビュー、説明文の自動補完、日本語 / EN 切替
  - おすすめ: プロジェクトのファイル構成・`package.json`・README から導入候補を提示
  - 更新: 上流の変更を検出し「すべて更新」
  - ソース: 追加 / 削除、再スキャン、**30 日以上未スキャンのソースを古い順に最大 5 件ずつ更新**、Web 検索（GitHub の `topic:agent-skills`）からのソース追加、**VS Code 版 Agent Skills Ninja からのインポート**、バンドルの一括インストール
  - 日本語要約: カタログの日本語説明を表示。無いものは「日本語要約を追加」で保存（エージェントの `skill_ninja_localize_skill` でも可）
  - インストール済み: ピン → 新しい順。`新規作成` で SKILL.md の雛形を作成
  - 削除は画面内で確認。user / project スコープ切替
- **ツール**（エージェントから呼び出し可能）
  - `skill_ninja_search_skills` / `skill_ninja_install_skill` / `skill_ninja_uninstall_skill`
  - `skill_ninja_list_skills` / `skill_ninja_recommend_skills`
  - `skill_ninja_update_skill_index`（本家カタログの同期＋ソース走査。`stale=true` で 30 日超のみ）
  - `skill_ninja_check_updates`（インストール時のツリー SHA と比較）
  - `skill_ninja_add_source` / `skill_ninja_remove_source` / `skill_ninja_import_vscode`
  - `skill_ninja_install_bundle` / `skill_ninja_create_skill` / `skill_ninja_localize_skill` / `skill_ninja_web_search_skills`
- スコープ:
  - `user` = `~/.copilot/skills`: あなたの全プロジェクトで使える個人用
  - `project` = `<cwd>/.github/skills`: そのリポジトリだけ。コミットしてチームで共有できる

## カタログの更新

- 同梱カタログ（`resources/skill-index.json`）は VS Code 版の公開カタログ由来です。更新するには `node scripts/sync-catalog.mjs`（`--local` を付けると手元の VS Code 版が持つ公式系ソースも取り込みます。`user-added` の個人ソースは除外）。
- 実行時は `skill_ninja_update_skill_index` や UI の再スキャンで、VS Code 版の最新カタログ（`master` の `resources/skill-index.json`）との差分を `~/.copilot` のキャッシュへ取り込みます。

## 使い方

Copilot App で「Agent Skills Ninja を開いて」と依頼するとキャンバスが開きます。または `skill_ninja_*` ツールをエージェントに使わせます。
VS Code 版を使っている場合は、ソースタブの「VS Code 版からインポート」で登録済みリポジトリを引き継げます。

## インストール

プロジェクトに置く場合（このリポジトリ自体）は `.github/extensions/skill-ninja/` がそのまま読み込まれます。
他の環境へは Copilot App の `install_extension` でリポジトリのフォルダ URL を指定します。

```
https://github.com/aktsmm/copilot-app-agent-skill-ninja/tree/main/.github/extensions/skill-ninja
```

## 認証

GitHub API のレート制限回避のため、`GITHUB_TOKEN`（承認制の環境変数）→ `gh auth token` の順にトークンを使います。未認証でも動作しますが制限が厳しくなります。

## 安全設計

- 破壊的操作は確認必須（上書きは `overwrite=true`、削除は `confirm=true`、UI は確認ダイアログ）
- スキル名・パスの検証とパストラバーサル対策、一時ディレクトリ経由の原子的配置
- UI サーバーは `127.0.0.1` のランダムポート＋ランダムトークンで保護

## VS Code 版との共存

- **ソース一覧は共有**: VS Code 版 Agent Skills Ninja が使う共有マニフェスト（Windows: `%APPDATA%\agent-ninja\sources.json`、他 OS: `~/.agent-ninja/sources.json`）を読み込み、登録済みリポジトリをそのまま使えます。このアプリでソースを追加・削除すると、マニフェストが**既にある場合に限り**書き戻します（`index.lock` があれば待避、一時ファイル→rename の原子的書き込み、他拡張が持つ未知のフィールドは保持）。マニフェストが無ければ何も作りません。
- **スキル本体は共有しない設計**: 両方とも `SKILL.md` を含むフォルダを置くだけです。このアプリは既存フォルダを確認なしに上書きしません。
- **更新追跡は別管理**: SHA の記録は `~/.copilot/skill-ninja-installed.json` にあり、VS Code 版で入れたスキルは「手動導入」と表示されます（上書き事故は起きません）。
- 同梱カタログは VS Code 版 `resources/skill-index.json` と同じ形式・同じ出所です。キャッシュ（`~/.copilot/skill-ninja-index-cache.json`）は VS Code 版のものとは別です。

## 設定・状態ファイル

| ファイル | 用途 |
| --- | --- |
| `~/.copilot/skill-ninja.json` | 追加ソース、お気に入り、ピン |
| `~/.copilot/skill-ninja-index-cache.json` | 再スキャン・インポート・説明補完の結果 |
| `~/.copilot/skill-ninja-installed.json` | インストール時 SHA（更新検知用） |

環境変数 `SKILL_NINJA_HOME` で保存先ディレクトリを変更できます。

## 制限

- インストール/削除後は拡張が `session.rpc.skills.reload()` を自動実行し、再起動なしで認識されます（実機確認済み）。
- キャンバス API は experimental です。
- 更新検知の対象は Agent Skills Ninja で導入したスキルのみです（手動導入は「手動導入」と表示）。
- GitHub API を使うため、未認証だとレート制限に当たります。`gh auth login` 済みなら自動で使います。
- 再スキャンで見つかった新規スキルの説明文は、カードを表示したときに `SKILL.md` から補完されます。

## テスト

```
cd .github/extensions/skill-ninja
node --test test/core.test.mjs
```

## リンク・作者

画面右上の ⓘ から「このアプリについて」を開けます。

- Copilot App 版: https://github.com/aktsmm/copilot-app-agent-skill-ninja
- VS Code 版 Agent Skills Ninja: https://github.com/aktsmm/vscode-agent-skill-ninja（[Marketplace](https://marketplace.visualstudio.com/items?itemName=yamapan.agent-skill-ninja)）
- 作者: yamapan（[@aktsmm](https://github.com/aktsmm) / [X: @mmskats](https://x.com/mmskats)）

## ライセンス

CC BY-NC-SA 4.0 — Copyright (c) aktsmm。カタログは VS Code 版 `resources/skill-index.json` 由来です。
