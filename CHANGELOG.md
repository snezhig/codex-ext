# Changelog

All notable changes to this project are documented in this file.

## 0.6.15 — 2026-11-03

- Read SQLite sessions through portable hex-encoded rows instead of the
  version-specific `sqlite3 -json` option; internal Guardian review sessions
  no longer appear when SQLite is available.
- Filter Guardian reviews from the JSONL fallback as a defensive measure.
- Add **Reload Current Codex Tab** to the open Codex tab's right-click menu,
  allowing a failed official editor to be recreated without reloading VS Code.

## 0.6.14 — 2026-11-03

- Restore the main extension to the Remote-SSH workspace host, so it reads and
  manages the SSH host's Codex sessions rather than macOS sessions.
- Move account usage to a dedicated local bridge extension, allowing remote
  sessions and local account usage to coexist.

## 0.6.13 — 2026-11-02

- Remove the cross-host hard dependency on OpenAI Codex. Codex Ext can now
  activate its sidebar in Remote-SSH even when the official extension runs in
  a different extension host.

## 0.6.12 — 2026-11-01

- Add a local ChatGPT Desktop Codex CLI fallback for Remote-SSH account usage
  on macOS, even if the official VS Code extension is installed remotely.
- Show the concrete Account & Usage failure in the sidebar, including a clear
  instruction when Codex Ext was installed on the SSH host instead of locally.

## 0.6.11 — 2026-11-01

- Fix Account & Usage for Remote SSH and Dev Containers by running Codex Ext
  in VS Code's local UI extension host, alongside the official Codex account.

## 0.6.10 — 2026-11-01

- Updated the Marketplace description and README to reflect the current
  workspace session manager, account usage, search, grouping, archive, and
  official-draft behavior.

## 0.6.9 — 2026-10-30

- Give each official Codex draft a unique URI fragment. New session now opens
  a separate official draft tab instead of refocusing an existing one.

## 0.6.8 — 2026-10-30

- Open new drafts through the official Codex command. This restores the
  official conversation UI and avoids unsupported custom URI parameters.

## 0.6.7 — 2026-10-29

- New official Codex editors are now tracked as temporary drafts: no local
  thread is created until the first message is sent.
- After that first message, Codex Ext detects the newly created thread,
  refreshes the session manager, and automatically binds it to the workspace
  that opened the draft.

## 0.6.6 — 2026-10-25

- Keep official Codex conversation editors open after a rename. This avoids
  interrupting in-progress responses; the title is refreshed in Codex Ext's
  session manager only.

## 0.6.5 — 2026-10-25

- After a rename made in Codex Ext, reopen the matching official Codex editor
  so its native VS Code tab refreshes to the new title.

## 0.6.4 — 2026-10-25

- Fixed **New session** so every click opens a distinct official Codex
  conversation editor instead of reusing a previously opened blank editor.
- Show a visible error notification if a session action cannot be completed.

## 0.6.3 — 2026-10-25

- Reworked Marketplace documentation around installation and everyday use.
- Removed local development and obsolete VSIX instructions from the public
  extension page.

## 0.6.2 — 2026-10-25

- Added a single, continuous Claude Code-inspired sidebar layout.
- Added account, plan, and official Codex allowance display.
- Added workspace/all-session tabs, title search, groups, archiving, and
  drag-and-drop group/archive management.
- Added English and Simplified Chinese localization.

