const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Uri {
  static from(value) { return new Uri(value.path, value.fragment); }
  constructor(path, fragment = '') {
    this.scheme = 'openai-codex'; this.authority = 'route';
    this.path = path; this.query = ''; this.fragment = fragment;
  }
  toString() { return `openai-codex://route${this.path}${this.fragment ? `#${this.fragment}` : ''}`; }
  with(change) { return new Uri(this.path, change.fragment ?? this.fragment); }
}
class TabInputCustom {
  constructor(uri) { this.uri = uri; this.viewType = 'chatgpt.conversationEditor'; }
}
const tabFor = (uri) => ({ input: new TabInputCustom(uri) });
const groupFor = (viewColumn, tabs) => ({ viewColumn, tabs, activeTab: tabs[0] });

function setup(resource, layout = 'mixed') {
  const original = tabFor(resource);
  const file = { input: { uri: { toString: () => 'file:///PR.md' } } };
  const group = groupFor(layout === 'split' ? 2 : 1, layout === 'mixed' ? [file, original] : [original]);
  group.activeTab = original;
  const groups = layout === 'split' ? [groupFor(1, [file]), group] : [group];
  const operations = [];
  let refuseOriginal = false;
  let failOpen = false;
  const tabListeners = [];
  const groupListeners = [];
  const event = (listeners) => (callback) => {
    listeners.push(callback); return { dispose() {} };
  };
  const tabGroups = {
    all: groups, activeTabGroup: group,
    onDidChangeTabs: event(tabListeners), onDidChangeTabGroups: event(groupListeners),
    close: async (tabs) => {
      operations.push({ type: 'close', tabs: [...tabs] });
      if (refuseOriginal && tabs.includes(original)) { return false; }
      for (const tab of tabs) {
        const owner = groups.find((candidate) => candidate.tabs.includes(tab));
        if (!owner) { continue; }
        owner.tabs.splice(owner.tabs.indexOf(tab), 1);
        owner.activeTab = owner.tabs[0];
        // Model VS Code's default closeEmptyGroups behavior. A replacement must
        // already exist when the original tab was this group's last editor.
        if (owner.tabs.length === 0 && groups.length > 1) {
          groups.splice(groups.indexOf(owner), 1);
          tabGroups.activeTabGroup = groups[0];
        }
      }
      for (const listener of tabListeners) { listener({ opened: [], closed: tabs }); }
      return true;
    }
  };
  const vscode = {
    Uri, TabInputCustom, l10n: { t: (value) => value },
    extensions: { getExtension: () => ({ activate: async () => undefined }) },
    workspace: {
      getConfiguration: () => ({ get: () => 'off' }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: { tabGroups },
    commands: { executeCommand: async (command, uri, viewType, options) => {
      assert.equal(command, 'vscode.openWith');
      if (failOpen) { throw new Error('editor open failed'); }
      operations.push({ type: 'open', uri, options, originalPresent: groups.some((g) => g.tabs.includes(original)) });
      let target = groups.find((candidate) => candidate.viewColumn === options.viewColumn);
      if (!target) {
        // Match native columnToEditorGroup: stale columns create a new group.
        target = groupFor(options.viewColumn, []); groups.push(target);
      }
      let tab = target.tabs.find((candidate) => candidate.input instanceof TabInputCustom
        && candidate.input.uri.toString() === uri.toString());
      if (!tab) { tab = tabFor(uri); target.tabs.push(tab); }
      target.activeTab = tab; tabGroups.activeTabGroup = target;
      for (const listener of tabListeners) { listener({ opened: [tab], closed: [] }); }
    } }
  };
  const cache = {};
  function load(name) {
    if (cache[name]) { return cache[name]; }
    const exports = {}; cache[name] = exports;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../out/${name}.js`), 'utf8'), {
      exports,
      require: (dependency) => dependency === 'vscode' ? vscode
        : dependency.startsWith('./') ? load(dependency.slice(2)) : require(dependency)
    });
    return exports;
  }
  return {
    client: new (load('codexCompanionClient').CodexSessionClient)(),
    group, groups, original, file, operations, tabGroups,
    refuseClose: () => { refuseOriginal = true; },
    failOpen: () => { failOpen = true; }
  };
}

for (const layout of ['mixed', 'single', 'split']) {
  test(`reload preserves the ${layout} layout by opening before closing`, async () => {
    const resource = new Uri('/local/saved');
    const state = setup(resource, layout);
    const count = state.groups.length;
    await state.client.reloadSessionTab();
    const first = state.operations[0];
    assert.equal(first.type, 'open');
    assert.equal(first.originalPresent, true);
    assert.equal(first.options.viewColumn, state.group.viewColumn);
    assert.equal(first.uri.path, resource.path);
    assert.notEqual(first.uri.toString(), resource.toString(), 'must not reuse a failed custom document');
    assert.equal(state.operations[1].type, 'close');
    assert.equal(state.groups.length, count);
    assert.equal(state.group.tabs.includes(state.original), false);
    assert.equal(state.group.tabs.filter((tab) => tab.input instanceof TabInputCustom).length, 1);
    if (layout === 'mixed') { assert.equal(state.group.tabs.includes(state.file), true); }
  });
}

test('a draft reload keeps its route and gives the editor a fresh identity', async () => {
  const resource = new Uri('/extension/panel/new', 'draft-identity');
  const state = setup(resource);
  await state.client.reloadSessionTab(resource);
  assert.equal(state.operations[0].uri.path, resource.path);
  assert.notEqual(state.operations[0].uri.fragment, resource.fragment);
});

test('a refused close rolls back only the replacement and retains the original', async () => {
  const state = setup(new Uri('/local/saved'));
  state.refuseClose();
  await state.client.reloadSessionTab();
  assert.equal(state.group.tabs.includes(state.original), true);
  assert.equal(state.group.tabs.includes(state.file), true);
  assert.equal(state.group.tabs.length, 2);
  assert.equal(state.groups.length, 1);
});

test('rapid reload clicks do not resurrect an already replaced URI', async () => {
  const resource = new Uri('/local/saved');
  const state = setup(resource);
  await Promise.all([state.client.reloadSessionTab(resource), state.client.reloadSessionTab(resource)]);
  assert.equal(state.operations.filter((op) => op.type === 'open').length, 1);
  assert.equal(state.group.tabs.length, 2);
});

test('history reuses the replacement tab and retains its group', async () => {
  const resource = new Uri('/local/saved');
  const state = setup(resource, 'split');
  await state.client.reloadSessionTab(resource);
  state.tabGroups.activeTabGroup = state.groups[0];
  await state.client.openSession({ sessionId: 'saved', title: 'Saved' });
  assert.equal(state.group.tabs.length, 1);
  assert.equal(state.groups.length, 2);
  assert.equal(state.tabGroups.activeTabGroup, state.group);
});

test('reload rejects unsupported routes before changing any tab', async () => {
  const state = setup(new Uri('/unsupported'));
  await assert.rejects(() => state.client.reloadSessionTab(), /Select an open Codex/);
  assert.equal(state.operations.length, 0);
});

test('a failed replacement open leaves the original chat and layout intact', async () => {
  const state = setup(new Uri('/local/saved'));
  state.failOpen();
  await assert.rejects(() => state.client.reloadSessionTab(), /editor open failed/);
  assert.equal(state.group.tabs.includes(state.original), true);
  assert.equal(state.group.tabs.includes(state.file), true);
  assert.equal(state.groups.length, 1);
  assert.equal(state.operations.filter((op) => op.type === 'close').length, 0);
});
