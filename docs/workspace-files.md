# Workspace text editing and file management

A lightweight, desktop-first editor for the currently selected working directory,
including an independently selected Git worktree. The existing terminal, preview,
source viewer, Git diff, upload and download remain available.

## 快速使用

- 文件浏览器中的“新建…”可新建文件或文件夹；右键或条目右侧 `…` 可重命名、删除，在文件夹内新建。
- 打开文件，点击“编辑”。点击“保存”或按 `Ctrl/Cmd + S` 才写入磁盘，不自动保存或格式化。
- 文件标签上的圆点表示有未保存内容。切换文件保留草稿、光标和撤销历史；打开 Git Diff 会显示磁盘版本并保留草稿，点击“编辑”可继续。切换到其他工作目录后，原目录的草稿只读，切回后可继续保存。
- 删除是**永久删除**，没有回收站。确认框显示完整路径；非空文件夹还需输入文件夹名称。先保存或放弃受影响的草稿才能删除。
- 与智能体或其他编辑器发生修改冲突时，草稿不会被覆盖。可查看磁盘版本、手动整理草稿，再明确确认采用该磁盘版本作为下一次保存的基准；此操作不会自动合并或保存。
- 草稿只在本页内存中。刷新、关闭网页前会请求浏览器弹出警告；选择离开、浏览器崩溃或系统中断后，未保存草稿无法恢复。

## Editing

Choose **Edit** in a file's existing viewer. CodeMirror 6 loads only when editing.
It provides line numbers, undo/redo, selection, Tab/Shift+Tab indentation,
in-file find/replace (`Ctrl/Cmd + F`), and basic syntax highlighting for common
web languages, Python, JSON, Markdown, SQL, YAML, TOML and shell/env files.
Unknown extensions use plain text. Search controls follow the app language and
the editor follows the app palette, including the dark Pine palette. Appearance
and language are configured under **Settings → General** in 0.9.1. Changing
the palette keeps the current draft and does not save it. CodeMirror's `Ctrl+M`
(`Alt+Shift+M` on macOS) toggles Tab focus mode for keyboard navigation out of the editor.

Save explicitly with the button or `Ctrl/Cmd + S`. There is no autosave,
automatic formatting, LSP, project-wide replacement, or AI/model request.
Only the active editor mounts; its draft and editor state live in a page-owned
store so switching files does not lose content or undo history. Explicit Git Diff
activation shows the disk version without discarding a draft; Edit resumes it.
Closing a dirty
tab or exiting editing requires discard confirmation. In-flight saves cannot
be closed or renamed by this UI. Clean editor buffers may be cleared on project
switches; dirty and in-flight buffers are retained and locked outside their
selected workspace. Draft contents are never written to local/session storage.

Editing is limited to regular, valid UTF-8 text of **1 MiB (1,048,576 bytes)**,
including any BOM and restored CRLF separators in the saved result. Binary,
special files, other encodings, lone CR and mixed LF/CRLF files stay read-only.
The upstream paginated text preview remains available independently: previewing
more than 256 KiB does not truncate the editor's snapshot, and loading additional
preview pages does not increase the 1 MiB editing limit.
Existing UTF-8 BOM, LF/CRLF convention, ordinary permission bits and ownership
are retained on save; inability to preserve ownership/permissions fails safely.
Atomic replacement creates a new inode: other hard links keep their old content.
ACLs, extended attributes and special mode bits are not copied. Use an external
editor for files requiring those metadata guarantees.

## File and folder operations

Use the explorer's **New…** menu, or right-click / choose **…** on a tree or
search-result entry. New files open directly in editing mode. Rename updates
open tabs and descendant draft paths and rechecks their disk baselines.
Existing destination names are never intentionally overwritten. Move, copy,
bulk actions and trash/recycle-bin integration are outside this version.

Deletion requires a confirmation showing the full path and irreversibility.
Nonempty folders require typing their exact name and delete all descendants,
including hidden files. Unsaved or saving descendant drafts block deletion.
Recursive deletion is **not transactional**: an I/O/permission failure can leave
part of a folder deleted. Errors stay visible and the listing is refreshed;
there is no implied rollback. Use Git/backups for recovery, not the editor.

## Scope, conflicts and security

`/api/workspace-files` is a separate mutation API; it does not expand the existing
read-only viewer API's authorization. Requests pass the app's host/origin checks,
body-size limits, existing allowed-root checks and the submitted workspace's
lexical/real-path containment checks. Unselected sibling worktrees cannot be
mutated through that workspace. File/session references alone are insufficient
for editing outside the selected directory. This is still a privileged,
single-user local application: use the existing auth/HTTPS/SSH protections.

- Workspace roots cannot be renamed/deleted. `.git` paths and recursive
  rename/delete operations containing nested `.git` metadata are refused.
  Ordinary `.gitignore` and `.env` files remain editable.
- Internal symlinks, including leaf symlinks, are read-only in this API. A
  workspace alias must itself resolve inside an authorized root. Recursive
  deletion removes child links without traversing their targets.
- Names reject separators, traversal components, controls and invalid Unicode.
  Creation is exclusive; file rename uses exclusive hard-link creation followed
  by unlink, refusing unsupported filesystems instead of falling back to an
  overwriting rename. Folder rename reserves its destination exclusively.
- Saves compare metadata plus a SHA-256 content version. Data is written to an
  exclusive same-directory temporary, flushed, checked again, and atomically
  replaced. A conflict or pre-commit failure retains the draft and original
  disk content. Cleanup is best effort if an external process moves a temporary.
- App mutations share a process-wide queue. This is **optimistic concurrency**,
  not an OS lock against external editors or hostile simultaneous filesystem
  changes. Avoid concurrently renaming directories or deleting trees from another
  process. Recursive metadata preflight is bounded at 100,000 entries.
- An HTTP timeout/network failure may occur after a mutation commits. Refresh
  and inspect disk state before retrying; errors never imply an atomic rollback.

## Verification

```bash
node --test lib/workspace-files.test.mjs lib/file-editor-state.test.mjs app/api/workspace-files/route.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm test
FILES_E2E_URL=http://127.0.0.1:30142 node e2e/workspace-files.mjs
```

The browser suite registers disposable `/tmp` workspaces, mocks session/agent
responses and Git UI fixtures, and tests real file operations without sending prompts or modifying
real projects/session history. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if Chromium
is installed at a custom path. The existing terminal browser suite can also run
with `TERMINAL_E2E_SERVER_MODE=start` in a **separate production build directory**;
it starts its own isolated process and session fixtures, never the active dev
checkout. See [release process](./release.md), [internationalization](./i18n.md)
and [development notes](../AGENTS.md). Never build inside the active dev checkout.
