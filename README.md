# Claude Service Status

Claude (Anthropic) のサービス状態を **VS Code のステータスバー**に常時表示する拡張機能です。障害やインシデントが起きていないか、エディタから離れずに確認できます。

> **⚠️ 非公式 (Unofficial)** — 本拡張機能は Anthropic 公式のものではなく、Anthropic とは一切関係ありません。"Claude" および "Anthropic" は Anthropic PBC の商標です。公開されている Statuspage の状態を表示する目的でのみ名称を使用しています。

---

## ✨ 特長

- 🟢 **ステータスバーに常時表示** — `$(pass-filled) Claude` のように、現在のサービス状態をいつでも一目で確認。
- 🚨 **障害を色で即把握** — minor は黄色、major / critical は赤背景でハイライト。進行中インシデントは `Claude (2)` のように件数を表示。
- 🖱️ **ホバーで詳細** — 全体状態・進行中インシデント・各コンポーネントの状態をツールチップで確認。
- 📋 **詳細パネル** — クリックでインシデント履歴とコンポーネント一覧を表示。
- 🔄 **自動更新** — 設定した間隔で自動的に最新状態を取得（手動更新も可能）。
- 🔌 **公式データ元** — Anthropic 公式の Atlassian Statuspage (`status.claude.com`) の v2 JSON API を利用。

## 📦 インストール

1. VS Code の拡張機能ビュー（`Cmd/Ctrl + Shift + X`）を開く
2. **「Claude Service Status」** を検索
3. **Install** をクリック

インストール後、自動的にステータスバーへ Claude の状態が表示されます。

## 🚀 使い方

- **ステータスバー** — 右側の `Claude` 表示で現在の状態を確認。クリックで詳細パネルを開く。
- **コマンドパレット**（`Cmd/Ctrl + Shift + P`）から以下を実行：
  - `Claude Status: Refresh Now` — 今すぐ最新状態を取得
  - `Claude Status: Show Details` — 詳細パネルを開く

### 状態アイコンの意味

| 表示 | 意味 |
| --- | --- |
| ✅ チェックアイコン | 正常稼働 |
| ⚠️ 警告アイコン（黄背景） | 軽微な障害 (minor) |
| ❌ エラーアイコン（赤背景） | 重大な障害 (major / critical) |
| `Claude (2)` | 進行中インシデントの件数 |

## ⚙️ 設定

| 設定キー | 既定値 | 説明 |
| --- | --- | --- |
| `claudeStatus.statusPageUrl` | `https://status.claude.com` | 監視対象の Statuspage ベース URL |
| `claudeStatus.refreshInterval` | `60` | ポーリング間隔（秒・最小 15）|

> ℹ️ Statuspage の v2 API は IP ごとに毎秒 1 リクエストのレート制限があるため、更新間隔は 15 秒以上を推奨します。

## 🔒 プライバシー

本拡張機能は `status.claude.com` の公開 Statuspage API に対してのみ通信します。ユーザーのコード・入力内容・個人情報を収集したり外部送信したりすることは一切ありません。

## 🤝 フィードバック

バグ報告・機能要望は [GitHub Issues](https://github.com/kpab/claude-service-status/issues) までお願いします。

## 📄 ライセンス

[MIT License](./LICENSE)

---

<details>
<summary>開発者向け情報</summary>

### ビルド・実行

```bash
npm install
npm run compile     # もしくは npm run watch
```

VS Code でこのフォルダを開き、`F5` を押すと拡張機能開発ホストが起動します。

### パッケージ化

```bash
npm install -g @vscode/vsce
vsce package        # claude-service-status-x.y.z.vsix が生成される
```

### 利用エンドポイント

- `GET /api/v2/summary.json` — 全体状態 + コンポーネント + 未解決インシデント
- `GET /api/v2/status.json` — 全体インジケーターのみ（軽量）
- `GET /api/v2/incidents/unresolved.json` — 進行中インシデントのみ

</details>
