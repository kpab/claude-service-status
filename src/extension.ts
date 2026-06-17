import * as vscode from 'vscode';
import * as https from 'https';

// ---- Statuspage v2 API types (only the fields we use) ----
interface StatusSummary {
  page: { name: string; url: string; updated_at: string };
  status: { indicator: 'none' | 'minor' | 'major' | 'critical'; description: string };
  components: Component[];
  incidents: Incident[];
  scheduled_maintenances: ScheduledMaintenance[];
}
interface Component {
  id: string;
  name: string;
  status: string; // operational | degraded_performance | partial_outage | major_outage | under_maintenance
  group: boolean;
}
interface Incident {
  id: string;
  name: string;
  status: string; // investigating | identified | monitoring | resolved | postmortem
  impact: string; // none | minor | major | critical
  shortlink: string;
  created_at: string;
  updated_at: string;
  incident_updates: { body: string; status: string; created_at: string }[];
}
interface ScheduledMaintenance {
  id: string;
  name: string;
  status: string;
  shortlink: string;
  scheduled_for: string;
}

let statusBarItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastSummary: StatusSummary | undefined;
let lastError: string | undefined;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('claudeStatus');
  return {
    baseUrl: cfg.get<string>('statusPageUrl', 'https://status.claude.com').replace(/\/+$/, ''),
    interval: Math.max(15, cfg.get<number>('refreshInterval', 60)),
  };
}

// ---- i18n ----
type Lang = 'en' | 'ja';

function getLang(): Lang {
  const setting = vscode.workspace.getConfiguration('claudeStatus').get<string>('language', 'auto');
  if (setting === 'ja' || setting === 'en') {
    return setting;
  }
  return vscode.env.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

const STATUS_DESC: Record<Lang, Record<string, string>> = {
  en: {
    none: 'All Systems Operational',
    minor: 'Minor Service Outage',
    major: 'Major Service Outage',
    critical: 'Critical Service Outage',
  },
  ja: {
    none: 'すべて正常に稼働しています',
    minor: '軽微な障害が発生しています',
    major: '重大な障害が発生しています',
    critical: '深刻な障害が発生しています',
  },
};

const COMPONENT_STATUS: Record<Lang, Record<string, string>> = {
  en: {
    operational: 'Operational',
    degraded_performance: 'Degraded Performance',
    partial_outage: 'Partial Outage',
    major_outage: 'Major Outage',
    under_maintenance: 'Under Maintenance',
  },
  ja: {
    operational: '正常稼働',
    degraded_performance: '性能低下',
    partial_outage: '一部障害',
    major_outage: '重大な障害',
    under_maintenance: 'メンテナンス中',
  },
};

const INCIDENT_STATUS: Record<Lang, Record<string, string>> = {
  en: {
    investigating: 'Investigating',
    identified: 'Identified',
    monitoring: 'Monitoring',
    resolved: 'Resolved',
    postmortem: 'Postmortem',
    scheduled: 'Scheduled',
    in_progress: 'In Progress',
    verifying: 'Verifying',
    completed: 'Completed',
  },
  ja: {
    investigating: '調査中',
    identified: '原因特定',
    monitoring: '経過観察',
    resolved: '解決済み',
    postmortem: '事後分析',
    scheduled: '予定',
    in_progress: '進行中',
    verifying: '確認中',
    completed: '完了',
  },
};

const UI: Record<Lang, Record<string, string>> = {
  en: {
    activeIncidents: 'Active Incidents',
    components: 'Components',
    recentHistory: 'Recent Incident History',
    noActive: 'No active incidents.',
    noHistory: 'No history available.',
    updated: 'Updated',
    lastUpdated: 'Last updated',
    clickForDetails: 'click for details',
    fetchFailed: 'Failed to fetch status',
  },
  ja: {
    activeIncidents: '進行中のインシデント',
    components: 'コンポーネント',
    recentHistory: '最近のインシデント履歴',
    noActive: '進行中のインシデントはありません。',
    noHistory: '履歴がありません。',
    updated: '更新',
    lastUpdated: '最終更新',
    clickForDetails: 'クリックで詳細',
    fetchFailed: '状態を取得できませんでした',
  },
};

function statusDescription(s: StatusSummary, lang: Lang): string {
  return STATUS_DESC[lang][s.status.indicator] ?? s.status.description;
}

function prettyIncidentStatus(status: string, lang: Lang): string {
  return INCIDENT_STATUS[lang][status] ?? status;
}

function fmtDate(d: string | Date, lang: Lang): string {
  return new Date(d).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
}

function fetchJson<T>(url: string): Promise<T> {
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
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
  });
}

function indicatorVisual(indicator: string): { icon: string; bg?: vscode.ThemeColor } {
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

function prettyComponent(status: string, lang: Lang): string {
  return (
    COMPONENT_STATUS[lang][status] ??
    status
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

function componentIcon(status: string): string {
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

function openIncidents(s: StatusSummary): Incident[] {
  return s.incidents.filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');
}

function render(s: StatusSummary) {
  const lang = getLang();
  const t = UI[lang];
  const v = indicatorVisual(s.status.indicator);
  const open = openIncidents(s);
  statusBarItem.text = open.length ? `${v.icon} Claude (${open.length})` : `${v.icon} Claude`;
  statusBarItem.backgroundColor = v.bg;

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${statusDescription(s, lang)}**\n\n`);

  if (open.length) {
    md.appendMarkdown(`---\n\n**${t.activeIncidents}**\n\n`);
    for (const i of open) {
      md.appendMarkdown(`- $(alert) ${i.name} _(${prettyIncidentStatus(i.status, lang)})_\n`);
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`---\n\n**${t.components}**\n\n`);
  for (const c of s.components.filter((c) => !c.group)) {
    md.appendMarkdown(`- ${componentIcon(c.status)} ${c.name}: ${prettyComponent(c.status, lang)}\n`);
  }

  md.appendMarkdown(`\n_${t.updated}: ${fmtDate(s.page.updated_at, lang)} — ${t.clickForDetails}_`);
  statusBarItem.tooltip = md;
}

async function refresh(showError = false) {
  const { baseUrl } = getConfig();
  try {
    const summary = await fetchJson<StatusSummary>(`${baseUrl}/api/v2/summary.json`);
    lastSummary = summary;
    lastError = undefined;
    render(summary);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    statusBarItem.text = '$(cloud) Claude: ?';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = `${UI[getLang()].fetchFailed}: ${lastError}`;
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)
  );
}

function detailsHtml(s: StatusSummary): string {
  const lang = getLang();
  const t = UI[lang];
  const v = indicatorVisual(s.status.indicator);
  const dot = s.status.indicator === 'none' ? '#3fb950' : s.status.indicator === 'minor' ? '#d29922' : '#f85149';
  void v;

  const open = openIncidents(s);
  const recent = s.incidents.slice(0, 10);

  const incidentBlock = (i: Incident) => {
    const latest = i.incident_updates[0];
    return `
      <div class="card">
        <div class="card-head">
          <span class="badge badge-${i.status}">${escapeHtml(prettyIncidentStatus(i.status, lang))}</span>
          <a href="${escapeHtml(i.shortlink)}">${escapeHtml(i.name)}</a>
        </div>
        ${latest ? `<p class="body">${escapeHtml(latest.body)}</p>` : ''}
        <p class="meta">${t.updated}: ${fmtDate(i.updated_at, lang)}</p>
      </div>`;
  };

  const componentRows = s.components
    .filter((c) => !c.group)
    .map(
      (c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td class="${c.status === 'operational' ? 'ok' : 'warn'}">${escapeHtml(prettyComponent(c.status, lang))}</td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="${lang}">
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
  <h1><span class="dot"></span> ${escapeHtml(statusDescription(s, lang))}</h1>
  <p class="updated">${t.lastUpdated}: ${fmtDate(s.page.updated_at, lang)} · <a href="${escapeHtml(s.page.url)}">status.claude.com</a></p>

  <h2>${t.activeIncidents}</h2>
  ${open.length ? open.map(incidentBlock).join('') : `<p class="empty">${t.noActive}</p>`}

  <h2>${t.components}</h2>
  <table><tbody>${componentRows}</tbody></table>

  <h2>${t.recentHistory}</h2>
  ${recent.length ? recent.map(incidentBlock).join('') : `<p class="empty">${t.noHistory}</p>`}
</body>
</html>`;
}

let panel: vscode.WebviewPanel | undefined;

async function showDetails() {
  if (!lastSummary) {
    await refresh(true);
  }
  if (!lastSummary) {
    return;
  }
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel('claudeStatusDetails', 'Claude Status', vscode.ViewColumn.Active, {
      enableScripts: false,
    });
    panel.onDidDispose(() => (panel = undefined));
  }
  panel.webview.html = detailsHtml(lastSummary);
}

function errorHtml(message: string): string {
  const lang = getLang();
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  .err { color: #f85149; font-size: .85rem; }
</style></head>
<body>
  <p class="err">${UI[lang].fetchFailed}</p>
  <p style="opacity:.7;font-size:.8rem;">${escapeHtml(message)}</p>
</body></html>`;
}

class StatusViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.onDidDispose(() => (this.view = undefined));
    this.update();
    if (!lastSummary && !lastError) {
      void refresh();
    }
  }

  update(): void {
    if (!this.view) {
      return;
    }
    if (lastSummary) {
      this.view.webview.html = detailsHtml(lastSummary);
    } else if (lastError) {
      this.view.webview.html = errorHtml(lastError);
    }
  }
}

let viewProvider: StatusViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeStatus.showDetails';
  statusBarItem.text = '$(cloud) Claude';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  viewProvider = new StatusViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeStatus.statusView', viewProvider),
    vscode.commands.registerCommand('claudeStatus.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeStatus.showDetails', () => showDetails()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeStatus')) {
        restartTimer();
        void refresh();
      }
    })
  );

  void refresh();
  restartTimer();
}

export function deactivate() {
  if (timer) {
    clearInterval(timer);
  }
}
