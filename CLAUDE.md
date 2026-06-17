# claude-service-status — プロジェクトルール

VS Code 拡張機能「Claude Service Status」のリポジトリ。

## リリース手順（バージョン更新 + タグ作成）

バージョンを上げるときは、以下を **必ずまとめて** 行うこと。1 つでも漏らさない。

### 1. バージョン番号を更新（3 箇所すべて）

セマンティックバージョニング（`MAJOR.MINOR.PATCH`）に従う。

- `package.json` の `"version"`
- `package-lock.json` の **トップレベル** `"version"`
- `package-lock.json` の `packages[""]` 内の `"version"`

3 箇所は必ず同じ値に揃える。`package-lock.json` の更新漏れに注意。

バージョンの上げ方の目安：
- **PATCH**（例 0.1.1 → 0.1.2）: ドキュメント修正・バグ修正・軽微な変更
- **MINOR**（例 0.1.2 → 0.2.0）: 機能追加（後方互換あり）
- **MAJOR**（例 0.2.0 → 1.0.0）: 破壊的変更

### 2. コミット

変更ファイル（`package.json`, `package-lock.json` と関連ファイル）をコミットする。
- コミットメッセージは件名 + 空行 + 本文。
- `Co-Authored-By: Claude ...` トレーラーは付けない（ユーザーのグローバルルール）。

### 3. Git タグを作成

```bash
git tag vX.Y.Z       # 例: v0.1.2 — package.json の version に "v" を付けた形
```

タグ名は必ず `v` プレフィックス付き（`v0.1.2`）。`package.json` の version と一致させる。

### 4. push（ユーザーが明示的に指示した場合のみ）

```bash
git push            # ブランチ
git push origin vX.Y.Z   # タグ
```

> push はユーザーの明示的な指示があるまで実行しない。コミット・タグ作成までで止めて、push が必要か確認する。

## パッケージ化（VSIX）

```bash
vsce package        # claude-service-status-X.Y.Z.vsix が生成される
```

`vsce package` は `vscode:prepublish`（= `npm run compile`）を走らせる。ビルド系コマンドはユーザーの明示的指示がある場合のみ実行する。

## 注意事項

- 本拡張は **非公式 (Unofficial)**。README 冒頭の非公式表記・商標注記は削除しない。
- 拡張機能の `name` は `claude-service-status`、`publisher` は `kpab`。
