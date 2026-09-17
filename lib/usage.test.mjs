import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { aggregateUsage, aggregateUsageSnapshot, selectUsageRange, USAGE_RANGES, emptyUsage, formatUsageTokens } = await jiti.import("./usage.ts");

const now = Date.parse("2026-09-08T10:00:00Z");
function record(key, timestamp, extra = {}) {
  return { ...emptyUsage(), key, timestamp: Date.parse(timestamp), kind: "assistant", provider: "test", model: "model", input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180, cost: 0.01, records: 1, ...extra };
}
function session(path, records, extra = {}) {
  return { path, created: 0, project: "/work/project", projectKey: "/work/project", records, ...extra };
}
function scan(sessions) { return { sessions, unreadableFiles: 0, skippedLines: 0 }; }

test("today/7d/30d use browser calendar boundaries, including today; future records are excluded", () => {
  const records = [
    record("old", "2026-08-09T15:59:59Z"),
    record("30d", "2026-08-09T16:00:00Z"), // Aug 10, first day in 30-day window
    record("before7d", "2026-09-01T15:59:59Z"),
    record("7d", "2026-09-01T16:00:00Z"), // Sep 2, first day in 7-day window
    record("yesterday", "2026-09-07T15:59:59Z"),
    record("today", "2026-09-07T16:00:00Z"),
    record("future", "2026-09-08T11:00:00Z"),
  ];
  const result = aggregateUsage(scan([session("one", records)]), { timeZone: "Asia/Shanghai", range: "7d", now });
  assert.deepEqual(Object.values(result.overview).map((total) => total.records), [1, 3, 5, 6]);
  assert.equal(result.daily.length, 7);
  assert.equal(result.daily[0].key, "2026-09-08");
  assert.equal(result.daily.at(-1).key, "2026-09-02");
  assert.equal(result.daily.find((row) => row.key === "2026-09-03").totalTokens, 0);
  for (const rows of [result.daily, result.models, result.projects]) {
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "records"]) {
      assert.equal(rows.reduce((sum, row) => sum + row[field], 0), result.total[field], field);
    }
  }
});

test("DST transition does not shift a seven-calendar-day window", () => {
  const result = aggregateUsage(scan([session("dst", [
    record("before", "2026-03-02T04:59:59Z"),
    record("start", "2026-03-02T05:00:00Z"),
    record("spring", "2026-03-08T07:01:00Z"),
  ])]), { timeZone: "America/New_York", range: "7d", now: Date.parse("2026-03-08T12:00:00Z") });
  assert.equal(result.total.records, 2);
  assert.equal(result.daily.at(-1).key, "2026-03-02");
  assert.equal(result.overview.today.records, 1);
});

test("fork history belongs to the oldest surviving project; all branches and new fork work count", () => {
  const shared = record("shared", "2026-09-07T00:00:00Z");
  const result = aggregateUsage(scan([
    session("fork", [shared, record("new", "2026-09-08T00:00:00Z")], { created: 2, project: "/work/fork", projectKey: "fork" }),
    session("source", [shared, record("branch1", "2026-09-07T01:00:00Z"), record("branch2", "2026-09-07T02:00:00Z")], { created: 1 }),
  ]), { range: "all", now });
  assert.equal(result.total.records, 4);
  assert.equal(result.coverage.duplicateRecords, 1);
  assert.equal(result.projects[0].label, "project");
  assert.equal(result.projects[0].records, 3);
  assert.equal(result.projects[1].records, 1);
  const orphan = aggregateUsage(scan([session("fork", [shared])]), { range: "all", now });
  assert.equal(orphan.total.records, 1);
});

test("same project basenames and same model names from different providers are separate", () => {
  const result = aggregateUsage(scan([
    session("one", [record("one", "2026-09-08T00:00:00Z")], { project: "/a/project", projectKey: "/a/project" }),
    session("two", [record("two", "2026-09-08T00:00:00Z", { provider: "other" })], { project: "/b/project", projectKey: "/b/project" }),
    session("three", [record("summary", "2026-09-08T00:00:00Z", { provider: "", model: "", kind: "summary" })]),
  ]), { now });
  assert.equal(result.models.length, 3);
  assert.equal(result.projects.length, 3);
  assert.ok(result.models.some((row) => row.label === "usage.summaryModel"));
});

test("empty and all-time responses are deterministic, with zero-filled finite ranges", () => {
  const result = aggregateUsage(scan([]), { now });
  assert.equal(result.daily.length, 30);
  assert.deepEqual(result.total, emptyUsage());
  assert.deepEqual(result.projects, []);
  assert.deepEqual(aggregateUsage(scan([]), { range: "all", now }).daily, []);
  assert.throws(() => aggregateUsage(scan([]), { timeZone: "invalid", now }), RangeError);
  assert.equal(formatUsageTokens(0), "0");
  assert.equal(formatUsageTokens(1500), "1.5K");
  assert.equal(formatUsageTokens(1500000), "1.50M");
  assert.equal(formatUsageTokens(1500000000), "1.50B");
});

test("one scan produces all ranges with a shared clock, coverage and deduplication", () => {
  const shared = record("today", "2026-09-08T00:00:00Z");
  const records = [
    record("old", "2026-08-01T00:00:00Z"),
    record("month", "2026-08-21T00:00:00Z"),
    record("week", "2026-09-04T00:00:00Z"),
    shared,
    record("future", "2026-09-09T00:00:00Z"),
  ];
  let recordListReads = 0;
  const source = session("source", records);
  Object.defineProperty(source, "records", { get() { recordListReads++; return records; } });
  const snapshot = aggregateUsageSnapshot(scan([source, session("fork", [shared], { created: 1 })]), { now, timeZone: "Asia/Shanghai" });
  assert.equal(recordListReads, 1, "records are not rescanned for each range");
  assert.deepEqual(Object.keys(snapshot.ranges), USAGE_RANGES);
  assert.equal(snapshot.coverage.duplicateRecords, 1);
  const before = JSON.stringify(snapshot);
  for (const [index, range] of USAGE_RANGES.entries()) {
    const selected = selectUsageRange(snapshot, range);
    assert.equal(selected.range, range);
    assert.equal(selected.generatedAt, new Date(now).toISOString());
    assert.equal(selected.timeZone, "Asia/Shanghai");
    assert.equal(selected.total.records, index + 1);
    assert.equal(selected.total.totalTokens, 180 * (index + 1));
    assert.deepEqual(selected.total, snapshot.overview[range]);
    assert.equal(selected.daily.length, [1, 7, 30, 4][index]);
    for (const field of ["daily", "models", "projects"]) {
      assert.equal(selected[field], snapshot.ranges[range][field], "switching reuses the existing rows");
      assert.equal(selected[field].reduce((sum, row) => sum + row.totalTokens, 0), selected.total.totalTokens);
    }
  }
  assert.equal(recordListReads, 1, "local range selection does no aggregation");
  assert.equal(JSON.stringify(snapshot), before, "selection does not mutate the snapshot");
});

test("refresh replaces all calendar windows together at midnight; the prior snapshot stays immutable", () => {
  const input = scan([session("one", [record("late", "2026-09-08T15:59:30Z")])]);
  const previous = aggregateUsageSnapshot(input, { timeZone: "Asia/Shanghai", now: Date.parse("2026-09-08T15:59:59Z") });
  const next = aggregateUsageSnapshot(input, { timeZone: "Asia/Shanghai", now: Date.parse("2026-09-08T16:00:01Z") });
  assert.equal(previous.overview.today.records, 1);
  assert.equal(previous.ranges.today.daily[0].key, "2026-09-08");
  assert.equal(next.overview.today.records, 0);
  assert.equal(next.ranges.today.daily[0].key, "2026-09-09");
  assert.equal(next.ranges["7d"].total.records, 1);
  assert.equal(next.ranges["7d"].daily.at(-1).key, "2026-09-03");
});
