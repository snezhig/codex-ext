import * as vscode from 'vscode';
import { CodexSessionClient } from './codexCompanionClient';
import { DraftSessionTracker } from './draftSessionTracker';
import { SessionManagerAction, SessionControlsWebviewProvider } from './sessionControlsWebviewProvider';
import { WorkspaceBindingStore } from './workspaceBindingStore';
import { editorGroupForResource } from './conversationEditorGroups';

const CONFIGURATION_SECTION = 'codexWorkspaceSessions';
const SHOW_ALL_SETTING = 'showAllSessions';

export function activate(context: vscode.ExtensionContext): void {
  const bindings = new WorkspaceBindingStore(context.workspaceState);
  const sessions = new CodexSessionClient();
  const getShowAll = (): boolean => vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get<boolean>(SHOW_ALL_SETTING, false);
  const manager = new SessionControlsWebviewProvider(getShowAll(), bindings);

  const updateContexts = async (): Promise<void> => {
    await vscode.commands.executeCommand('setContext', 'codexWorkspaceSessions.showAll', getShowAll());
    await vscode.commands.executeCommand('setContext', 'codexWorkspaceSessions.hasSearch', Boolean(manager.getQuery()));
  };

  const refresh = async (): Promise<void> => {
    const [sessionResult, usageResult] = await Promise.allSettled([sessions.listSessions(), sessions.readUsage()]);
    if (sessionResult.status === 'fulfilled') { manager.setSessions(sessionResult.value); } else { manager.setError(sessionResult.reason); }
    if (usageResult.status === 'fulfilled') { manager.setUsage(usageResult.value); } else { manager.setUsageError(usageResult.reason); }
  };

  const drafts = new DraftSessionTracker({
    listSessions: () => sessions.listSessions(),
    openDraft: (group) => sessions.createSession(group),
    currentWorkspaceHash: () => bindings.getCurrentWorkspaceHash(),
    currentWorkspacePaths: () => bindings.getCurrentWorkspacePaths(),
    onSessionConfirmed: (session, workspaceHash) => {
      // A workspace can change while a blank official editor is open. Do not
      // write a binding into a different workspace's state in that case.
      if (bindings.getCurrentWorkspaceHash() !== workspaceHash) {
        return Promise.resolve();
      }
      return bindings.bindToCurrentWorkspace(session.sessionId).then(() => undefined);
    },
    onSessionsChanged: (sessionList) => manager.setSessions(sessionList)
  });

  const setShowAll = async (showAll: boolean): Promise<void> => {
    const target = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration(CONFIGURATION_SECTION).update(SHOW_ALL_SETTING, showAll, target);
    manager.setShowAll(showAll);
    await updateContexts();
  };

  const sessionFor = (sessionId: string) => manager.findSession(sessionId);
  const openSession = async (sessionId: string): Promise<void> => {
    const session = sessionFor(sessionId);
    if (!session) { return; }
    await sessions.openSession(session);
    await bindings.bindToCurrentWorkspace(session.sessionId);
    manager.refresh();
  };
  const renameSession = async (sessionId: string): Promise<void> => {
    const session = sessionFor(sessionId);
    if (session) { await sessions.renameSession(session); await refresh(); }
  };
  const archiveSession = async (sessionId: string): Promise<void> => {
    const session = sessionFor(sessionId);
    if (session) { await sessions.archiveSession(session); await refresh(); }
  };
  const restoreSession = async (sessionId: string): Promise<void> => {
    const session = sessionFor(sessionId);
    if (session?.archived) { await sessions.restoreArchivedSession(session); await refresh(); }
  };
  const moveToGroup = async (sessionId: string): Promise<void> => {
    const session = sessionFor(sessionId);
    if (!session || session.archived) { return; }
    const createLabel = vscode.l10n.t('Create new group…');
    const selected = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Ungrouped'), group: undefined },
      ...bindings.getGroupNames().map((group) => ({ label: group, group })),
      { label: createLabel, group: undefined, create: true }
    ], { title: vscode.l10n.t('Move session to group') });
    if (!selected) { return; }
    const group = 'create' in selected && selected.create ? await promptForGroupName(vscode.l10n.t('Create session group')) : selected.group;
    if (group === undefined && selected.label === createLabel) { return; }
    await bindings.assignGroup(session.sessionId, group);
    manager.refresh();
  };
  const createGroup = async (): Promise<void> => {
    const name = await promptForGroupName(vscode.l10n.t('Create session group'));
    if (name) { await bindings.createGroup(name); manager.refresh(); }
  };
  const renameGroup = async (groupName: string): Promise<void> => {
    const name = await promptForGroupName(vscode.l10n.t('Rename session group'), groupName);
    if (name && name !== groupName) { await bindings.renameGroup(groupName, name); manager.refresh(); }
  };
  const deleteGroup = async (groupName: string): Promise<void> => {
    const remove = vscode.l10n.t('Remove group');
    const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t('Remove group "{0}"? Sessions will become ungrouped.', groupName), { modal: true }, remove);
    if (confirmed === remove) { await bindings.removeGroup(groupName); manager.refresh(); }
  };
  const dropSession = async (sessionId: string, target: 'active' | 'archived', groupName?: string): Promise<void> => {
    const session = sessionFor(sessionId);
    if (!session) { return; }
    if (target === 'archived') {
      if (!session.archived) { await sessions.archiveSession(session); await refresh(); }
      return;
    }
    if (session.archived) { await sessions.restoreArchivedSession(session); }
    await bindings.assignGroup(sessionId, groupName);
    await refresh();
  };
  const handleAction = async (action: SessionManagerAction): Promise<void> => {
    switch (action.command) {
      case 'scope': return setShowAll(action.showAll);
      case 'search': manager.setQuery(action.query); return updateContexts();
      case 'newSession': return drafts.createDraft();
      case 'refresh': return refresh();
      case 'createGroup': return createGroup();
      case 'open': return openSession(action.sessionId);
      case 'rename': return renameSession(action.sessionId);
      case 'archive': return archiveSession(action.sessionId);
      case 'restore': return restoreSession(action.sessionId);
      case 'moveToGroup': return moveToGroup(action.sessionId);
      case 'drop': return dropSession(action.sessionId, action.target, action.groupName);
      case 'renameGroup': return renameGroup(action.groupName);
      case 'deleteGroup': return deleteGroup(action.groupName);
    }
  };

  /**
   * Webview messages have no caller awaiting their promise.  Surface failures
   * here so a missing/starting official Codex extension never appears as a
   * non-responsive control.
   */
  const runAction = (action: SessionManagerAction): void => {
    void handleAction(action).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(vscode.l10n.t('Codex Ext: {0}', detail));
    });
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexWorkspaceSessions.controls', manager),
    manager.onDidRequestAction(runAction),
    sessions,
    drafts,
    vscode.commands.registerCommand('codexWorkspaceSessions.focus', () => vscode.commands.executeCommand('codexWorkspaceSessions.controls.focus')),
    vscode.commands.registerCommand('codexWorkspaceSessions.toggleSessionScope', () => setShowAll(!getShowAll())),
    vscode.commands.registerCommand('codexWorkspaceSessions.showAllSessions', () => setShowAll(true)),
    vscode.commands.registerCommand('codexWorkspaceSessions.showWorkspaceSessions', () => setShowAll(false)),
    vscode.commands.registerCommand('codexWorkspaceSessions.refreshSessions', refresh),
    vscode.commands.registerCommand('codexWorkspaceSessions.reloadCurrentTab', (resource?: vscode.Uri) => sessions.reloadSessionTab(resource)),
    ...['codexWorkspaceSessions.newSession', 'codexWorkspaceSessions.newSessionInGroup'].map((command) => vscode.commands.registerCommand(command, async (resource?: vscode.Uri) => {
      try {
        await drafts.createDraft(editorGroupForResource(resource));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(vscode.l10n.t('Codex Ext: {0}', detail));
      }
    })),
    vscode.commands.registerCommand('codexWorkspaceSessions.searchSessions', async () => {
      const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Search Codex Ext'), prompt: vscode.l10n.t('Filter session titles. Leave empty to clear the filter.'), value: manager.getQuery() });
      if (value !== undefined) { manager.setQuery(value); await updateContexts(); }
    }),
    vscode.commands.registerCommand('codexWorkspaceSessions.clearSearch', async () => { manager.setQuery(''); await updateContexts(); }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(`${CONFIGURATION_SECTION}.${SHOW_ALL_SETTING}`)) { manager.setShowAll(getShowAll()); await updateContexts(); }
      if (event.affectsConfiguration(`${CONFIGURATION_SECTION}.codexHome`)) { await refresh(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => { manager.refresh(); await updateContexts(); })
  );
  updateContexts().then(refresh, (error) => manager.setError(error));
}

async function promptForGroupName(title: string, value = ''): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({ title, value, prompt: vscode.l10n.t('Enter a group name.'), validateInput: (candidate) => candidate.trim() ? undefined : vscode.l10n.t('Enter a group name.') });
  return input?.trim() || undefined;
}

export function deactivate(): void {}
