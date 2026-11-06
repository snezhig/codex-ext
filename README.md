# Codex Ext

`Codex Ext` is a workspace-aware session manager for the official OpenAI Codex
VS Code extension. It adds a dedicated **Codex Ext** icon to the left Activity
Bar and keeps your Codex conversations organized without replacing the
official Codex editor.

[中文说明](#中文说明) · [Report an issue](https://github.com/wzrzt/codex-ext/issues)

## Highlights

- **Workspace-aware sessions** — switch between the current workspace and all
  sessions on the current workspace host. The selected scope also applies to
  archived sessions.
- **Account & Usage** — show the signed-in account, plan, available Codex
  allowance windows, and their reset times.
- **Practical session management** — search, rename, group, archive, restore,
  and drag conversations between groups or into Archived.
- **No empty conversations** — **New session** opens an official Codex draft.
  A real conversation is created only after the first message, then it is
  automatically associated with the workspace that opened it.
- **Native Codex experience** — clicking a session opens the official Codex
  conversation editor; Codex Ext does not implement or proxy the chat UI.
- **Localized sidebar** — English and Simplified Chinese follow VS Code's
  display language.

## Install

1. In VS Code, open the Extensions view (`⇧⌘X` on macOS).
2. Search for **Codex Ext** and install the extension published by **wzrzt**.
3. Install and enable the official **OpenAI Codex** extension.
4. Reload VS Code if prompted, then choose the **Codex Ext** icon in the left
   Activity Bar.

You can also install it from a terminal:

```bash
code --install-extension wzrzt.codex-ext
```

## Requirements

- VS Code 1.96 or newer
- [OpenAI Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt)
  (`openai.chatgpt`) for opening and managing native Codex conversations.

### Remote SSH / Dev Containers

When using Remote SSH or Dev Containers, Codex Ext runs with the workspace so
the session list and session actions operate on that remote machine. Its
automatically installed **Codex Ext Local Bridge** runs locally and reads the
signed-in account and allowance from your local Codex installation. The two
parts communicate through a VS Code command, so the remote session list and
local account usage stay independent and correct.

The extension opens sessions through the official Codex conversation editor.
Selecting an already-open chat reveals it in its existing editor group, even
after you move it to another split. Other chats and drafts open in the editor
group active when you click the sidebar action. The Codex icon in each editor
group's title bar creates a fresh chat tab in that group. No split is forced.

`codexWorkspaceSessions.chatGroupLocking` controls file routing independently:

- `off`: do not automatically lock groups.
- `chatOnly` (default): lock groups containing only Codex chat tabs.
- `containsChat`: lock any group containing a Codex chat, including mixed groups.

VS Code opens new files outside a locked group, using the most recently used
unlocked group or creating one if none is available. Locking does not relocate
existing file tabs. The policy manages matching chat groups on activation,
group focus, tab opens/closes, and setting changes. Automatic locks are released
when a managed group no longer matches the policy, including inactive groups
that have lost their last chat, or when you select `off`. Groups the extension
has not managed are left alone.

Lock/unlock commands target a resource unique to that group instead of relying
on current focus. Empty groups or groups with only resources duplicated in
other splits cannot be targeted safely; their lock update is deferred until a
unique resource is available. VS Code's public tab API does not expose manual
lock state, so groups adopted by this policy are managed as a whole; use `off`
for manual control.

It reads Codex Desktop's local thread state to retain the same user-facing
titles, workspace associations, and archive state as Codex. If that state is
unavailable, it falls back to `session_index.jsonl`. Rename, archive, and
restore use the app-server bundled with the official Codex extension; this
keeps changes consistent with Codex without directly editing its local state.

The single, continuous sidebar follows the compact Claude Code layout. Its
**Account & Usage** section shows
the signed-in email, plan, one progress bar per available Codex allowance
window, and its reset time. The **Session Manager** panel below has a tab-style
**Workspace / All sessions** switch, a search field, and a new-session action.
The session list follows directly below it and retains groups, archive, and restore. Account usage is not a conversation token estimate.

## How it works

Codex Ext reads session titles, workspace metadata, and archive state from the
Codex data on the current workspace host. Rename, archive, and restore
operations are performed by the official Codex app-server, so the changes
remain consistent with Codex itself.
Session grouping and workspace bindings are stored locally in VS Code for each
workspace. No Codex Ext cloud service receives your conversations.

## Failed-tab recovery

The **Reload Current Codex Tab** arrow is also available in the title bar of a
Codex editor, including drafts. It opens a fresh editor instance in the same
group before closing the old tab, keeping the group alive even when it contains
only that chat. A refused close rolls back the replacement and keeps the
original. Reloading can discard unsent text. Reloading a `/new` draft reopens
that draft route; use the existing session list to return to a conversation
saved from a draft. Reloading does not fix an underlying official Codex UI
startup failure.

## Usage

1. Install and enable the official OpenAI Codex extension.
2. Open a folder or multi-root workspace.
3. Click the **Codex Ext** icon in VS Code's left Activity Bar.
4. Use the **Workspace / All sessions** tabs to choose the scope. It applies
   to both active and archived sessions. Type in the search field to filter
   titles in the selected scope.
5. Active sessions are organized into **Ungrouped** and user-defined groups.
   Drag a session to a group to move it; drag it to **Archived** to archive it.
   Drag an archived session back to an active group to restore and move it.
   Group data is stored per VS Code workspace.
6. The **Archived** group follows the same scope filter. Clicking an archived
   row, or its restore action, restores that exact session to the active list.
   Rename, archive, and restore update the actual Codex conversation.
7. Existing sessions are matched to their original workspace from Codex's local
   session metadata. Opening a session also binds it to the current workspace
   automatically, covering sessions whose metadata is unavailable.
8. Use the search field to filter titles. Click a session to open it in a
   Codex editor tab.
9. **New session** opens an official Codex draft. It does not create a local
   conversation until you send the first message. After that, Codex Ext
   detects the real session and binds it to the workspace automatically.
10. If an official Codex tab fails to initialize, right-click its tab and
    choose **Reload Current Codex Tab**. This recreates only that editor tab;
    unsent draft text in the tab is discarded.

The extension follows VS Code's display language. English is the default and
Simplified Chinese is provided when VS Code uses `zh-cn`.

Bindings are held in VS Code `workspaceState`; each workspace keeps an
independent `sessionId → workspaceHash` mapping. Workspace identifiers are
SHA-256 hashes rather than raw paths.

## Release publishing

Marketplace publishing is configured through GitHub Actions Trusted Publishing,
so the repository does not store a long-lived Marketplace token. To publish a
new release, first set the matching version in `package.json`, then push a tag
using the same version:

```bash
git tag -a vX.Y.Z -m "Codex Ext X.Y.Z"
git push origin vX.Y.Z
```

The `Publish VS Code extension` workflow packages and publishes the extension.
It is safe to rerun: an already-published version is skipped rather than
replaced.

## Privacy and data handling

- Session titles, local workspace metadata, and archive state are read from
  the local Codex state on your computer; they are not sent to a Codex Ext
  service.
- Account and allowance data are requested from the official Codex extension's
  local app-server only.
- Session grouping and workspace bindings are stored in VS Code
  `workspaceState` for the current workspace.

## 中文说明

Codex Ext 是一个独立的 VS Code 扩展，用来管理本机的 OpenAI Codex 会话。

### 安装

1. 在 VS Code 打开扩展面板（macOS：`⇧⌘X`）。
2. 搜索 **Codex Ext**，安装发布者为 **wzrzt** 的扩展。
3. 安装并启用官方 **OpenAI Codex** 扩展。
4. 根据提示重载 VS Code，然后点击左侧活动栏的 **Codex Ext** 图标。

也可以在终端执行：

```bash
code --install-extension wzrzt.codex-ext
```

### Remote SSH / Dev Container

通过 Remote SSH 或 Dev Container 打开项目时，主扩展会运行在远端工作区一侧，
因此会话列表和会话管理针对远端机器。自动安装的 **Codex Ext Local Bridge**
运行在本机，读取本机 Codex 的登录账户和用量；两者通过 VS Code 命令通信，
因此远端会话与本机账户用量可以同时正确显示。

- 按当前工作区或全部本地会话筛选；已归档会话也遵循该范围。
- 显示官方 Codex 本地 app-server 返回的账户、套餐与可用额度。
- 支持搜索、新建会话、新建分组、重命名、归档、恢复，以及拖拽到分组或
  Archived。
- 点击“新建会话”只会打开官方 Codex 草稿页；未发送消息便关闭时不会产生
  空白会话。首次发送消息后，扩展会自动识别真实会话并绑定到当前工作区。
- 官方 Codex 标签页加载失败时，可右键标签页并选择“重新加载当前 Codex
  标签页”。该操作只重建当前标签页，但会丢弃该标签页中尚未发送的草稿内容。
- 会话标题、工作区信息与归档状态只从本机 Codex 数据中读取；扩展不提供或
  使用远端数据服务。

## Acknowledgements

This is an independent extension. It does not copy or modify
`codex-companion`. Earlier design work was informed by
[ramusuco/codex-companion](https://github.com/ramusuco/codex-companion);
thanks to its original author.

Codex and the blossom mark are trademarks of OpenAI. This independent plugin
is not affiliated with or endorsed by OpenAI.

Development and contribution guidance is available in
[CONTRIBUTING.md](https://github.com/wzrzt/codex-ext/blob/main/CONTRIBUTING.md).
