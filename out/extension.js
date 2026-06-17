"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
let statusBarItem;
let timer;
let lastSummary;
let lastError;
function getConfig() {
    const cfg = vscode.workspace.getConfiguration('claudeStatus');
    return {
        baseUrl: cfg.get('statusPageUrl', 'https://status.claude.com').replace(/\/+$/, ''),
        interval: Math.max(15, cfg.get('refreshInterval', 60)),
    };
}
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'vscode-claude-status' } }, (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 400) {
                res.resume();
                reject(new Error(`HTTP ${code}`));
                return;
            }
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    reject(e instanceof Error ? e : new Error(String(e)));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
    });
}
function indicatorVisual(indicator) {
    switch (indicator) {
        case 'none':
            return { icon: '$(pass-filled)' };
        case 'minor':
            return { icon: '$(warning)', bg: new vscode.ThemeColor('statusBarItem.warningBackground') };
        case 'major':
        case 'critical':
            return { icon: '$(error)', bg: new vscode.ThemeColor('statusBarItem.errorBackground') };
        default:
            return { icon: '$(question)' };
    }
}
function prettyComponent(status) {
    return status
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
function componentIcon(status) {
    switch (status) {
        case 'operational':
            return '$(check)';
        case 'under_maintenance':
            return '$(tools)';
        case 'degraded_performance':
        case 'partial_outage':
            return '$(warning)';
        case 'major_outage':
            return '$(error)';
        default:
            return '$(circle-outline)';
    }
}
function openIncidents(s) {
    return s.incidents.filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');
}
function render(s) {
    const v = indicatorVisual(s.status.indicator);
    const open = openIncidents(s);
    statusBarItem.text = open.length ? `${v.icon} Claude (${open.length})` : `${v.icon} Claude`;
    statusBarItem.backgroundColor = v.bg;
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${s.status.description}**\n\n`);
    if (open.length) {
        md.appendMarkdown(`---\n\n**進行中のインシデント**\n\n`);
        for (const i of open) {
            md.appendMarkdown(`- $(alert) ${i.name} _(${i.status})_\n`);
        }
        md.appendMarkdown('\n');
    }
    md.appendMarkdown(`---\n\n**コンポーネント**\n\n`);
    for (const c of s.components.filter((c) => !c.group)) {
        md.appendMarkdown(`- ${componentIcon(c.status)} ${c.name}: ${prettyComponent(c.status)}\n`);
    }
    md.appendMarkdown(`\n_更新: ${new Date(s.page.updated_at).toLocaleString()} — クリックで詳細_`);
    statusBarItem.tooltip = md;
}
async function refresh(showError = false) {
    const { baseUrl } = getConfig();
    try {
        const summary = await fetchJson(`${baseUrl}/api/v2/summary.json`);
        lastSummary = summary;
        lastError = undefined;
        render(summary);
    }
    catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        statusBarItem.text = '$(cloud) Claude: ?';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = `状態を取得できませんでした: ${lastError}`;
        if (showError) {
            vscode.window.showErrorMessage(`Claude Status: ${lastError}`);
        }
    }
    viewProvider?.update();
    if (panel && lastSummary) {
        panel.webview.html = detailsHtml(lastSummary);
    }
}
function restartTimer() {
    if (timer) {
        clearInterval(timer);
    }
    const { interval } = getConfig();
    timer = setInterval(() => void refresh(), interval * 1000);
}
function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function detailsHtml(s) {
    const v = indicatorVisual(s.status.indicator);
    const dot = s.status.indicator === 'none' ? '#3fb950' : s.status.indicator === 'minor' ? '#d29922' : '#f85149';
    void v;
    const open = openIncidents(s);
    const recent = s.incidents.slice(0, 10);
    const incidentBlock = (i) => {
        const latest = i.incident_updates[0];
        return `
      <div class="card">
        <div class="card-head">
          <span class="badge badge-${i.status}">${escapeHtml(i.status)}</span>
          <a href="${escapeHtml(i.shortlink)}">${escapeHtml(i.name)}</a>
        </div>
        ${latest ? `<p class="body">${escapeHtml(latest.body)}</p>` : ''}
        <p class="meta">更新: ${new Date(i.updated_at).toLocaleString()}</p>
      </div>`;
    };
    const componentRows = s.components
        .filter((c) => !c.group)
        .map((c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td class="${c.status === 'operational' ? 'ok' : 'warn'}">${escapeHtml(prettyComponent(c.status))}</td>
      </tr>`)
        .join('');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.25rem; }
  h1 { font-size: 1.2rem; display: flex; align-items: center; gap: .5rem; margin-bottom: .25rem; }
  h2 { font-size: .95rem; margin-top: 1.5rem; opacity: .85; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3rem; }
  .dot { width: .7rem; height: .7rem; border-radius: 50%; display: inline-block; background: ${dot}; }
  .updated { opacity: .6; font-size: .8rem; margin: 0 0 .5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  td { padding: .35rem .5rem; border-bottom: 1px solid var(--vscode-panel-border); }
  .ok { color: #3fb950; }
  .warn { color: #d29922; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: .6rem .75rem; margin: .5rem 0; }
  .card-head { display: flex; align-items: center; gap: .5rem; font-weight: 600; }
  .body { font-size: .85rem; margin: .4rem 0 .2rem; white-space: pre-wrap; }
  .meta { font-size: .75rem; opacity: .6; margin: 0; }
  .badge { font-size: .7rem; padding: .1rem .4rem; border-radius: 4px; text-transform: uppercase; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge-investigating, .badge-identified { background: #f85149; color: #fff; }
  .badge-monitoring { background: #d29922; color: #000; }
  .empty { opacity: .6; font-size: .85rem; }
</style>
</head>
<body>
  <h1><span class="dot"></span> ${escapeHtml(s.status.description)}</h1>
  <p class="updated">最終更新: ${new Date(s.page.updated_at).toLocaleString()} · <a href="${escapeHtml(s.page.url)}">status.claude.com</a></p>

  <h2>進行中のインシデント</h2>
  ${open.length ? open.map(incidentBlock).join('') : '<p class="empty">進行中のインシデントはありません。</p>'}

  <h2>コンポーネント</h2>
  <table><tbody>${componentRows}</tbody></table>

  <h2>最近のインシデント履歴</h2>
  ${recent.length ? recent.map(incidentBlock).join('') : '<p class="empty">履歴がありません。</p>'}
</body>
</html>`;
}
let panel;
async function showDetails() {
    if (!lastSummary) {
        await refresh(true);
    }
    if (!lastSummary) {
        return;
    }
    if (panel) {
        panel.reveal();
    }
    else {
        panel = vscode.window.createWebviewPanel('claudeStatusDetails', 'Claude Status', vscode.ViewColumn.Active, {
            enableScripts: false,
        });
        panel.onDidDispose(() => (panel = undefined));
    }
    panel.webview.html = detailsHtml(lastSummary);
}
function errorHtml(message) {
    return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  .err { color: #f85149; font-size: .85rem; }
</style></head>
<body>
  <p class="err">状態を取得できませんでした</p>
  <p style="opacity:.7;font-size:.8rem;">${escapeHtml(message)}</p>
</body></html>`;
}
class StatusViewProvider {
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: false };
        webviewView.onDidDispose(() => (this.view = undefined));
        this.update();
        if (!lastSummary && !lastError) {
            void refresh();
        }
    }
    update() {
        if (!this.view) {
            return;
        }
        if (lastSummary) {
            this.view.webview.html = detailsHtml(lastSummary);
        }
        else if (lastError) {
            this.view.webview.html = errorHtml(lastError);
        }
    }
}
let viewProvider;
function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claudeStatus.showDetails';
    statusBarItem.text = '$(cloud) Claude';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    viewProvider = new StatusViewProvider();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeStatus.statusView', viewProvider), vscode.commands.registerCommand('claudeStatus.refresh', () => refresh(true)), vscode.commands.registerCommand('claudeStatus.showDetails', () => showDetails()), vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeStatus')) {
            restartTimer();
            void refresh();
        }
    }));
    void refresh();
    restartTimer();
}
function deactivate() {
    if (timer) {
        clearInterval(timer);
    }
}
//# sourceMappingURL=extension.js.map