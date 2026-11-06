const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('a draft keeps its invoking group while session history loads', async () => {
  const original = { viewColumn: 2 };
  const tabGroups = { activeTabGroup: original };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/draftSessionTracker.js'), 'utf8'), {
    exports,
    require: (name) => name === 'vscode' ? { window: { tabGroups } } : require(name),
    setInterval: () => ({}),
    clearInterval: () => undefined
  });
  let resolveHistory;
  const history = new Promise((resolve) => { resolveHistory = resolve; });
  let reads = 0;
  let openedIn;
  const tracker = new exports.DraftSessionTracker({
    listSessions: () => ++reads === 1 ? history : Promise.resolve([]),
    openDraft: async (group) => { openedIn = group; },
    currentWorkspaceHash: () => 'workspace',
    currentWorkspacePaths: () => ['/project'],
    onSessionConfirmed: async () => undefined,
    onSessionsChanged: () => undefined
  });
  try {
    const opening = tracker.createDraft();
    tabGroups.activeTabGroup = { viewColumn: 1 };
    resolveHistory([]);
    await opening;
    assert.equal(openedIn, original);
  } finally {
    tracker.dispose();
  }
});
