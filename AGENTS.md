# AGENTS.md

このリポジトリで作業する人・エージェント向けの注意事項です。

## 構成

- 拡張は `.github/extensions/<name>/` に置き、**フォルダ単位で自己完結**させる（`install_extension` はフォルダ URL だけで取得するため、ルートや他拡張のファイルに依存しない）。
- エントリは `extension.mjs`（`.mjs` 必須、TypeScript 不可）。ツール名は全拡張で一意にする。
- 拡張を追加・変更したら、ルート `README.md` の一覧、拡張側の `README.md`、`test/` を更新する。

## `install_extension` の制限（重要）

- **1 ファイルあたり 1,000,000 バイト（約 0.95MiB）まで。** 超えるとインストールが失敗する（`File ... is too large (... bytes > 1000000 byte limit)`）。
  - 大きいデータ（カタログ、辞書など）は、空フィールド削除・minify（インデントなし JSON）・分割で収める。日本語訳を `ja-descriptions.json` に分けているのもこのため。
  - 実際に Agent Skills Ninja の同梱カタログ（整形 JSON で 1.1MB）が超過し、インストールできなかった。
- この上限は各拡張のテスト（`test/limits.test.mjs`）で自動検査している。**テストが落ちたらファイルを縮めること。上限の数値を緩めて通さない。**
- 取得は GitHub の `main` の内容が対象。push 直後は反映まで数十秒かかることがある。

## 変更後の確認

1. `cd .github/extensions/<name>` → `node --test test/*.test.mjs`（ディレクトリ指定の `node --test test/` は失敗する）
2. `extensions_reload` で読み込みを確認
3. 配布に関わる変更は、`install_extension` に main のフォルダ URL を渡して実際に入るか確認（試験用に入れたコピーは削除する）

## テストの注意

- テストは**実際のホーム（`~/.copilot`）や共有ストア（`%APPDATA%\agent-ninja`）を書き換えない**こと。`SKILL_NINJA_HOME` と `SKILL_NINJA_SHARED_DIR` を一時ディレクトリに向ける。
- UI の HTML は JS のテンプレートリテラル内にあるため、**バッククォートや `${` を直接書かない**（構文エラーになる）。

## ライセンス

CC BY-NC-SA 4.0。取り込んだ外部データの権利は各作者に帰属する。
