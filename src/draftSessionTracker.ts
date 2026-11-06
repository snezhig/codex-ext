import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { CodexSession } from './types';

const POLL_INTERVAL_MS = 1_500;
const DRAFT_EXPIRY_MS = 5 * 60_000;
const TIMESTAMP_TOLERANCE_MS = 10_000;

interface PendingDraft {
  readonly openedAt: number;
  readonly workspaceHash?: string;
  readonly workspacePaths: ReadonlySet<string>;
  readonly knownSessionIds: ReadonlySet<string>;
}

export interface DraftSessionTrackerOptions {
  readonly listSessions: () => Promise<readonly CodexSession[]>;
  readonly openDraft: (group: vscode.TabGroup) => Promise<void>;
  readonly currentWorkspaceHash: () => string | undefined;
  readonly currentWorkspacePaths: () => readonly string[];
  readonly onSessionConfirmed: (session: CodexSession, workspaceHash: string) => Promise<void>;
  readonly onSessionsChanged: (sessions: readonly CodexSession[]) => void;
}

/**
 * Tracks only locally-opened, still-empty official Codex editors.  A draft is
 * not a Codex thread.  Once the user sends their first message, Codex writes a
 * new thread to its local index; then we can safely bind that real id to the
 * workspace that opened the draft.  If the editor is closed without a message,
 * no thread is created and this small in-memory record simply expires.
 */
export class DraftSessionTracker implements vscode.Disposable {
  private readonly drafts: PendingDraft[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  public constructor(private readonly options: DraftSessionTrackerOptions) {}

  public async createDraft(group = vscode.window.tabGroups.activeTabGroup): Promise<void> {
    // Capture the invoking editor group before reading session history. Both
    // sidebar and editor-title actions must keep their original destination.
    // Capture the snapshot before opening the official editor. A thread that
    // appears after this point is eligible only if it also belongs to this
    // exact workspace, so unrelated existing conversations are never claimed.
    const existing = await this.options.listSessions();
    const draft: PendingDraft = {
      openedAt: Date.now(),
      workspaceHash: this.options.currentWorkspaceHash(),
      workspacePaths: new Set(this.options.currentWorkspacePaths().map((path) => resolve(path))),
      knownSessionIds: new Set(existing.map((session) => session.sessionId))
    };
    this.drafts.push(draft);
    this.ensurePolling();

    try {
      await this.options.openDraft(group);
    } catch (error) {
      const index = this.drafts.indexOf(draft);
      if (index >= 0) {
        this.drafts.splice(index, 1);
      }
      this.stopPollingIfIdle();
      throw error;
    }
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.drafts.length = 0;
  }

  private ensurePolling(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    void this.poll();
  }

  private stopPollingIfIdle(): void {
    if (this.drafts.length !== 0 || !this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.drafts.length === 0) {
      this.stopPollingIfIdle();
      return;
    }
    this.polling = true;
    try {
      const sessions = await this.options.listSessions();
      const now = Date.now();
      const claimed = new Set<string>();

      for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
        if (now - this.drafts[index].openedAt > DRAFT_EXPIRY_MS) {
          this.drafts.splice(index, 1);
        }
      }

      // Oldest draft gets the first matching newly-created thread. This keeps
      // simultaneous drafts in the same workspace deterministic.
      for (const draft of [...this.drafts].sort((left, right) => left.openedAt - right.openedAt)) {
        const session = sessions.find((candidate) => this.matchesDraft(candidate, draft, claimed));
        if (!session || !draft.workspaceHash || this.options.currentWorkspaceHash() !== draft.workspaceHash) {
          continue;
        }
        await this.options.onSessionConfirmed(session, draft.workspaceHash);
        claimed.add(session.sessionId);
        this.drafts.splice(this.drafts.indexOf(draft), 1);
      }

      if (claimed.size > 0) {
        this.options.onSessionsChanged(sessions);
      }
    } catch {
      // Codex may update its SQLite file while it is being read. The next
      // short-lived poll will retry; never surface noisy errors for a draft.
    } finally {
      this.polling = false;
      this.stopPollingIfIdle();
    }
  }

  private matchesDraft(session: CodexSession, draft: PendingDraft, claimed: ReadonlySet<string>): boolean {
    if (draft.knownSessionIds.has(session.sessionId) || claimed.has(session.sessionId)) {
      return false;
    }
    if (session.updatedAt !== undefined && session.updatedAt < draft.openedAt - TIMESTAMP_TOLERANCE_MS) {
      return false;
    }
    return session.workspacePaths?.some((path) => draft.workspacePaths.has(resolve(path))) === true;
  }
}
