// Uses only disposable workspaces under /tmp. Never writes real projects or
// session history, sends prompts, or restarts an existing server.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.FILES_E2E_URL || "http://127.0.0.1:30142";
const temporary = mkdtempSync(join(tmpdir(), "pi-web-files-e2e-"));
const workspace = join(temporary, "workspace-a");
const other = join(temporary, "workspace-b");
mkdirSync(workspace); mkdirSync(other);
const note = join(workspace, "note.txt");
const second = join(workspace, "other.md");
const folder = join(workspace, "folder");
mkdirSync(folder);
writeFileSync(note, "original\n"); writeFileSync(second, "# Other file\n");
writeFileSync(join(workspace, "binary.bin"), Buffer.from([0xff, 0xfe, 0, 0]));
writeFileSync(join(folder, "nested.txt"), "nested baseline\n");
writeFileSync(join(other, "elsewhere.txt"), "other workspace\n");
const artifacts = new URL("../test-results/workspace-files/", import.meta.url).pathname;
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ locale: "en", viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const panel = page.locator("#file-panel");
const row = (path) => page.locator(`[data-file-path=${JSON.stringify(path)}]`);
const editor = () => panel.locator(".cm-content");
const text = () => editor().evaluate((element) => [...element.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n"));
const saved = async () => { await panel.getByText("Saved", { exact: true }).waitFor(); };
const open = async (path) => { await row(path).click(); await panel.getByRole("button", { name: "Edit", exact: true }).waitFor(); };
const edit = async () => { await panel.getByRole("button", { name: "Edit", exact: true }).click(); await editor().waitFor(); };
const save = async () => { await panel.getByRole("button", { name: "Save", exact: true }).click({ trial: true }); await editor().focus(); await page.keyboard.press("Control+s"); await saved(); };
const menuAction = async (path, name) => {
  if (path === workspace) await page.getByRole("button", { name: "New…", exact: true }).click();
  else await row(path).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name, exact: true }).click();
};
const dialog = () => page.getByRole("dialog");
try {
  for (const cwd of [workspace, other]) {
    const response = await context.request.post(`${base}/api/cwd/validate`, { data: { cwd } });
    assert.equal(response.status(), 200);
  }
  const sessions = [workspace, other].map((cwd, i) => ({ id: `file-fixture-${i}`, path: "", cwd, projectRoot: cwd, projectKey: cwd, created: "2026-09-08T00:00:00Z", modified: "2026-09-08T00:00:00Z", messageCount: 0, firstMessage: "", name: `Fixture ${i}` }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions, runningSessionIds: [], sessionListVersion: 0 } }));
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { sessions, runningSessionIds: [], sessionListVersion: 0 } }));
  // Deterministic Git UI fixtures; workspace file reads and mutations remain real.
  await page.route("**/api/git/status?*", (route) => route.fulfill({ json: {
    isGitRepository: true, repositoryRoot: workspace, additions: 1, deletions: 1,
    files: new URL(route.request().url()).searchParams.get("cwd") === workspace
      ? [{ filePath: note, status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }] : [],
  } }));
  await page.route("**/api/git/diff?*", (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get("path") === note
    ? { supported: true, status: "modified", patch: "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-version from Git\n+original\n" }
    : { supported: false } }));
  await page.route("**/api/agent/**", (route) => {
    if (route.request().method() !== "GET") { errors.push("Unexpected agent mutation"); return route.abort(); }
    return route.fulfill({ json: { runningSessionIds: [], sessionListVersion: 0 } });
  });
  await page.goto(`${base}/?cwd=${encodeURIComponent(workspace)}`, { waitUntil: "networkidle" });
  await open(note); await edit();
  await editor().fill("SENSITIVE_DRAFT one\n");
  await panel.locator('[role="tab"][data-dirty="true"]').waitFor();
  assert.equal(readFileSync(note, "utf8"), "original\n", "editing must not auto-save");
  assert.equal(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  }), true, "page refresh warns before discarding a draft");
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) => value.includes("SENSITIVE_DRAFT"))), false);

  await open(second);
  await panel.getByRole("tab", { name: "note.txt", exact: true }).click();
  await editor().waitFor();
  assert.equal(await text(), "SENSITIVE_DRAFT one\n", "switching tabs preserves draft");
  await editor().focus(); await page.keyboard.press("Control+z");
  assert.equal(await text(), "original\n", "undo history survives remount");
  await page.keyboard.press("Control+Shift+z");
  assert.equal(await text(), "SENSITIVE_DRAFT one\n");

  // Explicit Git Diff activation shows disk without discarding an editor draft.
  await page.getByRole("button", { name: "1 changed files", exact: true }).click();
  await page.locator(`[data-git-file-path=${JSON.stringify(note)}]`).click();
  await panel.getByText("version from Git", { exact: true }).waitFor();
  assert.equal(await editor().count(), 0);
  await panel.locator('[role="tab"][data-dirty="true"]').waitFor();
  await edit();
  assert.equal(await text(), "SENSITIVE_DRAFT one\n", "Git Diff retains the editor draft");
  assert.equal(readFileSync(note, "utf8"), "original\n");
  await page.getByRole("button", { name: "1 changed files", exact: true }).click();

  // Project switches cannot clear unsaved tabs or enable out-of-workspace saves.
  await page.locator(`button[title=${JSON.stringify(workspace)}]`).first().click();
  await page.locator(`button[title=${JSON.stringify(other)}]`).click();
  await panel.getByText("Draft retained. Switch back to this file's workspace to edit or save it.", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Save", exact: true }).isEnabled(), false);
  assert.equal(await text(), "SENSITIVE_DRAFT one\n");
  await page.locator(`button[title=${JSON.stringify(other)}]`).first().click();
  await page.locator(`button[title=${JSON.stringify(workspace)}]`).click();
  await panel.getByRole("button", { name: "Save", exact: true }).waitFor();
  await save();
  assert.equal(readFileSync(note, "utf8"), "SENSITIVE_DRAFT one\n");

  // v0.9.1 appearance controls moved to Settings. Switching palettes while a
  // draft is open must neither save it nor lose its CodeMirror state.
  await editor().fill("theme switch draft\n");
  for (const [theme, label] of [["mist", "Mist"], ["rose", "Rose"], ["pine", "Pine"], ["light", "Light"]]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("radio", { name: label, exact: true }).locator("..").click();
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await text(), "theme switch draft\n");
    assert.equal(readFileSync(note, "utf8"), "SENSITIVE_DRAFT one\n", "theme changes must not save drafts");
    await panel.locator('[role="tab"][data-dirty="true"]').waitFor();
    await page.screenshot({ path: join(artifacts, `editor-${theme}.png`) });
  }
  await editor().fill("SENSITIVE_DRAFT one\n");
  await saved();

  // A failed save keeps the buffer; retry uses the same still-valid baseline.
  const failSave = (route) => route.request().method() === "POST" ? route.fulfill({ status: 500, json: { code: "failed" } }) : route.fallback();
  await page.route("**/api/workspace-files", failSave);
  await editor().fill("retry me\n");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(await text(), "retry me\n");
  assert.equal(readFileSync(note, "utf8"), "SENSITIVE_DRAFT one\n");
  await page.unroute("**/api/workspace-files", failSave);
  await save();
  assert.equal(readFileSync(note, "utf8"), "retry me\n");

  // External/AI updates cannot overwrite the editor or be overwritten silently.
  await editor().fill("my conflicting draft\n");
  writeFileSync(note, "agent edit\r\n");
  await panel.getByRole("alert").waitFor();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByRole("button", { name: "Save", exact: true }).waitFor({ state: "visible" });
  assert.equal(readFileSync(note, "utf8"), "agent edit\r\n");
  assert.equal(await text(), "my conflicting draft\n");
  // A cancelled, slow discard/reload cannot later replace an inactive draft.
  const heldDisk = Promise.withResolvers(), diskRequested = Promise.withResolvers(), diskReleased = Promise.withResolvers();
  const holdDisk = async (route) => {
    if (new URL(route.request().url()).searchParams.get("path") !== note) return route.fallback();
    diskRequested.resolve();
    await heldDisk.promise;
    await route.fulfill({ json: { content: "stale reload", eol: "\n", bom: false, version: "stale-read" } }).catch(() => {});
    diskReleased.resolve();
  };
  await page.route("**/api/workspace-files?*", holdDisk);
  page.once("dialog", (event) => event.accept());
  await panel.getByRole("button", { name: "Discard draft and reload", exact: true }).click();
  await diskRequested.promise;
  await open(second);
  await page.unroute("**/api/workspace-files?*", holdDisk);
  heldDisk.resolve(); await diskReleased.promise;
  await panel.getByRole("tab", { name: "note.txt", exact: true }).click();
  await editor().waitFor();
  assert.equal(await text(), "my conflicting draft\n", "late cancelled reload must not discard a retained draft");
  await panel.getByRole("button", { name: "View disk version", exact: true }).click();
  await panel.locator(".workspace-disk-version pre").getByText("agent edit", { exact: false }).waitFor();
  await editor().fill("my draft + agent edit\n");
  page.once("dialog", (event) => event.accept());
  await panel.getByRole("button", { name: "Keep draft with this disk baseline", exact: true }).click();
  await save();
  assert.equal(readFileSync(note, "utf8"), "my draft + agent edit\r\n", "adopting a CRLF disk baseline does not strand a saved LF editor as dirty");

  // Closing can be cancelled, and only explicit confirmation discards a draft.
  await editor().fill("do not silently lose this\n");
  page.once("dialog", (event) => event.dismiss());
  await panel.getByRole("button", { name: "Close note.txt", exact: true }).click();
  assert.equal(await text(), "do not silently lose this\n");
  page.once("dialog", (event) => event.accept());
  await panel.getByRole("button", { name: "Close note.txt", exact: true }).click();
  await panel.getByRole("tab", { name: "note.txt", exact: true }).waitFor({ state: "hidden" });

  // Rename a folder containing an open dirty file; preserve its text and history.
  await row(folder).click();
  await open(join(folder, "nested.txt")); await edit();
  await editor().fill("renamed draft\n");
  await menuAction(folder, "Rename");
  await dialog().getByRole("textbox", { name: "Name", exact: true }).fill("moved");
  await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await editor().waitFor();
  assert.equal(await text(), "renamed draft\n");
  const moved = join(workspace, "moved");
  await editor().focus(); await page.keyboard.press("Control+End"); await page.keyboard.insertText("after rename\n");
  await save();
  assert.equal(existsSync(folder), false);
  assert.equal(readFileSync(join(moved, "nested.txt"), "utf8"), "renamed draft\nafter rename\n");
  await page.screenshot({ path: join(artifacts, "editor.png") });

  // Pending drafts block deletion until handled; nonempty folders require names.
  await editor().fill("unsaved before delete");
  await menuAction(moved, "Delete");
  await dialog().getByRole("alert").waitFor();
  assert.equal(await dialog().getByRole("button", { name: "Permanently delete", exact: true }).isEnabled(), false);
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await save();
  await menuAction(moved, "Delete");
  await dialog().getByRole("textbox", { name: "Confirm folder name", exact: true }).fill("wrong");
  assert.equal(await dialog().getByRole("button", { name: "Permanently delete", exact: true }).isEnabled(), false);
  await dialog().getByRole("textbox", { name: "Confirm folder name", exact: true }).fill("moved");
  await page.screenshot({ path: join(artifacts, "delete-confirmation.png") });
  await dialog().getByRole("button", { name: "Permanently delete", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(existsSync(moved), false);
  await panel.getByRole("tab", { name: "nested.txt", exact: true }).waitFor({ state: "hidden" });

  // Creation collision is recoverable without clobbering. New files open editing.
  await menuAction(workspace, "New file");
  await dialog().getByRole("textbox", { name: "Name", exact: true }).fill("note.txt");
  await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog().getByRole("alert").waitFor();
  assert.equal(readFileSync(note, "utf8"), "my draft + agent edit\r\n");
  await dialog().getByRole("textbox", { name: "Name", exact: true }).fill("fresh.md");
  await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await editor().waitFor();
  await editor().fill("# New file\n"); await save();
  assert.equal(readFileSync(join(workspace, "fresh.md"), "utf8"), "# New file\n");
  await editor().focus(); await page.keyboard.press("Control+Home"); await page.keyboard.press("Tab");
  assert.equal(await text(), "  # New file\n", "Tab indents");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await text(), "# New file\n", "Shift+Tab unindents");
  await page.keyboard.press("Control+f");
  await panel.getByRole("textbox", { name: "Find", exact: true }).fill("New");
  await panel.getByRole("textbox", { name: "Replace", exact: true }).fill("Edited");
  await panel.getByRole("button", { name: "replace all", exact: true }).click();
  await panel.getByRole("button", { name: "close", exact: true }).click();
  assert.equal(await text(), "# Edited file\n", "in-file find/replace changes only the draft");
  assert.equal(readFileSync(join(workspace, "fresh.md"), "utf8"), "# New file\n");
  await menuAction(join(workspace, "fresh.md"), "Rename");
  await dialog().getByRole("textbox", { name: "Name", exact: true }).fill("fresh-renamed.md");
  await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await panel.getByRole("tab", { name: "fresh-renamed.md", exact: true }).waitFor();
  await save();
  assert.equal(existsSync(join(workspace, "fresh.md")), false);
  assert.equal(readFileSync(join(workspace, "fresh-renamed.md"), "utf8"), "# Edited file\n");
  await menuAction(workspace, "New folder");
  await dialog().getByRole("textbox", { name: "Name", exact: true }).fill("new-folder");
  await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await row(join(workspace, "new-folder")).waitFor();
  await menuAction(join(workspace, "new-folder"), "New file");
  await dialog().getByRole("textbox", { name: "Name", exact: true }).fill("中文 #%.txt");
  await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await editor().waitFor(); await editor().fill("\ufeff中文内容\n"); await save();
  const chineseFile = join(workspace, "new-folder", "中文 #%.txt");
  assert.equal(readFileSync(chineseFile, "utf8"), "\ufeff中文内容\n");
  assert.equal(await text(), "中文内容\n", "a pasted leading BOM is reflected as metadata after save");
  await row(join(workspace, "new-folder")).click();
  await menuAction(chineseFile, "Delete");
  assert.equal(await dialog().getByRole("textbox").count(), 0, "regular file deletion needs confirmation, not a folder name");
  await dialog().getByRole("button", { name: "Permanently delete", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(existsSync(chineseFile), false);

  // Original preview and themes/locales remain usable; no persistent drafts.
  await panel.getByRole("button", { name: "Exit editing", exact: true }).click();
  await panel.getByRole("button", { name: "Edit", exact: true }).waitFor();
  await open(join(workspace, "binary.bin"));
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByText("This file is not valid UTF-8 text. It was not changed.", { exact: true }).waitFor();
  assert.equal(await editor().count(), 0);
  assert.deepEqual(readFileSync(join(workspace, "binary.bin")), Buffer.from([0xff, 0xfe, 0, 0]));
  for (const [locale, editLabel] of [["zh-CN", "编辑"], ["zh-TW", "編輯"]]) {
    await page.evaluate((locale) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", "dark"); }, locale);
    await page.reload({ waitUntil: "networkidle" });
    await row(note).click();
    await panel.getByRole("button", { name: editLabel, exact: true }).click();
    await editor().waitFor();
    await page.keyboard.press("Control+f");
    await panel.getByRole("textbox", { name: locale === "zh-CN" ? "查找" : "尋找", exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, `${locale}-dark.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(`Workspace files E2E passed: editing, drafts/history, workspace isolation, conflicts, CRUD and locales. Screenshots: ${artifacts}`);
} catch (error) {
  await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  console.error("Failure screenshot:", join(artifacts, "failure.png"));
  throw error;
} finally {
  await browser.close();
  rmSync(temporary, { recursive: true, force: true });
}
