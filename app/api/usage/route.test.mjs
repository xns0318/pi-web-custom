import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const original = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "pi-web-usage-api-"));
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { alias: { "@": join(dirname(fileURLToPath(import.meta.url)), "../../..") } });
const { GET } = await jiti.import("./route.ts");
after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  globalThis.__piWebUsageService?.service.dispose();
  globalThis.__piWebUsageService = undefined;
  globalThis.__piWebUsageScanner = undefined;
  await rm(root, { recursive: true, force: true });
});
const request = (query = "") => new Request(`http://localhost/api/usage${query}`);

test("usage API validates ranges and IANA time zones and always disables caching", async () => {
  for (const query of ["?range=garbage", "?timeZone=invalid", "?timeZone=", "?range=../../private", "?view=invalid", "?refresh=invalid", "?refresh="]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const response = await GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.range, "30d");
  assert.equal(body.timeZone, "UTC");
  assert.equal(body.total.totalTokens, 0);
});

test("usage API reads only the configured store and returns aggregates without chat content", async () => {
  const sessions = join(root, "sessions", "project");
  await mkdir(sessions, { recursive: true });
  const timestamp = "2020-01-01T00:00:00Z";
  await writeFile(join(sessions, "one.jsonl"), [
    { type: "session", id: "one", cwd: "/usage-test-project-does-not-exist", timestamp },
    { type: "message", id: "entry", timestamp, message: { role: "assistant", provider: "test", model: "test", content: "SECRET_PROMPT", usage: { input: 100, output: 20, cacheRead: 50, totalTokens: 170 } } },
  ].map(JSON.stringify).join("\n") + "\n");
  const response = await GET(request("?range=all&timeZone=Asia%2FShanghai&refresh=1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.total.totalTokens, 170);
  assert.equal(body.projects[0].totalTokens, 170);
  assert.equal(body.daily[0].key, "2020-01-01");
  assert.equal(body.coverage.sessions, 1);
  assert.doesNotMatch(JSON.stringify(body), /SECRET_PROMPT|entry/);
});

test("usage API keeps worktrees separate and replaces an older repo-grouped scanner after hot reload", async () => {
  const sessions = join(root, "sessions", "worktrees");
  await mkdir(sessions, { recursive: true });
  const timestamp = "2020-01-01T00:00:00Z";
  const cwds = ["/work/repo", "/work/repo-worktrees/feature", "/work/repo-worktrees/fix"];
  for (const [index, cwd] of cwds.entries()) {
    await writeFile(join(sessions, `${index}.jsonl`), [
      { type: "session", id: `session-${index}`, cwd, timestamp },
      { type: "message", id: `record-${index}`, timestamp, message: { role: "assistant", usage: { input: 10, totalTokens: 10 } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  const previousService = globalThis.__piWebUsageService.service;
  globalThis.__piWebUsageScanner = {
    root: join(root, "sessions"),
    scan: () => { throw new Error("must not reuse the old repository-grouped scanner"); },
  };
  const response = await GET(request("?range=all"));
  assert.equal(response.status, 200);
  const body = await response.json();
  for (const cwd of cwds) {
    const row = body.projects.find((row) => row.key === cwd);
    assert.equal(row?.detail, cwd);
    assert.equal(row?.totalTokens, 10);
  }
  assert.equal(body.projects.reduce((sum, row) => sum + row.totalTokens, 0), body.total.totalTokens);
  assert.equal(globalThis.__piWebUsageScanner.grouping, "cwd");
  await assert.rejects(previousService.getSnapshot(), /disposed/, "HMR must stop the old background loop");
});

test("snapshot API returns all four complete ranges from one scanner call", async () => {
  const current = globalThis.__piWebUsageScanner;
  let scans = 0;
  globalThis.__piWebUsageScanner = { ...current, scan: () => { scans++; return current.scan(); } };
  const response = await GET(request("?view=snapshot&timeZone=Asia%2FShanghai"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(scans, 1);
  const snapshot = await response.json();
  assert.deepEqual(Object.keys(snapshot.ranges), ["today", "7d", "30d", "all"]);
  assert.equal(snapshot.timeZone, "Asia/Shanghai");
  assert.equal(snapshot.coverage.sessions, 4);
  assert.equal(snapshot.ranges.all.total.totalTokens, 200);
  for (const [range, breakdown] of Object.entries(snapshot.ranges)) {
    assert.deepEqual(breakdown.total, snapshot.overview[range]);
    for (const rows of [breakdown.daily, breakdown.models, breakdown.projects]) {
      assert.equal(rows.reduce((sum, row) => sum + row.totalTokens, 0), breakdown.total.totalTokens);
    }
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_PROMPT|record-0/);
});

test("usage API serves warmed snapshots and manual refresh bypasses them immediately", async () => {
  const current = globalThis.__piWebUsageScanner;
  let scans = 0;
  globalThis.__piWebUsageScanner = { ...current, scan: () => { scans++; return current.scan(); } };
  const query = "?view=snapshot&timeZone=Asia%2FShanghai";
  const first = await (await GET(request(query))).json();
  assert.equal(scans, 1);
  await appendFile(join(root, "sessions", "project", "one.jsonl"), JSON.stringify({
    type: "message", id: "new-record", timestamp: "2020-01-02T00:00:00Z",
    message: { role: "assistant", usage: { input: 33, totalTokens: 33 } },
  }) + "\n");
  const cached = await (await GET(request(query))).json();
  assert.deepEqual(cached, first);
  assert.equal(scans, 1, "ordinary reads do not repeat the background scan");
  const refreshed = await (await GET(request(`${query}&refresh=1`))).json();
  assert.equal(scans, 2);
  assert.equal(refreshed.ranges.all.total.totalTokens, first.ranges.all.total.totalTokens + 33);
  const legacy = await (await GET(request("?range=all&timeZone=Asia%2FShanghai"))).json();
  assert.equal(legacy.total.totalTokens, refreshed.ranges.all.total.totalTokens);
  assert.equal(legacy.generatedAt, refreshed.generatedAt);
  assert.equal(scans, 2);
});
