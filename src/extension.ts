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
let extensionVersion = '';

const REPO_URL = 'https://github.com/kpab/claude-service-status';
const MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=kpab.claude-service-status';

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
    disclaimer: 'Unofficial — not affiliated with Anthropic.',
    connectionError: 'CONNECTION ERROR',
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
    disclaimer: '非公式 — Anthropic とは無関係です。',
    connectionError: '接続エラー',
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

// ---- Webview design tokens ----

const INDICATOR_CODE: Record<string, string> = {
  none: 'OPERATIONAL',
  minor: 'MINOR OUTAGE',
  major: 'MAJOR OUTAGE',
  critical: 'CRITICAL OUTAGE',
};

function signalColor(indicator: string): string {
  switch (indicator) {
    case 'none':
      return '#3fb950';
    case 'minor':
      return '#d29922';
    case 'major':
    case 'critical':
      return '#f85149';
    default:
      return '#8b949e';
  }
}

function incidentAccent(status: string): string {
  switch (status) {
    case 'investigating':
    case 'identified':
      return '#f85149';
    case 'monitoring':
    case 'in_progress':
    case 'verifying':
    case 'scheduled':
      return '#d29922';
    case 'resolved':
    case 'completed':
    case 'postmortem':
      return '#3fb950';
    default:
      return '#8b949e';
  }
}

function componentStateClass(status: string): string {
  switch (status) {
    case 'operational':
      return 's-ok';
    case 'under_maintenance':
      return 's-maint';
    case 'degraded_performance':
    case 'partial_outage':
      return 's-warn';
    case 'major_outage':
      return 's-bad';
    default:
      return '';
  }
}

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function webviewStyles(): string {
  return `
  :root { --coral: #d97757; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    margin: 0; padding: 0; font-size: 13px; line-height: 1.55; }
  .app { position: relative; padding-bottom: 1.6rem; animation: rise .5s ease both; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible { outline: 1px solid var(--signal); outline-offset: 2px; border-radius: 2px; }

  .signalbar { height: 3px; width: 100%; background: var(--signal); box-shadow: 0 0 10px var(--signal-soft); }

  .mono { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); }

  /* Hero */
  .hero { display: flex; gap: .9rem; align-items: flex-start; padding: 1.5rem 1.5rem .3rem; }
  .beacon-wrap { padding-top: .55rem; }
  .beacon { position: relative; display: block; width: 13px; height: 13px; }
  .beacon .dot { position: absolute; inset: 0; border-radius: 50%; background: var(--signal);
    box-shadow: 0 0 0 4px var(--signal-soft); }
  .beacon .ring { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid var(--signal);
    opacity: 0; animation: ping 2.6s cubic-bezier(0, 0, .2, 1) infinite; }
  .beacon .ring.r2 { animation-delay: 1.3s; }
  @keyframes ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(4.2); opacity: 0; } }

  .eyebrow { font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase; color: var(--signal);
    margin: 0 0 .2rem; font-weight: 600; }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 .4rem; letter-spacing: -.01em; line-height: 1.2; }
  .meta { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 11px;
    color: var(--vscode-descriptionForeground); margin: 0; letter-spacing: .01em; }

  /* Section */
  section { padding: 0 1.5rem; margin-top: 1.7rem; }
  .section-label { display: flex; align-items: center; gap: .6rem;
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin: 0 0 .8rem; }
  .section-label::after { content: ""; flex: 1; height: 1px; background: var(--vscode-panel-border); }
  .count { color: var(--coral); font-weight: 600; }

  .empty { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 11px;
    color: var(--vscode-descriptionForeground); padding: .2rem .15rem; letter-spacing: .01em; }

  /* Badge */
  .badge { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 9.5px;
    letter-spacing: .1em; text-transform: uppercase; padding: .16rem .45rem; border-radius: 4px;
    border: 1px solid currentColor; white-space: nowrap; flex: none; }

  /* Incident cards */
  .card { border: 1px solid var(--vscode-panel-border); border-left: 2px solid var(--st);
    border-radius: 8px; padding: .75rem .9rem; margin-bottom: .6rem; }
  .card-head { display: flex; align-items: center; gap: .55rem; }
  .card-head a { font-weight: 600; font-size: 13px; }
  .card-body { font-size: 12px; margin: .5rem 0 .35rem; white-space: pre-wrap;
    color: var(--vscode-foreground); opacity: .9; }
  .card-meta { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 10px;
    color: var(--vscode-descriptionForeground); margin: 0; letter-spacing: .02em; }

  /* Components */
  .comp { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: .5rem .65rem; border-radius: 7px; }
  .comp:hover { background: var(--vscode-list-hoverBackground); }
  .comp-name { font-size: 12.5px; }
  .state { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 10px;
    letter-spacing: .08em; text-transform: uppercase; display: inline-flex; align-items: center;
    gap: .45rem; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .state::before { content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--st, var(--vscode-descriptionForeground)); flex: none; }
  .state.s-ok { --st: #3fb950; }
  .state.s-warn { --st: #d29922; color: #d29922; }
  .state.s-bad { --st: #f85149; color: #f85149; }
  .state.s-maint { --st: var(--coral); color: var(--coral); }

  /* History timeline */
  .timeline { position: relative; margin-left: 4px; padding-left: 1.15rem;
    border-left: 1px solid var(--vscode-panel-border); }
  .tl-item { position: relative; padding-bottom: 1.1rem; }
  .tl-item:last-child { padding-bottom: 0; }
  .tl-node { position: absolute; left: calc(-1.15rem - 4.5px); top: .35rem; width: 8px; height: 8px;
    border-radius: 50%; background: var(--st); border: 2px solid var(--vscode-editor-background); }
  .tl-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .tl-head a { font-size: 12.5px; font-weight: 500; }
  .tl-meta { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 10px;
    color: var(--vscode-descriptionForeground); margin: .2rem 0 0; letter-spacing: .02em; }

  /* Footer */
  footer { margin-top: 2rem; padding: 1.1rem 1.5rem 0; border-top: 1px solid var(--vscode-panel-border);
    display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1.1rem; }
  .ver { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 10.5px;
    letter-spacing: .06em; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: .14rem .6rem; }
  footer nav { display: flex; gap: 1.1rem; }
  footer nav a { font-size: 11.5px; }
  .disclaimer { flex-basis: 100%; margin: .25rem 0 0; font-size: 10.5px;
    color: var(--vscode-descriptionForeground); opacity: .8; }

  @media (max-width: 360px) {
    .hero, section, footer { padding-left: 1rem; padding-right: 1rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .app { animation: none; }
    .beacon .ring { animation: none; display: none; }
  }`;
}

function pageShell(lang: Lang, signalHex: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${webviewStyles()}</style>
</head>
<body>
<div class="app" style="--signal: ${signalHex}; --signal-soft: ${rgba(signalHex, 0.35)};">
${body}
</div>
</body>
</html>`;
}

function footerHtml(t: Record<string, string>): string {
  const ver = extensionVersion ? `<span class="ver">v${escapeHtml(extensionVersion)}</span>` : '';
  return `
  <footer>
    ${ver}
    <nav>
      <a href="${MARKETPLACE_URL}">Marketplace</a>
      <a href="${REPO_URL}">GitHub</a>
    </nav>
    <p class="disclaimer">${t.disclaimer}</p>
  </footer>`;
}

function detailsHtml(s: StatusSummary): string {
  const lang = getLang();
  const t = UI[lang];
  const signal = signalColor(s.status.indicator);
  const code = INDICATOR_CODE[s.status.indicator] ?? 'UNKNOWN';

  const open = openIncidents(s);
  const recent = s.incidents.slice(0, 10);
  const comps = s.components.filter((c) => !c.group);

  const incidentCard = (i: Incident) => {
    const accent = incidentAccent(i.status);
    const latest = i.incident_updates[0];
    return `
    <div class="card" style="--st: ${accent};">
      <div class="card-head">
        <span class="badge" style="color: ${accent};">${escapeHtml(prettyIncidentStatus(i.status, lang))}</span>
        <a href="${escapeHtml(i.shortlink)}">${escapeHtml(i.name)}</a>
      </div>
      ${latest ? `<p class="card-body">${escapeHtml(latest.body)}</p>` : ''}
      <p class="card-meta">${t.updated} · ${fmtDate(i.updated_at, lang)}</p>
    </div>`;
  };

  const timelineItem = (i: Incident) => {
    const accent = incidentAccent(i.status);
    return `
    <div class="tl-item">
      <span class="tl-node" style="--st: ${accent};"></span>
      <div class="tl-head">
        <a href="${escapeHtml(i.shortlink)}">${escapeHtml(i.name)}</a>
        <span class="badge" style="color: ${accent};">${escapeHtml(prettyIncidentStatus(i.status, lang))}</span>
      </div>
      <p class="tl-meta">${fmtDate(i.updated_at, lang)}</p>
    </div>`;
  };

  const componentRow = (c: Component) => `
    <div class="comp">
      <span class="comp-name">${escapeHtml(c.name)}</span>
      <span class="state ${componentStateClass(c.status)}">${escapeHtml(prettyComponent(c.status, lang))}</span>
    </div>`;

  const body = `
  <div class="signalbar"></div>
  <header class="hero">
    <div class="beacon-wrap">
      <span class="beacon"><span class="ring"></span><span class="ring r2"></span><span class="dot"></span></span>
    </div>
    <div class="hero-text">
      <p class="eyebrow">${code}</p>
      <h1>${escapeHtml(statusDescription(s, lang))}</h1>
      <p class="meta">${t.updated} ${fmtDate(s.page.updated_at, lang)} · <a href="${escapeHtml(s.page.url)}">status.claude.com</a></p>
    </div>
  </header>

  <section>
    <p class="section-label">${t.activeIncidents}${open.length ? ` <span class="count">${open.length}</span>` : ''}</p>
    ${open.length ? open.map(incidentCard).join('') : `<p class="empty">${t.noActive}</p>`}
  </section>

  <section>
    <p class="section-label">${t.components}</p>
    <div class="comps">${comps.map(componentRow).join('')}</div>
  </section>

  <section>
    <p class="section-label">${t.recentHistory}</p>
    ${recent.length ? `<div class="timeline">${recent.map(timelineItem).join('')}</div>` : `<p class="empty">${t.noHistory}</p>`}
  </section>

  ${footerHtml(t)}`;

  return pageShell(lang, signal, body);
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
  const t = UI[lang];
  const body = `
  <div class="signalbar"></div>
  <header class="hero">
    <div class="beacon-wrap">
      <span class="beacon"><span class="dot"></span></span>
    </div>
    <div class="hero-text">
      <p class="eyebrow">${t.connectionError}</p>
      <h1>${t.fetchFailed}</h1>
      <p class="meta">${escapeHtml(message)}</p>
    </div>
  </header>
  ${footerHtml(t)}`;
  return pageShell(lang, '#f85149', body);
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
  extensionVersion = (context.extension.packageJSON?.version as string) ?? '';

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
