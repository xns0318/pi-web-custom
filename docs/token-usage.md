# Token usage / Token 用量

Open **Usage** to the right of **Tools** in the top bar. On narrow screens,
open **More controls → Usage**. The panel works without selecting a session.

在顶部“工具”右侧点击“用量”；窄屏下从“更多控制”打开。无需先选择会话。

The provider balance/quota queries introduced in Pi Web 0.9.1 remain separate
in model settings. They query provider accounts; this panel aggregates locally
saved history. Neither replaces the other.

0.9.1 模型设置中的服务商余额/额度查询与本面板独立：前者查询服务商账户，
后者统计本地已保存的历史用量，二者都保留。

## Views

- **Overview / 概览**: today, last 7 days, last 30 days, all-time cards;
  model and project rankings for the selected range.
- **Daily / 逐日**: newest date first. Finite ranges include zero-use days.
- **By model / 按模型**: groups by both provider and model ID.
- **By project / 按项目**: groups by the working directory (`cwd`) recorded in
  each session, with name/path search. The main checkout, each linked worktree,
  and repository subdirectories are counted separately. Matching display names
  do not merge different folders; equivalent path spellings are normalized.
  This report does not use Git or the sidebar's repository/worktree resolver.
- **Range switching / 时段切换**: opening the panel loads all four ranges in
  one snapshot. Range changes are immediate local selections: no new request,
  loading placeholder, or unmounting of cards/table/search controls.
- **Background updates / 后台更新**: the server warms the statistics at startup
  and refreshes them every 30 seconds, even with the panel closed, the browser
  hidden or no browser connected. While mounted, the panel also synchronizes
  the server cache every 30 seconds, without a visibility gate. Browsers can
  throttle hidden-tab timers; this does not stop the server's background work.
- **Refresh / 刷新**: clicking Refresh immediately requests a fresh read of saved
  records, rather than waiting for the next timer or just rereading cached data.
  Slow/concurrent refreshes share one scan; the next background timer starts
  30 seconds after completion, preventing overlapping work. Existing content
  stays visible and usable, and all ranges update together on success. Failure
  preserves the last snapshot with a warning and automatic retry. The displayed
  date/time is the snapshot cutoff; background refresh also advances midnight
  calendar windows. No model calls are made. Usage must have been saved first:
  this is not a live counter of a still-streaming response's unreported Tokens.
  Hover over rounded numbers for exact Token counts.

后台每 30 秒更新，不要求打开用量面板或保持浏览器可见；手动点击“刷新”立即
触发读取，不等下一个周期。只读取已保存的用量，不调用模型，也不清空当前显示。

## Accounting rules

The source is `PI_CODING_AGENT_DIR/sessions/**/*.jsonl`, defaulting to
`~/.pi/agent/sessions`. Only regular files in the configured store are read;
symlinks are not followed. Existing saved history is available immediately.
This is a local usage report, **not an authoritative provider billing ledger**.

1. Includes persisted assistant messages, metered tool results, compactions,
   and branch summaries. All branches count, not just the active context.
   Unmetered and all-zero records do not contribute to the record count.
2. Uses reported `usage.totalTokens`, falling back to
   `input + output + cacheRead + cacheWrite` if the total is absent/zero.
   Reasoning is already part of output and is not added again. Cache Token
   are included in the total, not added on top of it.
3. Input includes context resent with each API request. This is not a count
   of unique words typed by the user or the current context window size.
4. Copies of the same metered entry in forks/clones are deduplicated globally
   using entry ID, timestamp and a payload digest. Short IDs alone are not
   globally unique. Rewired parent IDs do not affect deduplication.
   Usage is attributed to the oldest surviving session containing the entry;
   ties are resolved by path. Only new work belongs to a cross-project fork.
   Legacy records without entry IDs are counted per file/line rather than
   risking false deduplication. Context/retained-tail snapshots are not counted.
5. Today/7-day/30-day windows are inclusive calendar days in the **browser's
   IANA time zone**, including today. DST transitions do not shift boundaries.
   Each record uses its message timestamp, falling back to the entry timestamp.
   Records dated in the future are excluded.
6. Unknown model metadata is explicitly labeled. The app does not guess which
   model produced tool or summary usage. A metering record may describe several
   upstream calls; the UI deliberately says **records**, not API request count.
7. Cost uses the pricing recorded in sessions; subscriptions, discounts,
   missing prices, and provider-side billing adjustments may differ.
8. Deleted sessions and usage never persisted by Pi cannot be reconstructed.
   Failed/incomplete JSON lines or unreadable files produce a partial-data
   warning. Refresh retries files that are still being written. Nested tools
   that independently report the same work in multiple metering records cannot
   be reconciled without an upstream request ID.

中文要点：输入包含重复上下文，总量包含缓存，推理不重复相加；fork 历史去重，
摘要/压缩的真实用量计入，但上下文大小不作为消耗。按浏览器时区的自然日统计。
按会话记录的工作目录分别统计，主仓库、各 worktree 和子目录不合并，不依赖 Git 版本。
记录数不等于 API 调用次数，费用只是会话中的估算值；删除或未保存的用量无法还原。

## Implementation

- `lib/usage-scanner.ts`: read-only streaming scanner; bounded file concurrency;
  in-memory per-file metric cache keyed by inode/size/mtime/ctime. Revalidates
  every refresh and handles append, rewrite and deletion. No prompt text is
  retained in the cache, and no usage index is written to disk.
- `lib/usage.ts`: pure single-pass aggregation of all four ranges, shared API
  types, and an O(1) selector that reuses the snapshot's existing row arrays.
- `lib/usage-service.ts`: process-wide, completion-scheduled background refresh;
  shared in-flight work, atomic snapshots, last-successful-data fallback and a
  bounded LRU of 16 timezone snapshots. Unchanged files still get new calendar
  windows. The timer is unreferenced so it cannot prevent process shutdown.
- `lib/usage-runtime.ts` and `instrumentation.ts`: start the service independently
  of usage requests during Node server startup (not production build), reuse it
  across API clients/HMR and dispose older loops when scanner/root/version changes.
  This requires the existing long-running Node server, not a serverless platform
  that suspends work between requests. Nothing runs when the service is stopped.
- `app/api/usage/route.ts`: the UI requests
  `GET /api/usage?view=snapshot&timeZone=Asia%2FShanghai` on opening and every 30s.
  Normal reads use the background cache; `&refresh=1` forces an immediate scan
  (or joins the current scan). This returns shared `generatedAt`, `timeZone`,
  `overview`, `coverage` and a `ranges` map with each range's total/daily/model/
  project breakdown. `stale: true` marks cached results after background failure;
  a failed forced refresh returns HTTP 500 rather than pretending to be fresh.
  Existing single-range callers remain supported:
  `GET /api/usage?range=30d&timeZone=Asia%2FShanghai`.
  Ranges: `today`, `7d`, `30d`, `all`; default time zone: `UTC`.
  Validates parameters, returns `Cache-Control: no-store`, and uses the existing
  request-origin/host and password-login cookie / Basic API Auth proxy checks.
  The caller cannot select
  arbitrary filesystem paths through this endpoint.
- `components/UsagePanel.tsx`: responsive, localized dropdown with loading,
  empty, partial-data and retry states, keyboard tabs and Escape-to-close.
  Client requests cannot overlap; a 60s timeout bounds waiting. Unmount cancels
  client timers/listeners/requests only, never the server's background service.
- `components/AppShell.tsx`: toolbar button and single-active-panel integration.

## Verification

```bash
node --test lib/usage*.test.mjs app/api/usage/route.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
# Against an already-running isolated dev or production checkout:
USAGE_E2E_URL=http://127.0.0.1:30142 node e2e/usage.mjs
USAGE_E2E_URL=http://127.0.0.1:30142 node e2e/usage-switching.mjs
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects a local Chromium binary.
The E2E test reads session metadata only and never prompts the model. It writes
screenshots under `test-results/usage/`. The switching regression uses synthetic
snapshots and a deliberately held/failed refresh to verify zero range-switch
requests, stable DOM/focus, preserved search text and correct range data. Its
virtual clock also checks 30s updates, hidden-tab synchronization, immediate
manual refresh, retry/stale states and cleanup after closing/reopening. Service
unit tests verify updates without any browser/API reads, slow-scan coalescing,
cache bypass, failure recovery, midnight rollover and bounded timezone retention.

Follow [development notes](../AGENTS.md) and the [release checklist](release.md):
never build in an active development checkout. Stage production artifacts in a
separate directory and restart only after active agent work has finished.
