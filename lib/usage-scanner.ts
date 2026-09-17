import { createHash } from "node:crypto";
import fs, { type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { projectIdentityKey } from "./project-identity";
import type { UsageRecord, UsageScan, UsageSession, UsageTotals } from "./usage";

type Raw = Record<string, unknown>;
function object(value: unknown): Raw | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Raw : null;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function time(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeUsage(value: unknown): UsageTotals | null {
  const usage = object(value);
  if (!usage) return null;
  const input = Math.floor(positive(usage.input));
  const output = Math.floor(positive(usage.output));
  const cacheRead = Math.floor(positive(usage.cacheRead));
  const cacheWrite = Math.floor(positive(usage.cacheWrite));
  // Reasoning is part of output, and caches are already in totalTokens.
  const totalTokens = Math.floor(positive(usage.totalTokens)) || input + output + cacheRead + cacheWrite;
  const costs = object(usage.cost);
  const cost = costs ? positive(costs.total) || ["input", "output", "cacheRead", "cacheWrite"]
    .reduce((sum, key) => sum + positive(costs[key]), 0) : 0;
  if (!totalTokens && !cost) return null; // Unmetered/zero-use failed responses.
  return { input, output, cacheRead, cacheWrite, totalTokens, cost, records: 1 };
}

interface ScannedFile {
  cwd: string;
  created: number;
  records: UsageRecord[];
  skippedLines: number;
}
interface CachedFile { fingerprint: string; file: ScannedFile }
function fingerprint(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

async function scanFile(path: string, size: number): Promise<ScannedFile | null> {
  if (!size) return null;
  const stream = fs.createReadStream(path, { encoding: "utf8", end: size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: Raw | null = null;
  let skippedLines = 0;
  let lineNumber = 0;
  const records: UsageRecord[] = [];
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let entry: Raw | null;
      try { entry = object(JSON.parse(line)); } catch { skippedLines++; continue; }
      if (!entry) { skippedLines++; continue; }
      if (!header) {
        if (entry.type !== "session" || !text(entry.cwd)) return null;
        header = entry;
        continue;
      }
      const message = object(entry.message);
      const kind = entry.type === "message" && message?.role === "assistant" ? "assistant"
        : entry.type === "message" && message?.role === "toolResult" ? "tool"
          : entry.type === "compaction" || entry.type === "branch_summary" ? "summary" : null;
      if (!kind) continue;
      const payload = kind === "summary" ? entry : message!;
      const usage = normalizeUsage(payload.usage);
      if (!usage) continue;
      const timestamp = time(payload.timestamp) ?? time(entry.timestamp);
      if (timestamp === null) { skippedLines++; continue; }
      // Do not visit retainedTail/context snapshots: their historical usage is
      // already represented by the original entries. Hash content too because
      // Pi's short entry IDs are not globally unique. Exclude rewired parentIds.
      const identity = kind === "summary"
        ? [entry.summary, entry.usage, entry.provider, entry.model]
        : message;
      const key = createHash("sha256").update(JSON.stringify([
        text(entry.id) || [path, lineNumber], entry.type, entry.timestamp, identity,
      ])).digest("hex");
      records.push({
        ...usage, key, timestamp, kind,
        provider: text(payload.provider), model: text(payload.model),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return header ? { cwd: text(header.cwd), created: time(header.timestamp) ?? Number.MAX_SAFE_INTEGER, records, skippedLines } : null;
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

/** Read-only, per-file metric cache; never keeps prompts, tool output or credentials. */
export function createUsageScanner(sessionsDir: string): () => Promise<UsageScan> {
  const cache = new Map<string, CachedFile>();
  let inFlight: Promise<UsageScan> | undefined;

  async function scan(): Promise<UsageScan> {
    const paths: string[] = [];
    let unreadableFiles = 0;
    const pending = [sessionsDir];
    while (pending.length) {
      const dir = pending.pop()!;
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          // Do not follow symlinks out of the session store or into cycles.
          if (entry.isDirectory()) pending.push(path);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
        }
      } catch (error) {
        if (dir === sessionsDir) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache.clear(); return { sessions: [], unreadableFiles: 0, skippedLines: 0 }; }
          throw error;
        }
        unreadableFiles++;
      }
    }
    const live = new Set(paths);
    for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
    const files = await mapLimited(paths.sort(), async (path) => {
      try {
        const before = await stat(path);
        const fp = fingerprint(before);
        let file = cache.get(path)?.fingerprint === fp ? cache.get(path)!.file : null;
        if (!file) {
          file = await scanFile(path, before.size);
          if (!file) { cache.delete(path); unreadableFiles++; return null; }
          // An active session can append or be fully rewritten during the scan.
          // Only cache a stable snapshot; next refresh retries unstable files.
          const after = await stat(path);
          if (fingerprint(after) === fp) cache.set(path, { fingerprint: fp, file });
          else cache.delete(path);
        }
        return { path, file };
      } catch {
        cache.delete(path);
        unreadableFiles++;
        return null;
      }
    });
    const sessions: UsageSession[] = [];
    let skippedLines = 0;
    for (const result of files) {
      if (!result) continue;
      const { path, file } = result;
      // Usage belongs to the recorded working directory. Keep main checkouts,
      // linked worktrees and subdirectories separate, without consulting Git.
      const project = file.cwd;
      skippedLines += file.skippedLines;
      sessions.push({ path, created: file.created, project, projectKey: projectIdentityKey(project), records: file.records });
    }
    return { sessions, unreadableFiles, skippedLines };
  }

  return () => {
    inFlight ??= scan().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
