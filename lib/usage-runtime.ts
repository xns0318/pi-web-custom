import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createUsageScanner } from "./usage-scanner";
import { createUsageService, type UsageService } from "./usage-service";
import type { UsageScan } from "./usage";

const SERVICE_VERSION = 1;

declare global {
  var __piWebUsageScanner: { root: string; grouping: "cwd"; scan: () => Promise<UsageScan> } | undefined;
  var __piWebUsageService: { version: number; scan: () => Promise<UsageScan>; service: UsageService } | undefined;
}

export function getUsageService(): UsageService {
  const root = join(getAgentDir(), "sessions");
  // Invalidate older repository-grouped closures surviving development HMR.
  if (globalThis.__piWebUsageScanner?.root !== root || globalThis.__piWebUsageScanner.grouping !== "cwd") {
    globalThis.__piWebUsageScanner = { root, grouping: "cwd", scan: createUsageScanner(root) };
  }
  const { scan } = globalThis.__piWebUsageScanner;
  const existing = globalThis.__piWebUsageService;
  if (!existing || existing.scan !== scan || existing.version !== SERVICE_VERSION) {
    existing?.service.dispose();
    const service = createUsageService(scan, {
      onError: (error) => console.error("[pi-web] Background token usage refresh failed:", error),
    });
    globalThis.__piWebUsageService = { version: SERVICE_VERSION, scan, service };
    service.start();
  }
  return globalThis.__piWebUsageService!.service;
}
