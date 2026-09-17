import assert from "node:assert/strict";
import test from "node:test";
import { newTerminalTab, nextTerminalNumber, restoreTerminalTabs } from "./terminal-tab-state.ts";

test("restored workspace tabs retain terminal identity and never request a new shell", () => {
  const first = newTerminalTab("/repo/worktree-a");
  const second = newTerminalTab("/repo/worktree-b");
  assert.notEqual(first.id, second.id);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ ...first, restored: true }, { ...second, restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("same-directory terminals keep distinct identities, numbers and the active tab on refresh", () => {
  const first = newTerminalTab("/repo");
  const second = newTerminalTab("/repo", nextTerminalNumber([first], "/repo"));
  assert.notEqual(first.id, second.id);
  assert.equal(second.number, 2);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ ...first, restored: true }, { ...second, restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("terminal numbers are per-directory and closing a sibling does not renumber survivors", () => {
  const first = newTerminalTab("/repo");
  const second = newTerminalTab("/repo", 2);
  assert.equal(nextTerminalNumber([first, second], "/repo"), 3);
  assert.equal(nextTerminalNumber([first, second], "/other"), 1);
  assert.equal(nextTerminalNumber([second], "/repo"), 1);
  assert.equal(second.number, 2);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [second], activeId: second.id }));
  assert.equal(saved.tabs[0].number, 2);
  assert.equal(saved.activeId, second.id);
});

test("restart can replace one process identity without changing its cwd or number", () => {
  const original = { ...newTerminalTab("/repo", 2), restored: true, closing: "restart" };
  const restarted = newTerminalTab(original.cwd, original.number);
  assert.notEqual(restarted.id, original.id);
  assert.equal(restarted.cwd, original.cwd);
  assert.equal(restarted.number, original.number);
  assert.equal(restarted.restored, undefined);
  assert.equal(restarted.closing, undefined);
});

test("legacy storage without numbers restores every same-directory process", () => {
  const { id: firstId } = newTerminalTab("/repo");
  const { id: secondId } = newTerminalTab("/repo");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [{ id: firstId, cwd: "/repo" }, { id: secondId, cwd: "/repo" }],
    activeId: secondId,
    open: true,
  }));
  assert.deepEqual(saved, {
    tabs: [
      { id: firstId, cwd: "/repo", number: 1, restored: true },
      { id: secondId, cwd: "/repo", number: 2, restored: true },
    ],
    activeId: secondId,
    open: true,
  });
});

test("invalid or duplicate labels are repaired, but duplicate process IDs are still removed", () => {
  const tabs = [1, 1, 0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1].map((number) => ({
    ...newTerminalTab("/repo"), number, closing: "close",
  }));
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [...tabs, { ...tabs[0], cwd: "/other" }], activeId: tabs.at(-1).id,
  }));
  assert.deepEqual(saved.tabs.map((tab) => tab.id), tabs.map((tab) => tab.id));
  assert.deepEqual(saved.tabs.map((tab) => tab.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(saved.tabs.every((tab) => tab.restored && tab.closing === undefined));
  assert.equal(saved.activeId, tabs.at(-1).id);
});

test("storage corruption cannot create invalid or duplicate terminal tabs", () => {
  assert.deepEqual(restoreTerminalTabs("broken"), { tabs: [], activeId: null, open: false });
  assert.deepEqual(restoreTerminalTabs(null), { tabs: [], activeId: null, open: false });
  const tab = newTerminalTab("/repo");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [null, {}, tab, tab, { ...tab, id: "../../bad" }, { ...tab, cwd: null }],
    activeId: "missing",
  }));
  assert.deepEqual(saved, { tabs: [{ ...tab, restored: true }], activeId: null, open: false });
});
