import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';

interface UsageWindow {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent?: number;
  readonly resetsAt?: number;
}

interface UsageSnapshot {
  readonly windows: readonly UsageWindow[];
  readonly fetchedAt: number;
  readonly usageBlocked: boolean;
  readonly accountEmail?: string;
  readonly planType?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    'codexExt.localBridge.readUsage',
    () => readUsage()
  ));
}

export function deactivate(): void {}

async function readUsage(): Promise<UsageSnapshot> {
  const [limits, account] = await withAppServer((request) => Promise.all([
    request('account/rateLimits/read', {}),
    request('account/read', {})
  ]));
  return parseUsage(limits, account);
}

async function withAppServer<T>(action: (request: Request) => Promise<T>): Promise<T> {
  const executable = await findLocalCodexExecutable();
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return new Promise<T>((resolve, reject) => {
    const child = spawn(executable, ['app-server'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const output = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    let finished = false;

    const finish = (error?: Error, value?: T): void => {
      if (finished) { return; }
      finished = true;
      output.close();
      child.stdin.end();
      child.kill();
      for (const pendingRequest of pending.values()) {
        clearTimeout(pendingRequest.timeout);
        pendingRequest.reject(error ?? new Error('Codex app server closed.'));
      }
      pending.clear();
      error ? reject(error) : resolve(value as T);
    };
    const send = (message: unknown): void => {
      if (!finished) { child.stdin.write(`${JSON.stringify(message)}\n`); }
    };
    const request: Request = (method, params) => new Promise<unknown>((resolveRequest, rejectRequest) => {
      if (finished) { rejectRequest(new Error('Codex app server is unavailable.')); return; }
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`Codex request timed out: ${method}`));
      }, 20_000);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      send({ id, method, params });
    });

    child.once('error', (error) => finish(error));
    child.once('exit', () => { if (!finished) { finish(new Error('Codex app server exited unexpectedly.')); } });
    child.stdin.once('error', (error) => finish(error));
    child.stderr.resume();
    output.on('line', (line) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!isRecord(message)) { return; }
      if (typeof message.method === 'string') {
        if (typeof message.id === 'number') {
          send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
        }
        return;
      }
      if (typeof message.id !== 'number') { return; }
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) { return; }
      pending.delete(message.id);
      clearTimeout(pendingRequest.timeout);
      if (isRecord(message.error)) {
        pendingRequest.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'Codex request failed.'));
      } else {
        pendingRequest.resolve(message.result);
      }
    });
    void (async () => {
      try {
        await request('initialize', { clientInfo: { name: 'codex-ext-local-bridge', version: '0.1.0' } });
        send({ method: 'initialized', params: {} });
        finish(undefined, await action(request));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

async function findLocalCodexExecutable(): Promise<string> {
  const candidates: string[] = [];
  const officialExtension = vscode.extensions.getExtension('openai.chatgpt');
  if (officialExtension) {
    await officialExtension.activate();
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    candidates.push(join(officialExtension.extensionPath, 'bin', `${platform}-${architecture}`, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Check the next known local Codex installation.
    }
  }
  throw new Error('Unable to find a local Codex executable. Install OpenAI Codex or ChatGPT locally.');
}

function parseUsage(response: unknown, accountResponse: unknown): UsageSnapshot {
  const fetchedAt = Date.now();
  const account = isRecord(accountResponse) && isRecord(accountResponse.account) ? accountResponse.account : undefined;
  const accountEmail = account && typeof account.email === 'string' ? account.email : undefined;
  const planType = account && typeof account.planType === 'string' ? account.planType : undefined;
  if (!isRecord(response)) { return { windows: [], fetchedAt, usageBlocked: false, accountEmail, planType }; }
  const rateLimits = isRecord(response.rateLimits) ? response.rateLimits : undefined;
  const byId = isRecord(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : undefined;
  const buckets = byId
    ? Object.entries(byId).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    : rateLimits ? [[typeof rateLimits.limitId === 'string' ? rateLimits.limitId : 'codex', rateLimits] as const] : [];
  const windows: UsageWindow[] = [];
  for (const [limitId, bucket] of buckets) {
    const limitName = typeof bucket.limitName === 'string' && bucket.limitName.trim() ? bucket.limitName : limitId;
    for (const [kind, fallback] of [['primary', 'Primary'], ['secondary', 'Secondary']] as const) {
      const window = bucket[kind];
      if (!isRecord(window)) { continue; }
      const used = window.usedPercent;
      const remainingPercent = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100
        ? Math.floor((100 - used) * 10) / 10 : undefined;
      const duration = typeof window.windowDurationMins === 'number' && window.windowDurationMins > 0
        ? formatDuration(window.windowDurationMins) : fallback;
      const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0
        ? window.resetsAt * 1000 : undefined;
      windows.push({ id: `${limitId}:${kind}`, label: `${limitName} · ${duration}`, remainingPercent, resetsAt });
    }
  }
  return { windows, fetchedAt, usageBlocked: response.ordinaryUsageAllowed === false, accountEmail, planType };
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) { return `${minutes / 1440}d`; }
  if (minutes % 60 === 0) { return `${minutes / 60}h`; }
  return `${minutes}m`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
