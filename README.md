# Skill Ninja for GitHub Copilot App

GitHub Copilot App 向けの Agent Skills（SKILL.md）検索・インストール・管理拡張機能です。
[VS Code 版 Agent Skills Ninja](https://github.com/aktsmm/vscode-agent-skill-ninja) のコアロジックを `vscode` 非依存で移植しています。

## 機能

- **キャンバス UI**: 探す（ソース絞り込み・ページング・インストール状態の表示）/ インストール済み / 更新。インストール済みは「削除」ボタンに切り替わり、削除は画面内で確認（user / project 切替対応）
- **ツール**（エージェントから呼び出し可能）
  - `skill_ninja_search_skills` / `skill_ninja_install_skill` / `skill_ninja_uninstall_skill`
  - `skill_ninja_list_skills` / `skill_ninja_recommend_skills`
  - `skill_ninja_update_skill_index`（ソースを走査して新しいスキルをキャッシュ）
  - `skill_ninja_check_updates`（インストール時のツリー SHA と比較）
  - `skill_ninja_add_source` / `skill_ninja_remove_source`
- スコープ: `user` = `~/.copilot/skills`、`project` = `<cwd>/.github/skills`

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

## 設定・状態ファイル

| ファイル | 用途 |
| --- | --- |
| `~/.copilot/skill-ninja.json` | 追加ソース |
| `~/.copilot/skill-ninja-index-cache.json` | `update_skill_index` の走査結果 |
| `~/.copilot/skill-ninja-installed.json` | インストール時 SHA（更新検知用） |

## 制限

- インストール/削除後は拡張が `session.rpc.skills.reload()` を自動実行し、再起動なしで認識されます（実機確認済み）。
- キャンバス API は experimental です。
- 走査で見つかった新規スキルは説明文が空になります。

## テスト

```
cd .github/extensions/skill-ninja
node --test test/core.test.mjs
```

## ライセンス

CC BY-NC-SA 4.0 — Copyright (c) aktsmm。カタログは VS Code 版 `resources/skill-index.json` 由来です。
