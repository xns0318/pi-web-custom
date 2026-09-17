export type UsageRange = "today" | "7d" | "30d" | "all";
export const USAGE_RANGES: UsageRange[] = ["today", "7d", "30d", "all"];
export const USAGE_REFRESH_INTERVAL_MS = 30_000;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  /** Persisted metering records, not necessarily individual upstream requests. */
  records: number;
}

export interface UsageRecord extends UsageTotals {
  key: string;
  timestamp: number;
  provider: string;
  model: string;
  kind: "assistant" | "tool" | "summary";
}

export interface UsageSession {
  path: string;
  created: number;
  project: string;
  projectKey: string;
  records: UsageRecord[];
}

export interface UsageRow extends UsageTotals {
  key: string;
  label: string;
  detail?: string;
}

export interface UsageScan {
  sessions: UsageSession[];
  unreadableFiles: number;
  skippedLines: number;
}

export interface UsageBreakdown {
  total: UsageTotals;
  daily: UsageRow[];
  models: UsageRow[];
  projects: UsageRow[];
}

interface UsageSnapshotInfo {
  /** The last background refresh failed; this is the last successful snapshot. */
  stale?: boolean;
  generatedAt: string;
  timeZone: string;
  overview: Record<UsageRange, UsageTotals>;
  coverage: {
    sessions: number;
    duplicateRecords: number;
    unreadableFiles: number;
    skippedLines: number;
  };
}

/** All ranges share one scan and clock; switching ranges needs no new request. */
export interface UsageSnapshot extends UsageSnapshotInfo {
  ranges: Record<UsageRange, UsageBreakdown>;
}

export interface UsageReport extends UsageSnapshotInfo, UsageBreakdown {
  range: UsageRange;
}

export function selectUsageRange(snapshot: UsageSnapshot, range: UsageRange): UsageReport {
  const { ranges, ...info } = snapshot;
  return { ...info, range, ...ranges[range] };
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, records: 0 };
}

export function addUsage(target: UsageTotals, usage: UsageTotals): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost += usage.cost;
  target.records += usage.records;
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

function dateKey(formatter: Intl.DateTimeFormat, timestamp: number): string {
  const parts = formatter.formatToParts(timestamp);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Shift calendar labels, not instants: subtracting 24 hours fails across DST.
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function projectName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

export function aggregateUsageSnapshot(
  scan: UsageScan,
  { timeZone = "UTC", now = Date.now() }: { timeZone?: string; now?: number } = {},
): UsageSnapshot {
  const formatter = dayFormatter(timeZone);
  const today = dateKey(formatter, now);
  const starts = { today, "7d": shiftDay(today, -6), "30d": shiftDay(today, -29), all: "" };
  const overview = Object.fromEntries(USAGE_RANGES.map((key) => [key, emptyUsage()])) as Record<UsageRange, UsageTotals>;
  const buckets = Object.fromEntries(USAGE_RANGES.map((key) => [key, {
    daily: new Map<string, UsageRow>(), models: new Map<string, UsageRow>(), projects: new Map<string, UsageRow>(),
  }])) as Record<UsageRange, { daily: Map<string, UsageRow>; models: Map<string, UsageRow>; projects: Map<string, UsageRow> }>;
  const seen = new Set<string>();
  let duplicateRecords = 0;

  function collect(map: Map<string, UsageRow>, key: string, label: string, usage: UsageTotals, detail?: string) {
    let row = map.get(key);
    if (!row) {
      row = { key, label, ...(detail ? { detail } : {}), ...emptyUsage() };
      map.set(key, row);
    }
    addUsage(row, usage);
  }

  // Fork/clone headers are newer than their source. Attribute copied history to
  // the oldest surviving session, including when the fork moved to a new cwd.
  const sessions = [...scan.sessions].sort((a, b) => a.created - b.created || a.path.localeCompare(b.path));
  for (const session of sessions) {
    for (const record of session.records) {
      if (seen.has(record.key)) {
        duplicateRecords++;
        continue;
      }
      seen.add(record.key);
      if (record.timestamp > now) continue;
      const day = dateKey(formatter, record.timestamp);
      // Summary/tool records without explicit model metadata stay separate;
      // guessing the last selected model would invent attribution.
      const modelKey = JSON.stringify([record.provider, record.model, record.model ? "" : record.kind]);
      for (const key of USAGE_RANGES) {
        if (day < starts[key]) continue;
        addUsage(overview[key], record);
        const { daily, models, projects } = buckets[key];
        collect(daily, day, day, record);
        collect(projects, session.projectKey, projectName(session.project), record, session.project);
        collect(models, modelKey, record.model || `usage.${record.kind}Model`, record, record.provider);
      }
    }
  }

  const ranked = (rows: Map<string, UsageRow>) => [...rows.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
  const ranges = Object.fromEntries(USAGE_RANGES.map((range) => {
    const { daily, models, projects } = buckets[range];
    // Include zero-use days in finite ranges, while all-time stays sparse.
    if (range !== "all") {
      for (let day = starts[range]; day <= today; day = shiftDay(day, 1)) {
        if (!daily.has(day)) daily.set(day, { key: day, label: day, ...emptyUsage() });
      }
    }
    return [range, {
      total: { ...overview[range] },
      daily: [...daily.values()].sort((a, b) => b.key.localeCompare(a.key)),
      models: ranked(models), projects: ranked(projects),
    }];
  })) as Record<UsageRange, UsageBreakdown>;
  return {
    generatedAt: new Date(now).toISOString(), timeZone, overview, ranges,
    coverage: { sessions: sessions.length, duplicateRecords, unreadableFiles: scan.unreadableFiles, skippedLines: scan.skippedLines },
  };
}

/** Backward-compatible single-range response for existing API callers. */
export function aggregateUsage(
  scan: UsageScan,
  { range = "30d", ...options }: { timeZone?: string; range?: UsageRange; now?: number } = {},
): UsageReport {
  return selectUsageRange(aggregateUsageSnapshot(scan, options), range);
}

export function formatUsageTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
