import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("./", import.meta.url).pathname + ".." } });
const { createFileEditorStore, draftDirty, fileInWorkspace } = await jiti.import("./file-editor-state.ts");
const { applyFileMutation } = await jiti.import("./file-tab-mutations.ts");
const draft = (content = "base") => ({ content, baseline: "base", version: "v1", eol: "\n", bom: false, saving: false, error: null });

test("typing only rerenders draft subscribers, not the entire shell on every key", () => {
  const store = createFileEditorStore();
  let events = 0; const off = store.subscribe(() => events++);
  store.set("/root/a", draft());
  store.set("/root/a", draft("edit"));
  const status = store.status();
  store.set("/root/a", draft("edit more"));
  assert.equal(store.status(), status);
  assert.equal(events, 3);
  assert.equal(store.hasPending(), true);
  off(); store.set("/root/a", draft());
  assert.equal(events, 3);
  assert.equal(store.hasPending(), false);
});
test("workspace switches retain only unsaved or in-flight drafts", () => {
  const store = createFileEditorStore();
  store.set("/a/clean", draft()); store.set("/a/dirty", draft("modified"));
  store.set("/a/pending", { ...draft(), saving: true });
  store.clearClean();
  assert.equal(store.get("/a/clean"), undefined);
  assert.equal(draftDirty(store.get("/a/dirty")), true);
  assert.equal(store.get("/a/pending").saving, true);
});
test("folder rename rekeys descendants and retains text, selection and undo state", () => {
  const store = createFileEditorStore(); const editorState = { opaque: "selection and history" };
  store.set("/root/old/nested/a", { ...draft("changed"), editorState });
  store.set("/root/old-other/a", draft("other"));
  store.rename("/root/old", "/root/new");
  assert.equal(store.get("/root/old/nested/a"), undefined);
  assert.equal(store.get("/root/new/nested/a").content, "changed");
  assert.equal(store.get("/root/new/nested/a").editorState, editorState);
  assert.ok(store.get("/root/old-other/a"));
  store.removeTree("/root/new");
  assert.ok(store.get("/root/old-other/a"));
});
test("reviewed LF/CRLF baselines compare by editable text after saving", () => {
  assert.equal(draftDirty({ ...draft("same\ntext\n"), baseline: "same\r\ntext\r\n" }), false);
  assert.equal(draftDirty({ ...draft("different\ntext\n"), baseline: "same\r\ntext\r\n" }), true);
});
test("UI path hints do not conflate sibling folders, worktrees or Git metadata", () => {
  assert.equal(fileInWorkspace("/repo/a", "/repo"), true);
  for (const path of ["/repo-other/a", "/repo-worktree/a", "/repo/../outside", "/repo/.git/config"]) assert.equal(fileInWorkspace(path, "/repo"), false);
  assert.equal(fileInWorkspace("C:\\Repo\\a", "c:/repo"), true);
});
test("rename and delete update open tabs without mutating the original list", () => {
  const tabs = [{ id: "file:/repo/old/a", filePath: "/repo/old/a", label: "a", viewerState: { scrollTop: 12 }, viewerRevision: 2 }, { id: "file:/repo/other", filePath: "/repo/other", label: "other" }];
  const next = applyFileMutation(tabs, { operation: "rename", path: "/repo/old", newPath: "/repo/new" });
  assert.equal(next[0].id, "file:/repo/new/a");
  assert.equal(next[0].viewerRevision, 3);
  assert.equal(next[0].viewerState.scrollTop, 12);
  assert.equal(tabs[0].filePath, "/repo/old/a");
  assert.equal(next[1], tabs[1]);
  assert.deepEqual(applyFileMutation(next, { operation: "delete", path: "/repo/new" }), [tabs[1]]);
});
