import * as vscode from 'vscode';
import { CodexSession, CodexUsage, CodexUsageWindow } from './types';
import { WorkspaceBindingStore } from './workspaceBindingStore';

export type SessionManagerAction =
  | { readonly command: 'newSession' | 'createGroup' | 'refresh' }
  | { readonly command: 'scope'; readonly showAll: boolean }
  | { readonly command: 'search'; readonly query: string }
  | { readonly command: 'open' | 'rename' | 'archive' | 'restore' | 'moveToGroup'; readonly sessionId: string }
  | { readonly command: 'drop'; readonly sessionId: string; readonly target: 'active' | 'archived'; readonly groupName?: string }
  | { readonly command: 'renameGroup' | 'deleteGroup'; readonly groupName: string };

/** Single session-manager view, avoiding a second native TreeView header. */
export class SessionControlsWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private showAll = false;
  private query = '';
  private sessions: readonly CodexSession[] = [];
  private error: Error | undefined;
  private usage: CodexUsage | undefined;
  private usageError: Error | undefined;
  private readonly actionEmitter = new vscode.EventEmitter<SessionManagerAction>();

  public readonly onDidRequestAction = this.actionEmitter.event;

  public constructor(initialShowAll: boolean, private readonly bindings: WorkspaceBindingStore) {
    this.showAll = initialShowAll;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isAction(message)) {
        return;
      }
      if (message.command === 'search') {
        this.query = message.query;
      }
      this.actionEmitter.fire(message);
    });
    this.render();
  }

  public setShowAll(showAll: boolean): void { this.showAll = showAll; this.render(); }
  public setQuery(query: string): void { if (this.query !== query) { this.query = query; this.render(); } }
  public getQuery(): string { return this.query; }
  public setSessions(sessions: readonly CodexSession[]): void { this.sessions = sessions; this.error = undefined; this.render(); }
  public setError(error: unknown): void { this.error = error instanceof Error ? error : new Error(String(error)); this.render(); }
  public setUsage(usage: CodexUsage): void { this.usage = usage; this.usageError = undefined; this.render(); }
  public setUsageError(error: unknown): void { this.usageError = error instanceof Error ? error : new Error(String(error)); this.render(); }
  public findSession(sessionId: string): CodexSession | undefined { return this.sessions.find((session) => session.sessionId === sessionId); }
  public refresh(): void { this.render(); }

  private render(): void {
    if (!this.view) { return; }
    const query = this.query.trim().toLocaleLowerCase();
    const scoped = this.sessions
      .filter((session) => this.showAll || this.bindings.belongsToCurrentWorkspace(session))
      .filter((session) => !query || session.title.toLocaleLowerCase().includes(query));
    this.view.webview.html = renderManager({
      sessions: scoped,
      groupNames: this.bindings.getGroupNames(),
      getGroup: (sessionId) => this.bindings.getGroup(sessionId),
      showAll: this.showAll,
      query: this.query,
      error: this.error,
      usage: this.usage,
      usageError: this.usageError
    });
  }
}

interface ManagerRenderState {
  readonly sessions: readonly CodexSession[];
  readonly groupNames: readonly string[];
  readonly getGroup: (sessionId: string) => string | undefined;
  readonly showAll: boolean;
  readonly query: string;
  readonly error: Error | undefined;
  readonly usage: CodexUsage | undefined;
  readonly usageError: Error | undefined;
}

function renderAccountUsage(usage: CodexUsage | undefined, error: Error | undefined): string {
  const account = usage?.accountEmail
    ? `<div class="account"><span>${escapeHtml(vscode.l10n.t('Email'))}</span><strong>${escapeHtml(usage.accountEmail)}</strong></div>${usage.planType ? `<div class="account"><span>${escapeHtml(vscode.l10n.t('Plan'))}</span><strong>${escapeHtml(usage.planType)}</strong></div>` : ''}`
    : '';
  const windows = usage?.windows.length
    ? usage.windows.map(renderUsageWindow).join('')
    : error
      ? `<p class="empty"><strong>${escapeHtml(vscode.l10n.t('Usage unavailable'))}</strong><br><small>${escapeHtml(error.message)}</small></p>`
      : `<p class="empty">${escapeHtml(vscode.l10n.t('Loading usage…'))}</p>`;
  return `<section class="account-panel"><div class="section-heading">⌄ ${escapeHtml(vscode.l10n.t('ACCOUNT & USAGE'))}<button class="heading-action" data-command="refresh" title="${escapeHtml(vscode.l10n.t('Refresh'))}">↻</button></div><div class="minor-heading">${escapeHtml(vscode.l10n.t('ACCOUNT'))}</div>${account}<div class="minor-heading usage-heading">${escapeHtml(vscode.l10n.t('USAGE'))}</div>${windows}</section>`;
}

function renderUsageWindow(window: CodexUsageWindow): string {
  const remaining = window.remainingPercent;
  const percentage = remaining === undefined ? 0 : Math.max(0, Math.min(100, remaining));
  const amount = remaining === undefined ? vscode.l10n.t('Unknown') : vscode.l10n.t('{0}% remaining', remaining);
  const reset = window.resetsAt === undefined ? vscode.l10n.t('Unknown') : new Date(window.resetsAt).toLocaleString();
  return `<div class="usage-window"><div class="usage-line"><span>${escapeHtml(window.label)}</span><strong>${escapeHtml(amount)}</strong></div><div class="track"><div class="bar" style="width:${percentage}%"></div></div><div class="reset">${escapeHtml(vscode.l10n.t('Resets'))}: ${escapeHtml(reset)}</div></div>`;
}

function renderManager(state: ManagerRenderState): string {
  const active = state.sessions.filter((session) => !session.archived);
  const groups = [undefined, ...state.groupNames].map((groupName) => ({
    groupName,
    sessions: active.filter((session) => state.getGroup(session.sessionId) === groupName)
  }));
  const list = state.error
    ? `<p class="empty">${escapeHtml(vscode.l10n.t('Unable to load sessions'))}<br><small>${escapeHtml(vscode.l10n.t('Check the OpenAI Codex connection'))}</small></p>`
    : `${groups.map(({ groupName, sessions }) => renderGroup(groupName, sessions, false)).join('')}${renderGroup(undefined, state.sessions.filter((session) => session.archived), true)}`;

  return `<!DOCTYPE html><html lang="${escapeHtml(vscode.env.language)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-codex-ext';"><style>
  :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  body { margin: 0; padding: 4px 12px 12px; background: var(--vscode-sideBar-background); } button, input { font: inherit; } button { color: var(--vscode-foreground); }
  .section-heading { display:flex; align-items:center; gap:7px; color:var(--vscode-descriptionForeground); font-weight:700; letter-spacing:.06em; font-size:12px; min-height:30px; } .heading-action { margin-left:auto; border:0; border-radius:3px; padding:2px 5px; background:transparent; cursor:pointer; color:var(--vscode-descriptionForeground); } .heading-action:hover { background:var(--vscode-list-hoverBackground); color:var(--vscode-foreground); } .minor-heading { margin:9px 0 10px; color:var(--vscode-descriptionForeground); letter-spacing:.07em; font-weight:700; font-size:12px; } .account { display:flex; justify-content:space-between; gap:12px; margin:0 0 7px; } .account strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .usage-heading { margin-top:15px; } .usage-window { margin-bottom:13px; } .usage-line { display:flex; justify-content:space-between; gap:10px; margin-bottom:5px; } .track { height:8px; border-radius:999px; overflow:hidden; background:color-mix(in srgb,var(--vscode-foreground) 13%,transparent); } .bar { height:100%; min-width:2px; border-radius:inherit; background:var(--vscode-charts-green); } .reset { margin-top:5px; color:var(--vscode-descriptionForeground); font-size:12px; }
  .manager-panel { margin-top:18px; padding-top:8px; border-top:1px solid var(--vscode-widget-border); } .manager-heading { margin-bottom:4px; } .top-actions { display:flex; gap:2px; } .top-action { border:0; border-radius:4px; padding:8px 10px; background:transparent; text-align:left; cursor:pointer; font-size:15px; } .top-action:hover,.icon:hover { background:var(--vscode-list-hoverBackground); }
  .tabs { display:flex; margin-top:10px; padding:3px; gap:3px; border-radius:6px; background:var(--vscode-editorWidget-background); } .tab { flex:1; border:0; border-radius:4px; padding:7px 6px; background:transparent; color:var(--vscode-descriptionForeground); cursor:pointer; } .tab.active { background:var(--vscode-button-secondaryBackground); color:var(--vscode-foreground); box-shadow:0 0 0 1px var(--vscode-widget-border); }
  .search { display:flex; align-items:center; gap:6px; margin:10px 0 8px; padding:0 8px; border:1px solid var(--vscode-input-border); border-radius:4px; background:var(--vscode-input-background); } .search:focus-within { border-color:var(--vscode-focusBorder); } .search-symbol { color:var(--vscode-descriptionForeground); font-size:18px; } .search input { min-width:0; flex:1; height:30px; border:0; outline:0; color:var(--vscode-input-foreground); background:transparent; } .search input::placeholder { color:var(--vscode-input-placeholderForeground); } .clear { display:none; border:0; padding:2px; color:var(--vscode-descriptionForeground); background:transparent; cursor:pointer; } .search.has-query .clear { display:block; }
  .svg-icon { width:16px; height:16px; flex:none; stroke:currentColor; fill:none; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; } .group { border:0; margin:0; border-radius:4px; } .group.drag-over { outline:1px dashed var(--vscode-focusBorder); background:var(--vscode-list-dropBackground); } .group>summary { display:flex; align-items:center; min-height:30px; cursor:pointer; list-style:none; } .group>summary::-webkit-details-marker { display:none; } .chevron { width:18px; color:var(--vscode-descriptionForeground); transition:transform .12s; } .chevron .svg-icon { width:14px; height:14px; } details:not([open]) .chevron { transform:rotate(-90deg); } .group-label { flex:1; display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .count { margin-left:6px; color:var(--vscode-descriptionForeground); } .group-actions { display:flex; margin-left:4px; }
  .sessions { margin-left:18px; } .session { display:flex; align-items:center; gap:7px; min-height:29px; padding:0 3px; border-radius:3px; cursor:pointer; } .session:hover { background:var(--vscode-list-hoverBackground); } .session-icon { color:var(--vscode-descriptionForeground); display:flex; } .session-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .session-actions { display:none; gap:1px; } .session:hover .session-actions,.session:focus-within .session-actions { display:flex; } .icon { display:flex; align-items:center; border:0; border-radius:3px; padding:3px; color:var(--vscode-descriptionForeground); background:transparent; cursor:pointer; } .empty { color:var(--vscode-descriptionForeground); margin:16px 6px; } small { font-size:12px; }
  </style></head><body>
  ${renderAccountUsage(state.usage, state.usageError)}<section class="manager-panel"><div class="section-heading manager-heading">⌄ ${escapeHtml(vscode.l10n.t('SESSION MANAGER'))}</div><div class="top-actions"><button class="top-action" data-command="newSession">＋ ${escapeHtml(vscode.l10n.t('New session'))}</button><button class="top-action" data-command="createGroup">＋ ${escapeHtml(vscode.l10n.t('New group'))}</button></div>
  <div class="tabs" role="tablist" aria-label="${escapeHtml(vscode.l10n.t('Session scope'))}"><button class="tab ${state.showAll ? '' : 'active'}" role="tab" aria-selected="${String(!state.showAll)}" data-scope="workspace">${escapeHtml(vscode.l10n.t('Workspace'))}</button><button class="tab ${state.showAll ? 'active' : ''}" role="tab" aria-selected="${String(state.showAll)}" data-scope="all">${escapeHtml(vscode.l10n.t('All sessions'))}</button></div>
  <div class="search${state.query ? ' has-query' : ''}"><span class="search-symbol" aria-hidden="true">⌕</span><input id="search" type="search" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(vscode.l10n.t('Search sessions'))}" aria-label="${escapeHtml(vscode.l10n.t('Search sessions'))}"><button class="clear" type="button" aria-label="${escapeHtml(vscode.l10n.t('Clear search'))}">×</button></div>
  <main>${list}</main></section><script nonce="codex-ext">
  const vscode=acquireVsCodeApi(); document.querySelectorAll('[data-command]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({command:b.dataset.command}))); document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({command:'scope',showAll:b.dataset.scope==='all'}))); document.querySelectorAll('[data-session-command]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();vscode.postMessage({command:b.dataset.sessionCommand,sessionId:b.dataset.sessionId})})); document.querySelectorAll('[data-group-command]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();vscode.postMessage({command:b.dataset.groupCommand,groupName:b.dataset.groupName})})); document.querySelectorAll('[data-open-session]').forEach(row=>{row.addEventListener('click',()=>vscode.postMessage({command:row.dataset.archived==='true'?'restore':'open',sessionId:row.dataset.openSession}));row.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',row.dataset.openSession);e.dataTransfer.effectAllowed='move'})}); document.querySelectorAll('[data-drop-target]').forEach(group=>{group.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';group.classList.add('drag-over')});group.addEventListener('dragleave',()=>group.classList.remove('drag-over'));group.addEventListener('drop',e=>{e.preventDefault();group.classList.remove('drag-over');const sessionId=e.dataTransfer.getData('text/plain');if(sessionId)vscode.postMessage({command:'drop',sessionId,target:group.dataset.dropTarget,groupName:group.dataset.groupName||undefined})})}); const search=document.querySelector('#search'),searchBox=document.querySelector('.search'),clear=document.querySelector('.clear'); search.addEventListener('input',()=>{searchBox.classList.toggle('has-query',Boolean(search.value));vscode.postMessage({command:'search',query:search.value})}); clear.addEventListener('click',()=>{search.value='';searchBox.classList.remove('has-query');vscode.postMessage({command:'search',query:''});search.focus()});
  </script></body></html>`;
}

function renderGroup(groupName: string | undefined, sessions: readonly CodexSession[], archived: boolean): string {
  const label = archived ? vscode.l10n.t('Archived') : groupName ?? vscode.l10n.t('Ungrouped');
  const groupActions = !archived && groupName ? `<span class="group-actions"><button class="icon" data-group-command="renameGroup" data-group-name="${escapeHtml(groupName)}" title="${escapeHtml(vscode.l10n.t('Rename group'))}" aria-label="${escapeHtml(vscode.l10n.t('Rename group'))}">${icon('edit')}</button><button class="icon" data-group-command="deleteGroup" data-group-name="${escapeHtml(groupName)}" title="${escapeHtml(vscode.l10n.t('Remove group'))}" aria-label="${escapeHtml(vscode.l10n.t('Remove group'))}">${icon('delete')}</button></span>` : '';
  const rows = sessions.map(renderSession).join('');
  const open = !archived && sessions.length > 0 ? ' open' : '';
  const drop = archived ? ' data-drop-target="archived"' : ` data-drop-target="active"${groupName ? ` data-group-name="${escapeHtml(groupName)}"` : ''}`;
  const dropTitle = archived ? vscode.l10n.t('Drop a session here to archive it') : vscode.l10n.t('Drop a session here to move it');
  return `<details class="group"${drop}${open}><summary title="${escapeHtml(dropTitle)}"><span class="chevron">${icon('chevron')}</span><span class="group-label">${icon(archived ? 'archive' : 'folder')}${escapeHtml(label)}</span><span class="count">${sessions.length}</span>${groupActions}</summary>${rows ? `<div class="sessions">${rows}</div>` : ''}</details>`;
}

function renderSession(session: CodexSession): string {
  const archived = Boolean(session.archived);
  const actions = archived ? `<button class="icon" data-session-command="restore" data-session-id="${escapeHtml(session.sessionId)}" title="${escapeHtml(vscode.l10n.t('Restore Archived Session'))}" aria-label="${escapeHtml(vscode.l10n.t('Restore Archived Session'))}">${icon('restore')}</button>` : `<button class="icon" data-session-command="rename" data-session-id="${escapeHtml(session.sessionId)}" title="${escapeHtml(vscode.l10n.t('Rename session'))}" aria-label="${escapeHtml(vscode.l10n.t('Rename session'))}">${icon('edit')}</button><button class="icon" data-session-command="moveToGroup" data-session-id="${escapeHtml(session.sessionId)}" title="${escapeHtml(vscode.l10n.t('Move to group'))}" aria-label="${escapeHtml(vscode.l10n.t('Move to group'))}">${icon('move')}</button><button class="icon" data-session-command="archive" data-session-id="${escapeHtml(session.sessionId)}" title="${escapeHtml(vscode.l10n.t('Archive session'))}" aria-label="${escapeHtml(vscode.l10n.t('Archive session'))}">${icon('archive')}</button>`;
  const tooltip = archived ? vscode.l10n.t('Restore Archived Session') : vscode.l10n.t('Open Session');
  return `<div class="session" role="button" tabindex="0" draggable="true" data-open-session="${escapeHtml(session.sessionId)}" data-archived="${String(archived)}" title="${escapeHtml(tooltip)}"><span class="session-icon">${icon(archived ? 'archive' : 'chat')}</span><span class="session-title">${escapeHtml(session.title || vscode.l10n.t('Untitled session'))}</span><span class="session-actions">${actions}</span></div>`;
}

function isAction(value: unknown): value is SessionManagerAction {
  if (typeof value !== 'object' || value === null || !('command' in value)) { return false; }
  const message = value as { command?: unknown; showAll?: unknown; query?: unknown; sessionId?: unknown; groupName?: unknown; target?: unknown };
  if (message.command === 'newSession' || message.command === 'createGroup' || message.command === 'refresh') { return true; }
  if (message.command === 'scope') { return typeof message.showAll === 'boolean'; }
  if (message.command === 'search') { return typeof message.query === 'string'; }
  if (message.command === 'open' || message.command === 'rename' || message.command === 'archive' || message.command === 'restore' || message.command === 'moveToGroup') { return typeof message.sessionId === 'string'; }
  if (message.command === 'drop') { return typeof message.sessionId === 'string' && (message.target === 'active' || message.target === 'archived') && (message.groupName === undefined || typeof message.groupName === 'string'); }
  return (message.command === 'renameGroup' || message.command === 'deleteGroup') && typeof message.groupName === 'string';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

/** Minimal codicon-like SVGs; Webviews cannot render VS Code ThemeIcon glyphs. */
function icon(kind: 'archive' | 'chat' | 'chevron' | 'delete' | 'edit' | 'folder' | 'move' | 'restore'): string {
  const paths: Record<typeof kind, string> = {
    archive: '<path d="M3 5h10v8H3z"/><path d="M2 3h12v2H2zM6 8h4"/>',
    chat: '<path d="M3 3h10v8H7l-3 3v-3H3z"/><path d="M6 6h4M6 8h3"/>',
    chevron: '<path d="m3 5 4 4 4-4"/>',
    delete: '<path d="M4 5h8M6 5V3h4v2M5 5l.5 8h5l.5-8M7 7v4M9 7v4"/>',
    edit: '<path d="m4 12 2.3-.5L12 5.8 10.2 4 4.5 9.7 4 12zM9.5 4.7l1.8 1.8"/>',
    folder: '<path d="M2 4h4l1.3 1.5H14v7.5H2z"/>',
    move: '<path d="M2 4h5l1 1.5h4v6.5H2z"/><path d="M7 9h6M11 6l3 3-3 3"/>',
    restore: '<path d="M4 6V3L1.5 5.5 4 8V6a5 5 0 1 1-1 3"/>'
  };
  return `<svg class="svg-icon" viewBox="0 0 16 16" aria-hidden="true">${paths[kind]}</svg>`;
}
