import * as vscode from 'vscode';

const EDITOR_TYPE = 'chatgpt.conversationEditor';

/** Opens chats in the requested group and applies the optional group lock. */
export class ConversationEditorGroups implements vscode.Disposable {
  private opening: Promise<void> = Promise.resolve();
  private lockUpdates: Promise<void> = Promise.resolve();
  private readonly managedGroups = new Set<vscode.TabGroup>();
  private disposed = false;
  private lastActiveGroup = vscode.window.tabGroups.activeTabGroup;
  private readonly subscriptions = [
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      const active = vscode.window.tabGroups.activeTabGroup;
      // Locking itself emits a group change; react only to focus changes.
      if (active !== this.lastActiveGroup) {
        this.lastActiveGroup = active;
        this.applyLockInBackground();
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (event.opened.length > 0 || event.closed.length > 0) {
        this.applyLockInBackground();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexWorkspaceSessions.chatGroupLocking')) {
        this.applyLockInBackground();
      }
    })
  ];

  public initialize(): void {
    this.applyLockInBackground();
  }

  public dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  public open(uri: vscode.Uri, preferredGroup?: vscode.TabGroup): Promise<void> {
    return this.queueOpen(uri, preferredGroup, true);
  }

  /** Opens a replacement document while the original still anchors its group. */
  public openFresh(uri: vscode.Uri, group: vscode.TabGroup): Promise<void> {
    return this.queueOpen(uri, group, false);
  }

  private queueOpen(uri: vscode.Uri, preferredGroup: vscode.TabGroup | undefined, reuseExisting: boolean): Promise<void> {
    const requestedGroup = preferredGroup ?? vscode.window.tabGroups.activeTabGroup;
    // Keep rapid requests ordered without changing their original destination.
    const result = this.opening.then(() => this.openInGroup(uri, requestedGroup, reuseExisting));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openInGroup(uri: vscode.Uri, preferredGroup: vscode.TabGroup, reuseExisting: boolean): Promise<void> {
    const groups = vscode.window.tabGroups.all;
    const active = vscode.window.tabGroups.activeTabGroup;
    // Find the tab before choosing a destination. In particular, dragging a
    // conversation to another split must not be undone by a sidebar click.
    const existing = reuseExisting ? [active, ...groups.filter((group) => group !== active)]
      .find((group) => group.tabs.some((tab) => matchesConversation(tab, uri)))
      : undefined;
    const existingTab = existing?.tabs.find((tab) => matchesConversation(tab, uri));
    const resource = existingTab?.input instanceof vscode.TabInputCustom ? existingTab.input.uri : uri;
    const target = existing
      ?? (preferredGroup && groups.includes(preferredGroup) ? preferredGroup : active);

    await vscode.commands.executeCommand('vscode.openWith', resource, EDITOR_TYPE, {
      viewColumn: target.viewColumn,
      preview: false,
      preserveFocus: false
    });

    // Opening is asynchronous. Do not lock an unrelated group if focus changed.
    const opened = vscode.window.tabGroups.activeTabGroup;
    if (!matchesConversation(opened.activeTab, resource)) {
      return;
    }
    await this.synchronizeLocks();
  }

  private applyLockInBackground(): void {
    // A group may close while VS Code handles an event. Opening a conversation
    // still awaits the lock and surfaces errors to its command caller.
    void this.synchronizeLocks().catch(() => undefined);
  }

  private synchronizeLocks(): Promise<void> {
    const result = this.lockUpdates.then(() => this.updateGroupLocks());
    this.lockUpdates = result.catch(() => undefined);
    return result;
  }

  private async updateGroupLocks(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const mode = vscode.workspace.getConfiguration('codexWorkspaceSessions')
      .get<'off' | 'chatOnly' | 'containsChat'>('chatGroupLocking', 'chatOnly');
    const matchesPolicy = (group: vscode.TabGroup): boolean => {
      const hasChat = group.tabs.some(isConversation);
      return mode === 'containsChat' ? hasChat
        : mode === 'chatOnly' && hasChat && group.tabs.every(isConversation);
    };

    // A tab can move out of an inactive group. Release that group's automatic
    // lock before routing another file; checking only the active group leaves
    // code-only groups locked and makes VS Code create unnecessary splits.
    for (const group of this.managedGroups) {
      if (!vscode.window.tabGroups.all.includes(group)) {
        this.managedGroups.delete(group);
      } else if (!matchesPolicy(group) && await this.setGroupLock(group, false)) {
        this.managedGroups.delete(group);
      }
    }

    for (const group of vscode.window.tabGroups.all) {
      if (!this.disposed && matchesPolicy(group) && !this.managedGroups.has(group)
        && await this.setGroupLock(group, true)) {
        this.managedGroups.add(group);
      }
    }
  }

  private async setGroupLock(group: vscode.TabGroup, locked: boolean): Promise<boolean> {
    const groups = vscode.window.tabGroups.all;
    if (this.disposed || !groups.includes(group)) {
      return false;
    }
    const command = locked ? 'workbench.action.lockEditorGroup' : 'workbench.action.unlockEditorGroup';
    // Native lock commands accept a resource to address an inactive group.
    // Only use a URI belonging to this group alone, otherwise the command may
    // affect a different split showing the same file. Never steal focus.
    const resource = group.tabs.map(tabResource).find((candidate) => candidate !== undefined
      && !groups.some((other) => other !== group && other.tabs.some((tab) =>
        tabResource(tab)?.toString() === candidate.toString())));
    if (resource) {
      await vscode.commands.executeCommand(command, resource);
      return true;
    }
    // With no unambiguous resource, do not use an untargeted command: focus can
    // move before the main thread runs it and lock/unlock an unrelated group.
    // Retry after the tab contents change and a unique resource is available.
    return false;
  }
}

function tabResource(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const resource = 'uri' in input ? input.uri : 'modified' in input ? input.modified : undefined;
  return resource instanceof vscode.Uri ? resource : undefined;
}

/** Editor-title actions may be invoked from an unfocused group's toolbar. */
export function editorGroupForResource(resource?: vscode.Uri): vscode.TabGroup {
  const active = vscode.window.tabGroups.activeTabGroup;
  if (!resource) {
    return active;
  }
  return [active, ...vscode.window.tabGroups.all.filter((group) => group !== active)]
    .find((group) => {
      const input = group.activeTab?.input;
      if (!input || typeof input !== 'object') {
        return false;
      }
      // Text, custom editors and notebooks expose uri; diff tabs expose modified.
      const candidate = 'uri' in input ? input.uri : 'modified' in input ? input.modified : undefined;
      return candidate instanceof vscode.Uri && candidate.toString() === resource.toString();
    }) ?? active;
}

function isConversation(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputCustom && tab.input.viewType === EDITOR_TYPE;
}

function matchesConversation(tab: vscode.Tab | undefined, uri: vscode.Uri): boolean {
  if (tab === undefined || !(tab.input instanceof vscode.TabInputCustom)
    || tab.input.viewType !== EDITOR_TYPE) {
    return false;
  }
  const existing = tab.input.uri;
  // Saved-chat fragments identify editor instances, not conversations. Draft
  // fragments must stay distinct so multiple unsent drafts remain independent.
  if (uri.scheme === 'openai-codex' && uri.path.startsWith('/local/')) {
    return existing.scheme === uri.scheme && existing.authority === uri.authority
      && existing.path === uri.path && existing.query === uri.query;
  }
  return existing.toString() === uri.toString();
}
