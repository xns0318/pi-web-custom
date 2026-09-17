import { aggregateUsageSnapshot, USAGE_REFRESH_INTERVAL_MS, type UsageScan, type UsageSnapshot } from "./usage";

const MAX_TIME_ZONES = 16;

/** One process-wide background loop, independent of browser/panel visibility. */
export function createUsageService(
  scan: () => Promise<UsageScan>,
  { now = () => Date.now(), intervalMs = USAGE_REFRESH_INTERVAL_MS, onError = () => {} }: {
    now?: () => number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  } = {},
) {
  let current: { scan: UsageScan; at: number } | null = null;
  let snapshots = new Map<string, UsageSnapshot>();
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let disposed = false;
  let failed = false;

  function refresh(): Promise<void> {
    if (disposed) return Promise.reject(new Error("Usage service disposed"));
    if (inFlight) return inFlight;
    clearTimeout(timer);
    inFlight = Promise.resolve().then(scan).then((result) => {
      if (disposed) return;
      const at = now();
      // Prepare all recently requested time zones before publishing the new
      // generation. Even unchanged files need new midnight/calendar windows.
      const next = new Map<string, UsageSnapshot>();
      for (const timeZone of snapshots.size ? snapshots.keys() : ["UTC"]) {
        next.set(timeZone, aggregateUsageSnapshot(result, { timeZone, now: at }));
      }
      current = { scan: result, at };
      snapshots = next;
      failed = false;
    }).catch((error: unknown) => {
      failed = true;
      throw error;
    }).finally(() => {
      inFlight = null;
      // Completion-based scheduling prevents slow scans from overlapping or
      // piling up. Manual refresh resets the next background refresh deadline.
      if (started && !disposed) {
        timer = setTimeout(() => { void refresh().catch(onError); }, intervalMs);
        timer.unref?.();
      }
    });
    return inFlight;
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      void refresh().catch(onError);
    },
    async getSnapshot(timeZone = "UTC", fresh = false): Promise<UsageSnapshot> {
      if (disposed) throw new Error("Usage service disposed");
      if (fresh || !current) await refresh();
      if (disposed || !current) throw new Error("Usage service unavailable");
      let snapshot = snapshots.get(timeZone);
      if (!snapshot) snapshot = aggregateUsageSnapshot(current.scan, { timeZone, now: current.at });
      // Bound retained timezone snapshots (LRU), even for many API clients.
      snapshots.delete(timeZone);
      snapshots.set(timeZone, snapshot);
      if (snapshots.size > MAX_TIME_ZONES) snapshots.delete(snapshots.keys().next().value!);
      return failed ? { ...snapshot, stale: true } : snapshot;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      current = null;
      snapshots.clear();
      // A read already in progress may finish, but cannot publish or reschedule.
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
