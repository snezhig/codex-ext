const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const editorType = 'chatgpt.conversationEditor';
class Uri {
  constructor(value) {
    this.value = value;
    const parsed = new URL(value);
    this.scheme = parsed.protocol.slice(0, -1);
    this.authority = parsed.host;
    this.path = parsed.pathname;
    this.query = parsed.search.slice(1);
  }
  toString() { return this.value; }
}
const uri = (id) => new Uri(`openai-codex://route/local/${id}`);
class TabInputCustom {
  constructor(uri, viewType = editorType) { this.uri = uri; this.viewType = viewType; }
}
const chat = (id) => ({ input: new TabInputCustom(uri(id)) });
const file = (name = 'code.ts') => ({ input: { uri: new Uri(`file:///${name}`) } });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const group = (viewColumn, tabs) => ({ viewColumn, tabs, activeTab: tabs[0] });

function setup(groups, active, chatGroupLocking = 'chatOnly') {
  const calls = [];
  let listener;
  let disposed = 0;
  let tabsListener;
  let configListener;
  let focusAfterOpen;
  let focusBeforeLock;
  const tabGroups = {
    all: groups,
    activeTabGroup: active,
    onDidChangeTabGroups: (callback) => {
      listener = callback;
      return { dispose: () => { disposed += 1; } };
    },
    onDidChangeTabs: (callback) => { tabsListener = callback; return { dispose: () => { disposed += 1; } }; }
  };
  const vscode = {
    Uri,
    TabInputCustom,
    ViewColumn: { Beside: -2 },
    window: { tabGroups },
    workspace: {
      getConfiguration: () => ({ get: () => chatGroupLocking }),
      onDidChangeConfiguration: (callback) => { configListener = callback; return { dispose: () => { disposed += 1; } }; }
    },
    commands: {
      executeCommand: async (command, resource, viewType, options) => {
        if (command === 'workbench.action.lockEditorGroup' && focusBeforeLock) {
          tabGroups.activeTabGroup = focusBeforeLock;
        }
        const targetGroup = resource instanceof Uri && command !== 'vscode.openWith'
          ? groups.find((candidate) => candidate.tabs.some((tab) =>
            (tab.input.uri ?? tab.input.modified)?.toString() === resource.toString()))
          : tabGroups.activeTabGroup;
        calls.push({ command, resource, viewType, options, group: targetGroup });
        if (command === 'workbench.action.lockEditorGroup' || command === 'workbench.action.unlockEditorGroup') {
          assert.ok(resource instanceof Uri, 'lock commands must never rely on current focus');
          assert.ok(targetGroup, 'the target group must still exist');
          targetGroup.locked = command === 'workbench.action.lockEditorGroup';
          return;
        }
        if (command !== 'vscode.openWith') { return; }
        let target = groups.find((candidate) => candidate.viewColumn === options.viewColumn);
        if (!target) {
          assert.fail('must use an existing group, never force a split or use a stale column');
        }
        let tab = target.tabs.find((candidate) => candidate.input instanceof TabInputCustom
          && candidate.input.uri.toString() === resource.toString());
        if (!tab) {
          tab = { input: new TabInputCustom(resource, viewType) };
          target.tabs.push(tab);
        }
        target.activeTab = tab;
        tabGroups.activeTabGroup = focusAfterOpen ?? target;
      }
    }
  };
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../out/conversationEditorGroups.js'), 'utf8');
  vm.runInNewContext(source, { exports, require: (name) => {
    assert.equal(name, 'vscode');
    return vscode;
  } });
  return {
    router: new exports.ConversationEditorGroups(), calls, tabGroups,
    groupForResource: exports.editorGroupForResource,
    focus: (target) => { tabGroups.activeTabGroup = target; listener(); },
    focusDuringOpen: (target) => { focusAfterOpen = target; },
    focusDuringLock: (target) => { focusBeforeLock = target; },
    disposedCount: () => disposed,
    changeTabs: (event) => tabsListener(event),
    changeMode: (mode) => { chatGroupLocking = mode; configListener({ affectsConfiguration: () => true }); }
  };
}

test('selecting a chat moved to the third group reveals it there', async () => {
  const code = group(1, [file()]);
  const moved = group(3, [chat('saved')]);
  const { router, calls } = setup([code, moved], code);
  await router.open(uri('saved'));
  assert.equal(calls[0].options.viewColumn, 3);
  assert.equal(calls[0].options.preview, false);
  assert.equal(calls[1].command, 'workbench.action.lockEditorGroup');
  assert.equal(calls[1].group, moved);
});

test('unopened chats use the active code group even if another chat group exists', async () => {
  const code = group(2, [file()]);
  const chats = group(1, [chat('other')]);
  const { router, calls, tabGroups } = setup([chats, code], code);
  await router.open(uri('new'));
  assert.equal(calls[0].options.viewColumn, 2);
  assert.equal(calls[0].options.preview, false);
  assert.notEqual(code.locked, true, 'default mode must not lock mixed code/chat groups');
  assert.equal(calls.filter((call) => call.command === 'workbench.action.lockEditorGroup')
    .every((call) => call.group === chats), true);
  assert.equal(tabGroups.all.length, 2);
});

test('independent drafts create tabs in their requested group', async () => {
  const code = group(1, [file()]);
  const requested = group(2, [chat('saved')]);
  const { router, calls } = setup([code, requested], code);
  const draft = (id) => ({ toString: () => `openai-codex://route/extension/panel/new#${id}` });
  await router.open(draft('first'), requested);
  await router.open(draft('second'), requested);
  assert.equal(calls[0].options.viewColumn, 2);
  assert.equal(calls[2].options.viewColumn, 2);
  assert.equal(requested.tabs.length, 3);
});

test('queued requests retain the group active when they were invoked', async () => {
  const left = group(1, [file()]);
  const right = group(2, [file()]);
  const { router, calls, focus } = setup([left, right], left);
  const first = router.open(uri('first'));
  focus(right);
  const second = router.open(uri('second'));
  await Promise.all([first, second]);
  const opens = calls.filter((call) => call.command === 'vscode.openWith');
  assert.equal(opens[0].options.viewColumn, 1);
  assert.equal(opens[1].options.viewColumn, 2);
});

test('closed requested groups fall back to the currently active group', async () => {
  const code = group(1, [file()]);
  const closed = group(2, []);
  const { router, calls } = setup([code], code);
  await router.open(uri('new'), closed);
  assert.equal(calls[0].options.viewColumn, 1);
});

test('chatOnly locks pure chat groups but leaves existing mixed groups unlocked', async () => {
  const code = group(1, [file()]);
  const mixed = group(2, [file(), chat('saved')]);
  const { router, calls } = setup([code, mixed], code);
  await router.open(uri('saved'));
  assert.equal(calls[0].options.viewColumn, 2);
  assert.equal(calls.length, 1);
});

test('containsChat locks mixed groups without moving chats or code', async () => {
  const code = group(1, [file()]);
  const mixed = group(2, [file(), chat('saved')]);
  const { router, calls } = setup([code, mixed], code, 'containsChat');
  await router.open(uri('saved'));
  assert.equal(calls[0].options.viewColumn, 2);
  assert.equal(calls[1].command, 'workbench.action.lockEditorGroup');
  assert.equal(calls[1].group, mixed);
  assert.equal(mixed.tabs.length, 2);
});

test('off never locks or unlocks a chat group', async () => {
  const code = group(1, [file()]);
  const chats = group(2, [chat('saved')]);
  const { router, calls, focus } = setup([code, chats], code, 'off');
  focus(chats);
  await router.open(uri('new'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.viewColumn, 2);
});

test('a single chat group locks without forcing a split until a file opens', async () => {
  const only = group(1, []);
  const { router, calls, tabGroups } = setup([only], only);
  await router.open(uri('new'));
  assert.equal(calls[0].options.viewColumn, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'workbench.action.lockEditorGroup');
  assert.equal(tabGroups.all.length, 1);
});

test('the editor title action targets an unfocused group by its resource', () => {
  const code = group(1, [file()]);
  const chats = group(2, [chat('saved')]);
  const { groupForResource } = setup([code, chats], code);
  assert.equal(groupForResource(uri('saved')), chats);
  assert.equal(groupForResource(undefined), code);
  assert.equal(groupForResource(uri('missing')), code);
});

test('a focus change during opening cannot lock an unrelated code group', async () => {
  const code = group(1, [file()]);
  const chats = group(2, [chat('saved')]);
  const { router, calls, focusDuringOpen } = setup([code, chats], chats);
  focusDuringOpen(code);
  await router.open(uri('new'));
  assert.equal(calls.length, 1);
});

test('reload reuses a surviving group and avoids a closed group column', async () => {
  const code = group(1, [file()]);
  const survivor = group(2, []);
  const { router, calls, tabGroups } = setup([code, survivor], code);
  await router.open(uri('reload'), survivor);
  assert.equal(calls[0].options.viewColumn, 2);
  tabGroups.all.pop();
  tabGroups.activeTabGroup = code;
  await router.open(uri('reload'), survivor);
  assert.equal(calls[2].options.viewColumn, 1);
});

test('focus and tab changes apply a lock once without continually relocking', async () => {
  const code = group(1, [file()]);
  const chats = group(2, [chat('saved')]);
  const { calls, focus, changeTabs } = setup([code, chats], code);
  focus(chats);
  await settle();
  assert.equal(calls.length, 1);
  focus(chats);
  changeTabs({ opened: [], closed: [file()] });
  await settle();
  assert.equal(calls.length, 1);
});

test('off releases locks managed by this extension', async () => {
  const code = group(1, [file()]);
  const mixed = group(2, [file(), chat('saved')]);
  const { calls, changeMode } = setup([code, mixed], mixed);
  changeMode('containsChat');
  await settle();
  assert.equal(mixed.locked, true);
  changeMode('off');
  await settle();
  assert.equal(mixed.locked, false);
  assert.equal(calls[1].command, 'workbench.action.unlockEditorGroup');
});

test('disposing releases all VS Code event subscriptions', () => {
  const code = group(1, [file()]);
  const { router, disposedCount } = setup([code], code);
  router.dispose();
  assert.equal(disposedCount(), 3);
});

test('an inactive source group unlocks when its last chat moves elsewhere', async () => {
  const moved = chat('saved');
  const source = group(1, [file('PR.md'), moved]);
  const destination = group(2, [chat('other')]);
  const { router, calls, tabGroups, changeTabs } = setup([source, destination], source, 'containsChat');
  await router.open(uri('saved'));
  assert.equal(source.locked, true);
  source.tabs.splice(1, 1);
  source.activeTab = source.tabs[0];
  destination.tabs.push(moved);
  tabGroups.activeTabGroup = destination;
  changeTabs({ opened: [moved], closed: [moved] });
  await settle();
  assert.equal(source.locked, false);
  const unlock = calls.find((call) => call.command === 'workbench.action.unlockEditorGroup');
  assert.equal(unlock.resource.toString(), 'file:///PR.md');
  assert.equal(unlock.group, source);
  assert.equal(tabGroups.activeTabGroup, destination, 'releasing a stale lock must not steal focus');
});

test('chatOnly releases a managed group after a code tab is moved into it', async () => {
  const chats = group(1, [chat('saved')]);
  const code = group(2, [file('code.ts')]);
  const { router, changeTabs } = setup([chats, code], chats);
  await router.open(uri('saved'));
  assert.equal(chats.locked, true);
  const added = file('README.md');
  chats.tabs.push(added);
  changeTabs({ opened: [added], closed: [] });
  await settle();
  assert.equal(chats.locked, false);
});

test('a focus change during the lock command cannot lock a code-only group', async () => {
  const chats = group(1, [chat('saved')]);
  const code = group(2, [file('README.md')]);
  const { router, focusDuringLock } = setup([chats, code], chats);
  focusDuringLock(code);
  await router.open(uri('saved'));
  assert.equal(chats.locked, true);
  assert.notEqual(code.locked, true);
});

test('unrelated manual code-group locks are never released', async () => {
  const chats = group(1, [chat('saved')]);
  const manual = group(2, [file('manual.ts')]);
  manual.locked = true;
  const { router, calls, changeMode } = setup([chats, manual], chats);
  await router.open(uri('saved'));
  changeMode('off');
  await settle();
  assert.equal(manual.locked, true);
  assert.equal(calls.filter((call) => call.command === 'workbench.action.unlockEditorGroup').length, 1);
  assert.equal(chats.locked, false);
});

test('duplicate resources do not cause an untargeted lock on another group', async () => {
  const first = group(1, [chat('saved')]);
  const second = group(2, [chat('saved')]);
  const { router, calls } = setup([first, second], first);
  await router.open(uri('saved'));
  assert.equal(calls.length, 1);
});

test('closing a managed group drops its ownership without unlocking another group', async () => {
  const chats = group(1, [chat('saved')]);
  const code = group(2, [file()]);
  const { router, calls, tabGroups, changeTabs } = setup([chats, code], chats);
  await router.open(uri('saved'));
  tabGroups.all.shift();
  tabGroups.activeTabGroup = code;
  changeTabs({ opened: [], closed: chats.tabs });
  await settle();
  assert.equal(calls.filter((call) => call.command === 'workbench.action.unlockEditorGroup').length, 0);
  assert.notEqual(code.locked, true);
});

test('activation manages restored chat groups even while another group is active', async () => {
  const restored = group(1, [chat('saved')]);
  restored.locked = true;
  const code = group(2, [file()]);
  const { router, changeTabs } = setup([restored, code], code);
  router.initialize();
  await settle();
  const removed = restored.tabs[0];
  restored.tabs = [file('PR.md')];
  restored.activeTab = restored.tabs[0];
  changeTabs({ opened: restored.tabs, closed: [removed] });
  await settle();
  assert.equal(restored.locked, false);
  assert.notEqual(code.locked, true);
});

test('history reveals a refreshed saved-chat URI rather than opening a duplicate', async () => {
  const refreshed = new Uri('openai-codex://route/local/saved#codex-ext-reload-example');
  const code = group(1, [file()]);
  const chats = group(2, [{ input: new TabInputCustom(refreshed) }]);
  const { router, calls } = setup([code, chats], code, 'off');
  await router.open(uri('saved'));
  assert.equal(calls[0].options.viewColumn, 2);
  assert.equal(calls[0].resource, refreshed);
  assert.equal(chats.tabs.length, 1);
});
