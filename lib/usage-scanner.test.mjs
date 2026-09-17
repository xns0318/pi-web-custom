import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createUsageScanner, normalizeUsage } = await jiti.import("./usage-scanner.ts");
const { aggregateUsage } = await jiti.import("./usage.ts");
const timestamp = "2026-09-08T00:00:00Z";
const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180, reasoning: 15, cost: { total: 0.1 } };
const message = (id, extra = {}) => ({ type: "message", id, parentId: null, timestamp, message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_CONTENT" }], provider: "test", model: "model", timestamp: Date.parse(timestamp), usage }, ...extra });
const line = (entry) => JSON.stringify(entry) + "\n";
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-usage-"));
  const dir = join(root, "sessions");
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scan = createUsageScanner(dir);
  function write(id, entries = [], extra = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: "/work/repo", timestamp, ...extra }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, scan, write };
}
const report = (scan) => aggregateUsage(scan, { now: Date.parse("2026-09-09T00:00:00Z"), range: "all" });

test("normalizes reported usage without double-counting caches/reasoning; invalid counters are safe", () => {
  assert.equal(normalizeUsage(usage).totalTokens, 180);
  assert.equal(normalizeUsage({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10, reasoning: 15 }).totalTokens, 180);
  assert.equal(normalizeUsage({ totalTokens: 99, input: 100 }).totalTokens, 99, "reported total is authoritative");
  assert.equal(normalizeUsage({ input: -1, output: "20", cacheRead: Infinity, cacheWrite: NaN }), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ cost: { input: 0.1, output: 0.2 } }).cost, 0.1 + 0.2);
});

test("reads assistant, tool and summary metering, not retainedTail, context estimates or user/tool text", async (t) => {
  const { scan, write } = fixture(t);
  write("one", [
    message("one"),
    { type: "compaction", id: "compact", timestamp, usage, tokensBefore: 999999, retainedTail: [message("one").message], summary: "PRIVATE_SUMMARY" },
    { type: "branch_summary", id: "summary", timestamp, usage, summary: "PRIVATE_SUMMARY" },
    message("tool", { message: { role: "toolResult", usage } }),
    message("user", { message: { role: "user", usage } }),
    { type: "compaction", id: "unmetered", timestamp, tokensBefore: 999999 },
    message("zero", { message: { role: "assistant", usage: { totalTokens: 0 }, stopReason: "error" } }),
  ]);
  const result = await scan();
  assert.equal(report(result).total.records, 4);
  assert.equal(report(result).total.totalTokens, 720);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(result.sessions[0].records.filter((record) => record.kind === "summary").length, 2);
});

test("deduplicates copied entries across forks with rewired parents, not unrelated short-ID collisions", async (t) => {
  const { scan, write } = fixture(t);
  const shared = message("same-id");
  const source = write("source", [shared]);
  write("fork", [{ ...shared, parentId: "rewired" }, message("fresh")], { parentSession: source, cwd: "/work/other", timestamp: "2026-09-08T01:00:00Z" });
  write("collision", [message("same-id", { message: { ...shared.message, content: "Different response" } })]);
  const result = report(await scan());
  assert.equal(result.total.records, 3);
  assert.equal(result.coverage.duplicateRecords, 1);
  assert.equal(result.projects.find((row) => row.detail === "/work/other").records, 1);
});

test("unidentified legacy entries do not accidentally deduplicate across files", async (t) => {
  const { scan, write } = fixture(t);
  const legacy = message(undefined);
  write("a", [legacy, legacy]);
  write("b", [legacy]);
  assert.equal(report(await scan()).total.records, 3);
});

test("cache reuses unchanged files, notices append/rewrite/delete, and coalesces concurrent scans", async (t) => {
  const { scan, write } = fixture(t);
  const a = write("a", [message("a")]);
  const b = write("b", [message("b")]);
  const opened = [];
  const original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => { opened.push(path); return original(path, ...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = scan();
  assert.equal(scan(), first);
  assert.equal(report(await first).total.records, 2);
  assert.deepEqual(opened.sort(), [a, b]);
  opened.length = 0;
  await scan();
  assert.deepEqual(opened, []);
  fs.appendFileSync(a, line(message("new")));
  assert.equal(report(await scan()).total.records, 3);
  assert.deepEqual(opened, [a]);
  write("a", [message("replacement")]);
  assert.equal(report(await scan()).total.records, 2);
  fs.rmSync(b);
  assert.equal(report(await scan()).total.records, 1);
  write("c", [message("c")]);
  assert.equal(report(await scan()).total.records, 2);
});

test("partial lines, invalid JSON/timestamps, missing folders, and symlink cycles are tolerated", async (t) => {
  const { root, dir, scan, write } = fixture(t);
  const a = write("a", [message("valid"), message("bad-time", { timestamp: "bad", message: { role: "assistant", usage } })]);
  fs.appendFileSync(a, "null\n{broken}\n{\"incomplete\"");
  write("invalid-header", [], { type: "not-session" });
  if (process.platform !== "win32") fs.symlinkSync(dir, join(dir, "cycle"));
  const result = await scan();
  assert.equal(report(result).total.records, 1);
  assert.equal(result.skippedLines, 4);
  assert.equal(result.unreadableFiles, 1);
  fs.appendFileSync(a, ":true}\n" + line(message("later")));
  assert.equal(report(await scan()).total.records, 2);
  const missing = createUsageScanner(join(root, "missing"));
  assert.deepEqual(await missing(), { sessions: [], unreadableFiles: 0, skippedLines: 0 });
});

test("keeps main checkout and each worktree separate while deduplicating copied history", async (t) => {
  const { scan, write } = fixture(t);
  const shared = message("shared");
  const source = write("main", [shared, message("main")]);
  write("feature", [shared, message("feature")], { cwd: "/work/repo-worktrees/feature", parentSession: source, timestamp: "2026-09-08T01:00:00Z" });
  write("fix", [shared, message("fix")], { cwd: "/work/repo-worktrees/fix", parentSession: source, timestamp: "2026-09-08T02:00:00Z" });
  const result = report(await scan());
  assert.equal(result.projects.length, 3);
  const byPath = new Map(result.projects.map((row) => [row.detail, row]));
  assert.equal(byPath.get("/work/repo").records, 2);
  assert.equal(byPath.get("/work/repo-worktrees/feature").records, 1);
  assert.equal(byPath.get("/work/repo-worktrees/fix").records, 1);
  assert.equal(result.total.totalTokens, 720);
  assert.equal(result.coverage.duplicateRecords, 2);
  assert.equal(result.projects.reduce((sum, row) => sum + row.totalTokens, 0), result.total.totalTokens);
  assert.deepEqual(report(await scan()), result, "cache preserves cwd grouping");
});

test("normalizes equivalent cwd paths but keeps subdirectories and same-named folders separate", async (t) => {
  const { scan, write } = fixture(t);
  write("main", [message("main")]);
  write("same", [message("same")], { cwd: "/work/repo/./" });
  write("subdir", [message("subdir")], { cwd: "/work/repo/subdir" });
  write("namesake", [message("namesake")], { cwd: "/other/repo" });
  const result = report(await scan());
  assert.equal(result.projects.length, 3);
  assert.equal(result.projects.find((row) => row.key === "/work/repo").records, 2);
  assert.equal(result.projects.find((row) => row.key === "/work/repo/subdir").records, 1);
  assert.equal(result.projects.find((row) => row.key === "/other/repo").records, 1);
});
