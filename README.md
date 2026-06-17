# Claude Status

VS Code のステータスバーに Claude (Anthropic) のサービス状態を表示し、進行中・過去のインシデントを確認できる拡張機能。データ元は公式の Atlassian Statuspage (`status.claude.com`) の v2 JSON API。

## 表示

- ステータスバー右側に `$(pass-filled) Claude` のように常時表示。
  - 正常: チェックアイコン
  - minor: 警告アイコン + 黄背景
  - major / critical: エラーアイコン + 赤背景
  - 進行中インシデントがあれば件数を `Claude (2)` のように表示
- ホバーすると、全体状態・進行中インシデント・各コンポーネントの状態をツールチップで表示。
- クリックすると詳細パネル（Webview）を開き、インシデント履歴とコンポーネント一覧を確認できる。

## コマンド

- `Claude Status: Refresh Now` — 手動で再取得
- `Claude Status: Show Details` — 詳細パネルを開く

## 設定

| 設定キー | 既定値 | 説明 |
| --- | --- | --- |
| `claudeStatus.statusPageUrl` | `https://status.claude.com` | 監視対象の Statuspage ベースURL |
| `claudeStatus.refreshInterval` | `60` | ポーリング間隔（秒・最小15）|

> Statuspage の v2 API は IP ごとに毎秒1リクエストのレート制限があるため、間隔は15秒以上を推奨。

## 開発・実行

```bash
npm install
npm run compile     # もしくは npm run watch
```

VS Code でこのフォルダを開き、`F5` を押すと拡張機能開発ホストが起動する。

## パッケージ化（任意）

```bash
npm install -g @vscode/vsce
vsce package        # claude-status-0.1.0.vsix が生成される
```

生成された `.vsix` は「Extensions: Install from VSIX...」からインストールできる。

## エンドポイント

- `GET /api/v2/summary.json` — 全体状態 + コンポーネント + 未解決インシデント
- `GET /api/v2/status.json` — 全体インジケーターのみ（軽量）
- `GET /api/v2/incidents/unresolved.json` — 進行中インシデントのみ
