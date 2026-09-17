import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createUsageService } = await jiti.import("./usage-service.ts");
const { emptyUsage, USAGE_REFRESH_INTERVAL_MS: interval } = await jiti.import("./usage.ts");
const start = Date.parse("2026-09-08T10:00:00Z");
const settle = () => new Promise(setImmediate);
const fixture = (tokens = 10, timestamp = start - 1000) => ({
  unreadableFiles: 0, skippedLines: 0,
  sessions: [{ path: "fixture", created: 0, project: "/repo/worktree", projectKey: "/repo/worktree", records: [{
    ...emptyUsage(), key: String(timestamp), timestamp, kind: "assistant", model: "test", provider: "test",
    input: tokens, totalTokens: tokens, records: 1,
  }] }],
});
function setup(t, scan, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const service = createUsageService(scan, options);
  t.after(() => service.dispose());
  return service;
}

test("background usage starts and refreshes every 30s without any browser or API reads", async (t) => {
  let scans = 0;
  const service = setup(t, async () => fixture(++scans * 10));
  service.start();
  service.start(); // Idempotent startup; no duplicate loop.
  await settle();
  assert.equal(scans, 1);
  t.mock.timers.tick(interval - 1);
  await settle();
  assert.equal(scans, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(scans, 2);
  t.mock.timers.tick(interval);
  await settle();
  assert.equal(scans, 3);
  const snapshot = await service.getSnapshot("Asia/Shanghai");
  assert.equal(snapshot.ranges.all.total.totalTokens, 30);
  assert.equal(snapshot.generatedAt, new Date(start + interval * 2).toISOString());
  assert.equal(scans, 3, "opening the panel reads the warmed snapshot, not another scan");
});

test("cache reads share a generation; manual refresh reads now and resets the timer", async (t) => {
  let scans = 0;
  let tokens = 10;
  const service = setup(t, async () => { scans++; return fixture(tokens); });
  service.start();
  const first = await service.getSnapshot();
  tokens = 20;
  t.mock.timers.tick(10_000);
  assert.equal(await service.getSnapshot(), first);
  assert.equal((await service.getSnapshot("Asia/Shanghai")).generatedAt, first.generatedAt);
  assert.equal(scans, 1);
  const next = await service.getSnapshot("UTC", true);
  assert.equal(scans, 2);
  assert.equal(next.ranges.all.total.totalTokens, 20);
  assert.notEqual(next.generatedAt, first.generatedAt);
  t.mock.timers.tick(interval - 1);
  await settle();
  assert.equal(scans, 2, "the superseded timer must not fire");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(scans, 3);
});

test("slow background scans keep the old snapshot readable and coalesce manual refreshes", async (t) => {
  let scans = 0;
  let release;
  const service = setup(t, async () => {
    scans++;
    if (scans === 2) await new Promise((resolve) => { release = resolve; });
    return fixture(scans * 10);
  });
  service.start();
  const first = await service.getSnapshot();
  t.mock.timers.tick(interval);
  await settle();
  const manualA = service.getSnapshot("UTC", true);
  const manualB = service.getSnapshot("Asia/Shanghai", true);
  assert.equal(await service.getSnapshot(), first);
  t.mock.timers.tick(interval * 4);
  await settle();
  assert.equal(scans, 2, "no overlapping scans or accumulated timer work");
  release();
  const [a, b] = await Promise.all([manualA, manualB]);
  assert.equal(a.ranges.all.total.totalTokens, 20);
  assert.equal(a.generatedAt, b.generatedAt);
  t.mock.timers.tick(interval - 1);
  await settle();
  assert.equal(scans, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(scans, 3);
});

test("background failure preserves the last snapshot, marks it stale, and retries", async (t) => {
  let fail = false;
  const errors = [];
  const service = setup(t, async () => {
    if (fail) throw new Error("read failed");
    return fixture();
  }, { onError: (error) => errors.push(error.message) });
  service.start();
  const first = await service.getSnapshot();
  fail = true;
  t.mock.timers.tick(interval);
  await settle();
  assert.deepEqual(errors, ["read failed"]);
  const stale = await service.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.generatedAt, first.generatedAt);
  assert.equal(stale.ranges, first.ranges);
  await assert.rejects(service.getSnapshot("UTC", true), /read failed/, "manual failures must not masquerade as fresh data");
  fail = false;
  t.mock.timers.tick(interval);
  await settle();
  const recovered = await service.getSnapshot();
  assert.equal(recovered.stale, undefined);
  assert.notEqual(recovered.generatedAt, first.generatedAt);
});

test("startup failure still retries in the background without an open panel", async (t) => {
  let scans = 0;
  const errors = [];
  const service = setup(t, async () => {
    if (++scans === 1) throw new Error("startup failure");
    return fixture();
  }, { onError: (error) => errors.push(error.message) });
  service.start();
  await settle();
  assert.deepEqual(errors, ["startup failure"]);
  t.mock.timers.tick(interval);
  await settle();
  assert.equal(scans, 2);
  assert.equal((await service.getSnapshot()).ranges.all.total.totalTokens, 10);
});

test("background updates advance all timezone windows at midnight even with unchanged files", async (t) => {
  const before = Date.parse("2026-09-08T15:59:50Z");
  const data = fixture(10, before - 1000);
  data.sessions[0].records.push(...fixture(20, before + 15_000).sessions[0].records);
  const service = setup(t, async () => data);
  t.mock.timers.setTime(before);
  service.start();
  const first = await service.getSnapshot("Asia/Shanghai");
  assert.equal(first.ranges.today.total.totalTokens, 10);
  assert.equal(first.ranges.all.total.totalTokens, 10, "future records are not yet included");
  t.mock.timers.tick(interval);
  await settle();
  const next = await service.getSnapshot("Asia/Shanghai");
  const utc = await service.getSnapshot("UTC");
  assert.equal(next.ranges.today.daily[0].key, "2026-09-09");
  assert.equal(next.ranges.today.total.totalTokens, 20);
  assert.equal(utc.ranges.today.total.totalTokens, 30);
  assert.equal(next.ranges.all.total.totalTokens, 30);
  assert.equal(next.generatedAt, utc.generatedAt);
  for (const [range, value] of Object.entries(next.ranges)) assert.deepEqual(value.total, next.overview[range]);
});

test("dispose cancels future refreshes and prevents late scans from publishing or rescheduling", async (t) => {
  let scans = 0;
  let release;
  const service = setup(t, async () => {
    scans++;
    await new Promise((resolve) => { release = resolve; });
    return fixture();
  });
  service.start();
  await settle();
  service.dispose();
  release();
  await settle();
  t.mock.timers.tick(interval * 10);
  await settle();
  service.start();
  assert.equal(scans, 1);
  await assert.rejects(service.getSnapshot(), /disposed/);
});

test("dispose clears an already scheduled background refresh", async (t) => {
  let scans = 0;
  const service = setup(t, async () => { scans++; return fixture(); });
  service.start();
  await service.getSnapshot();
  service.dispose();
  t.mock.timers.tick(interval * 10);
  await settle();
  assert.equal(scans, 1);
});

test("timezone snapshot retention is bounded, without rescanning on cache misses", async (t) => {
  let scans = 0;
  const service = setup(t, async () => { scans++; return fixture(); });
  const first = await service.getSnapshot("UTC");
  for (const timeZone of Intl.supportedValuesOf("timeZone").slice(0, 20)) await service.getSnapshot(timeZone);
  const next = await service.getSnapshot("UTC");
  assert.notEqual(next, first, "old timezone snapshots are evicted");
  assert.deepEqual(next, first);
  assert.equal(scans, 1);
});
