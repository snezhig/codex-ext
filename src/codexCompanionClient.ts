import * as vscode from 'vscode';
import { execFile as executeFile, spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import { CodexSession, CodexUsage, CodexUsageWindow } from './types';
import { ConversationEditorGroups } from './conversationEditorGroups';

const execFile = promisify(executeFile);

/**
 * Owns the integration with the official Codex extension and its local state.
 * This extension intentionally has no dependency on codex-companion.
 */
export class CodexSessionClient implements vscode.Disposable {
  private readonly editors = new ConversationEditorGroups();
  private reloads: Promise<void> = Promise.resolve();

  public constructor() {
    this.editors.initialize();
  }

  public dispose(): void {
    this.editors.dispose();
  }

  public async listSessions(): Promise<readonly CodexSession[]> {
    const codexHome = this.getCodexHome();
    const stateSessions = await this.readCodexStateSessions(codexHome);
    return stateSessions ?? this.readLocalSessionIndex(codexHome);
  }

  public async openSession(session: CodexSession, group = vscode.window.tabGroups.activeTabGroup): Promise<void> {
    await this.openConversation(session.sessionId, group);
  }

  /**
   * Recreates a failed official Codex custom editor without reloading VS Code.
   * Open a fresh URI identity before closing the old tab, keeping its group
   * alive and avoiding reuse of the failed custom document/webview instance.
   */
  public async reloadSessionTab(resource?: vscode.Uri): Promise<void> {
    const uri = resource ?? this.getActiveCodexConversationUri();
    if (!uri || uri.scheme !== 'openai-codex'
      || (!uri.path.startsWith('/local/') && uri.path !== '/extension/panel/new')) {
      throw new Error(vscode.l10n.t('Select an open Codex conversation tab to reload it.'));
    }
    const result = this.reloads.then(() => this.replaceSessionTab(uri));
    this.reloads = result.catch(() => undefined);
    return result;
  }

  private async replaceSessionTab(uri: vscode.Uri): Promise<void> {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) {
      throw new Error(vscode.l10n.t('OpenAI Codex (openai.chatgpt) is required.'));
    }
    await extension.activate();
    const matchingTabs: vscode.Tab[] = [];
    let originalGroup: vscode.TabGroup | undefined;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputCustom
          && tab.input.viewType === 'chatgpt.conversationEditor'
          && tab.input.uri.toString() === uri.toString()) {
          matchingTabs.push(tab);
          originalGroup = group;
        }
      }
    }
    if (matchingTabs.length === 0 || !originalGroup) {
      // A previous queued reload may already have replaced this exact tab.
      return;
    }
    // The official route parser ignores fragments. Use one as a fresh editor
    // identity, just as for independent drafts, without changing the thread.
    const replacement = uri.with({ fragment: `codex-ext-reload-${randomUUID()}` });
    await this.editors.openFresh(replacement, originalGroup);
    const closed = await vscode.window.tabGroups.close(matchingTabs, true);
    if (!closed) {
      // Respect a refused close and roll back only the replacement we created.
      const replacementTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputCustom
          && tab.input.uri.toString() === replacement.toString());
      if (replacementTabs.length > 0) {
        await vscode.window.tabGroups.close(replacementTabs, true);
      }
      await this.editors.open(uri, originalGroup);
    }
  }

  /** Opens an independent official Codex draft in the requested editor group. */
  public async createSession(group = vscode.window.tabGroups.activeTabGroup): Promise<void> {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) {
      throw new Error(vscode.l10n.t('OpenAI Codex (openai.chatgpt) is required.'));
    }
    await extension.activate();
    // The official command always opens the same `/new` URI, so VS Code focuses
    // an existing draft instead of opening another one. The official Codex
    // route parser intentionally ignores URI fragments; use one only as a
    // per-draft identity. This keeps the official route untouched while letting
    // VS Code create an independent custom-editor tab for each new draft.
    const uri = vscode.Uri.from({
      scheme: 'openai-codex',
      authority: 'route',
      path: '/extension/panel/new',
      fragment: `codex-ext-draft-${randomUUID()}`
    });
    await this.editors.open(uri, group);
  }

  /** Reads the account allowance exposed by the official Codex app-server. */
  public async readUsage(): Promise<CodexUsage> {
    try {
      const usage = await vscode.commands.executeCommand<CodexUsage | undefined>('codexExt.localBridge.readUsage');
      if (!usage) {
        throw new Error(vscode.l10n.t('The local usage bridge returned no data.'));
      }
      return usage;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(vscode.l10n.t('Local usage helper is unavailable. Update Codex Ext and install its Local Bridge: {0}', detail));
    }
  }

  /** Reveals an existing tab in place, or opens it in the requested group. */
  private async openConversation(sessionId: string, group: vscode.TabGroup): Promise<void> {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) {
      throw new Error(vscode.l10n.t('OpenAI Codex (openai.chatgpt) is required.'));
    }
    await extension.activate();
    const uri = vscode.Uri.from({
      scheme: 'openai-codex',
      authority: 'route',
      path: `/local/${sessionId}`
    });
    await this.editors.open(uri, group);
  }

  private getActiveCodexConversationUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === 'chatgpt.conversationEditor'
      ? input.uri
      : undefined;
  }

  /*
   * Use the app-server bundled with OpenAI Codex for state-changing actions.
   * It keeps archive and rename operations consistent with Codex itself instead
   * of writing undocumented local database files directly.
   */
  public async renameSession(session: CodexSession): Promise<void> {
    const title = await vscode.window.showInputBox({
      title: vscode.l10n.t('Rename Codex session'),
      value: session.title,
      validateInput: (value) => value.trim() ? undefined : vscode.l10n.t('Enter a session name.')
    });
    if (title === undefined || title.trim() === session.title) {
      return;
    }
    await this.withCodexAppServer((request) => request('thread/name/set', {
      threadId: session.sessionId,
      name: title.trim()
    }));
  }

  public async archiveSession(session: CodexSession): Promise<void> {
    await this.withCodexAppServer((request) => request('thread/archive', { threadId: session.sessionId }));
  }

  /** Restores the exact archived row the user selected. */
  public async restoreArchivedSession(session: CodexSession): Promise<void> {
    await this.withCodexAppServer((request) => request('thread/unarchive', { threadId: session.sessionId }));
  }

  /**
   * Use the app-server bundled with OpenAI Codex for state-changing actions.
   * It keeps archive and rename operations consistent with Codex itself instead
   * of writing undocumented local database files directly.
   */
  private async withCodexAppServer<T>(action: (request: AppServerRequest) => Promise<T>): Promise<T> {
    const executable = await this.getCodexExecutable();
    const codexHome = this.getCodexHome();

    return new Promise<T>((resolve, reject) => {
      const child = spawn(executable, ['app-server'], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      const pending = new Map<number, PendingRequest>();
      const output = readline.createInterface({ input: child.stdout });
      let nextId = 1;
      let finished = false;

      const finish = (error?: Error, value?: T): void => {
        if (finished) {
          return;
        }
        finished = true;
        output.close();
        child.stdin.end();
        child.kill();
        for (const request of pending.values()) {
          clearTimeout(request.timeout);
          request.reject(error ?? new Error(vscode.l10n.t('Codex app server closed.')));
        }
        pending.clear();
        if (error) {
          reject(error);
        } else {
          resolve(value as T);
        }
      };
      const send = (message: unknown): void => {
        if (!finished) {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        }
      };
      const request: AppServerRequest = (method, params) => new Promise<unknown>((resolveRequest, rejectRequest) => {
        if (finished) {
          rejectRequest(new Error(vscode.l10n.t('Codex app server is unavailable.')));
          return;
        }
        const id = nextId++;
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(vscode.l10n.t('Codex request timed out: {0}', method)));
        }, 20_000);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
        send({ id, method, params });
      });

      child.once('error', (error) => finish(error));
      child.once('exit', () => {
        if (!finished) {
          finish(new Error(vscode.l10n.t('Codex app server exited unexpectedly.')));
        }
      });
      child.stdin.once('error', (error) => finish(error));
      // App-server diagnostics are intentionally not treated as protocol data.
      child.stderr.resume();
      output.on('line', (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message)) {
          return;
        }
        if (typeof message.method === 'string') {
          // This client needs no server-initiated capability. Acknowledge
          // requests so a future server version cannot remain blocked here.
          if (typeof message.id === 'number') {
            send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
          }
          return;
        }
        if (typeof message.id !== 'number') {
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) {
          return;
        }
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (isRecord(message.error)) {
          entry.reject(new Error(typeof message.error.message === 'string'
            ? message.error.message
            : vscode.l10n.t('Codex request failed.')));
          return;
        }
        entry.resolve(message.result);
      });

      void (async () => {
        try {
          await request('initialize', {
            clientInfo: { name: 'codex-ext', version: '0.5.0' }
          });
          send({ method: 'initialized', params: {} });
          finish(undefined, await action(request));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  private async getCodexExecutable(): Promise<string> {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    const candidates: string[] = [];
    if (extension) {
      await extension.activate();
      const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      candidates.push(join(extension.extensionPath, 'bin', `${platform}-${architecture}`, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    }

    // A Remote-SSH window can have the official extension installed only on
    // the server. Its extensionPath is then not executable from this local UI
    // host. ChatGPT Desktop bundles the same local Codex CLI on macOS, which
    // gives usage and account reads a reliable local fallback.
    if (process.platform === 'darwin') {
      candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
    }
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next local installation location.
      }
    }
    throw new Error(vscode.l10n.t('Unable to find a local Codex executable. Install OpenAI Codex or ChatGPT locally.'));
  }

  private getCodexHome(): string {
    const configuredHome = vscode.workspace
      .getConfiguration('codexWorkspaceSessions')
      .get<string>('codexHome', '')
      .trim();
    return configuredHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  }

  /**
   * Codex Desktop stores the same user-facing thread list shown in its sidebar
   * in state_5.sqlite. It includes the real title, workspace and archive state,
   * unlike session_index.jsonl, which also contains invisible guardian reviews.
   * If the optional local SQLite CLI is unavailable, callers fall back to the
   * portable JSONL reader below.
   */
  private async readCodexStateSessions(codexHome: string): Promise<readonly CodexSession[] | undefined> {
    const databasePaths = [join(codexHome, 'state_5.sqlite'), join(codexHome, 'sqlite', 'state_5.sqlite')];
    const indexTitles = await this.readSessionIndexTitles(codexHome);
    // Do not use sqlite3's newer `-json` output mode: it is absent on many
    // Remote-SSH hosts. Hex-encode text columns so tabs, newlines and Unicode
    // in a title cannot corrupt the portable tab-separated output.
    const query = [
      'SELECT hex(id), hex(title), hex(name), hex(cwd),',
      'CASE WHEN archived THEN 1 ELSE 0 END, COALESCE(recency_at_ms, 0)',
      'FROM threads',
      "WHERE COALESCE(thread_source, 'user') = 'user'",
      'ORDER BY recency_at_ms DESC, id DESC;'
    ].join(' ');

    for (const databasePath of databasePaths) {
      try {
        const { stdout } = await execFile('/usr/bin/sqlite3', [
          '-readonly',
          '-separator',
          '\t',
          databasePath,
          query
        ], { maxBuffer: 8 * 1024 * 1024 });
        return stdout.split(/\r?\n/).flatMap((line): CodexSession[] => {
          if (!line) {
            return [];
          }
          const [idHex, titleHex, nameHex, cwdHex, archived, updatedAt] = line.split('\t');
          const sessionId = decodeSqliteHex(idHex);
          const title = decodeSqliteHex(titleHex);
          if (!sessionId || !title) {
            return [];
          }
          const name = decodeSqliteHex(nameHex);
          const cwd = decodeSqliteHex(cwdHex);
          return [{
            sessionId,
            // Codex's sidebar stores its edited/display title in the compact
            // index, while `name` is the explicit title set through Codex.
            title: name?.trim() || indexTitles.get(sessionId) || title,
            updatedAt: parseEpochMilliseconds(Number(updatedAt)),
            archived: archived === '1',
            workspacePaths: cwd ? [cwd] : []
          }];
        });
      } catch {
        // Try the alternate database location, then the JSONL fallback.
      }
    }
    return undefined;
  }

  private async readSessionIndexTitles(codexHome: string): Promise<ReadonlyMap<string, string>> {
    try {
      const contents = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8');
      const latest = new Map<string, IndexedSession>();
      for (const line of contents.split(/\r?\n/)) {
        const item = parseIndexLine(line);
        if (!item || isGuardianReview(item.title)) {
          continue;
        }
        const previous = latest.get(item.sessionId);
        if (!previous || item.updatedAt >= previous.updatedAt) {
          latest.set(item.sessionId, item);
        }
      }
      return new Map([...latest].map(([sessionId, session]) => [sessionId, session.title]));
    } catch {
      return new Map();
    }
  }

  private async readLocalSessionIndex(codexHome: string): Promise<readonly CodexSession[]> {
    const indexPath = join(codexHome, 'session_index.jsonl');

    let contents: string;
    try {
      contents = await readFile(indexPath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(vscode.l10n.t('Unable to read Codex session index at {0}: {1}', indexPath, detail));
    }

    const latest = new Map<string, IndexedSession>();
    for (const line of contents.split(/\r?\n/)) {
      const item = parseIndexLine(line);
      // JSONL lacks the thread-source field. Keep this defensive filter for
      // hosts without sqlite3, where otherwise internal Guardian reviews leak
      // into the user session list.
      if (!item || isGuardianReview(item.title)) {
        continue;
      }
      const previous = latest.get(item.sessionId);
      if (!previous || item.updatedAt >= previous.updatedAt) {
        latest.set(item.sessionId, item);
      }
    }

    const indexedIds = new Set(latest.keys());
    const workspacePathsBySession = await this.readSessionWorkspacePaths(codexHome, indexedIds);
    const archivedIds = await this.readArchivedSessionIds(codexHome);
    const archivedIdSet = new Set(archivedIds);
    const indexed = [...latest.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ sessionId, title, updatedAt }) => ({
        sessionId,
        title,
        updatedAt,
        archived: archivedIdSet.has(sessionId),
        workspacePaths: workspacePathsBySession.get(sessionId)
      }));

    // A session may be archived before an index entry is written. Keep it
    // visible even then; Codex's archive filename contains its session id.
    const archiveOnly = archivedIds
      .filter((sessionId) => !indexedIds.has(sessionId))
      .map((sessionId) => ({ sessionId, title: vscode.l10n.t('Archived session'), archived: true }));

    return [...indexed, ...archiveOnly];
  }

  /**
   * Codex's compact session index has titles and timestamps but deliberately
   * omits a workspace. The first `session_meta` record in each local rollout
   * contains `cwd` and `runtime_workspace_roots`, so use it to recover the
   * relationship for sessions created before this extension was installed.
   */
  private async readSessionWorkspacePaths(
    codexHome: string,
    targetSessionIds: ReadonlySet<string>
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const sessionsRoot = join(codexHome, 'sessions');
    try {
      const entries = await readdir(sessionsRoot, { recursive: true });
      const candidates = entries.filter((entry) => {
        const match = entry.match(/-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i);
        return match !== null && targetSessionIds.has(match[1]);
      });
      const records = await Promise.all(candidates.map(async (entry) => {
        const metadata = parseSessionMetadata(await readFile(join(sessionsRoot, entry), 'utf8'));
        return metadata;
      }));
      const pathsBySession = new Map<string, readonly string[]>();
      for (const metadata of records) {
        if (metadata && targetSessionIds.has(metadata.sessionId)) {
          pathsBySession.set(metadata.sessionId, metadata.workspacePaths);
        }
      }
      return pathsBySession;
    } catch {
      // Session metadata is a convenience for pre-existing conversations. The
      // explicit workspaceState binding remains available if it is absent.
      return new Map();
    }
  }

  private async readArchivedSessionIds(codexHome: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(join(codexHome, 'archived_sessions'), { withFileTypes: true });
      return entries.flatMap((entry): string[] => {
        if (!entry.isFile()) {
          return [];
        }
        const match = entry.name.match(/-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl\.zst$/i);
        return match ? [match[1]] : [];
      });
    } catch {
      // Older Codex installations simply do not have local archived sessions.
      return [];
    }
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type AppServerRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface IndexedSession extends CodexSession {
  readonly updatedAt: number;
}

function parseIndexLine(line: string): IndexedSession | undefined {
  try {
    const row: unknown = JSON.parse(line);
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.thread_name !== 'string') {
      return undefined;
    }
    const updatedAt = Date.parse(typeof row.updated_at === 'string' ? row.updated_at : '');
    if (!Number.isFinite(updatedAt)) {
      return undefined;
    }
    return { sessionId: row.id, title: row.thread_name, updatedAt };
  } catch {
    // The last JSONL line can be incomplete while Codex is writing it.
    return undefined;
  }
}

function parseEpochMilliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function decodeSqliteHex(value: string | undefined): string | undefined {
  if (!value || value.length % 2 !== 0 || !/^[\da-f]+$/i.test(value)) {
    return undefined;
  }
  return Buffer.from(value, 'hex').toString('utf8');
}

function isGuardianReview(title: string): boolean {
  return title.trim().toLocaleLowerCase() === 'guardian review';
}

function parseSessionMetadata(contents: string): { sessionId: string; workspacePaths: readonly string[] } | undefined {
  const firstLine = contents.split(/\r?\n/, 1)[0];
  try {
    const record: unknown = JSON.parse(firstLine);
    if (!isRecord(record) || record.type !== 'session_meta' || !isRecord(record.payload)) {
      return undefined;
    }
    const payload = record.payload;
    const sessionId = typeof payload.id === 'string' ? payload.id : undefined;
    if (!sessionId) {
      return undefined;
    }
    const roots = [
      typeof payload.cwd === 'string' ? payload.cwd : undefined,
      ...(Array.isArray(payload.runtime_workspace_roots)
        ? payload.runtime_workspace_roots.filter((root): root is string => typeof root === 'string')
        : [])
    ].filter((path): path is string => Boolean(path));
    return { sessionId, workspacePaths: [...new Set(roots)] };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseUsage(response: unknown, accountResponse: unknown): CodexUsage {
  const fetchedAt = Date.now();
  const account = isRecord(accountResponse) && isRecord(accountResponse.account) ? accountResponse.account : undefined;
  const accountEmail = account && typeof account.email === 'string' ? account.email : undefined;
  const planType = account && typeof account.planType === 'string' ? account.planType : undefined;
  if (!isRecord(response)) {
    return { windows: [], fetchedAt, usageBlocked: false, accountEmail, planType };
  }

  const rateLimits = isRecord(response.rateLimits) ? response.rateLimits : undefined;
  const byId = isRecord(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : undefined;
  const buckets = byId
    ? Object.entries(byId).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    : rateLimits
      ? [[typeof rateLimits.limitId === 'string' ? rateLimits.limitId : 'codex', rateLimits] as const]
      : [];
  const windows: CodexUsageWindow[] = [];

  for (const [limitId, bucket] of buckets) {
    const limitName = typeof bucket.limitName === 'string' && bucket.limitName.trim()
      ? bucket.limitName
      : limitId;
    for (const [kind, fallback] of [['primary', 'Primary'], ['secondary', 'Secondary']] as const) {
      const window = bucket[kind];
      if (!isRecord(window)) {
        continue;
      }
      const used = window.usedPercent;
      const remainingPercent = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100
        ? Math.floor((100 - used) * 10) / 10
        : undefined;
      const duration = typeof window.windowDurationMins === 'number' && window.windowDurationMins > 0
        ? formatDuration(window.windowDurationMins)
        : fallback;
      const resetSeconds = window.resetsAt;
      const resetsAt = typeof resetSeconds === 'number' && Number.isFinite(resetSeconds) && resetSeconds > 0
        ? resetSeconds * 1000
        : undefined;
      windows.push({
        id: `${limitId}:${kind}`,
        label: `${limitName} · ${duration}`,
        remainingPercent,
        resetsAt
      });
    }
  }

  return {
    windows,
    fetchedAt,
    usageBlocked: response.ordinaryUsageAllowed === false,
    accountEmail,
    planType
  };
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}
import { randomUUID } from 'node:crypto';
