// Deterministic regression: range switches must be local and keep content mounted,
// even while a refresh is slow or fails. Also covers periodic/hidden-tab sync,
// immediate manual refresh and cleanup. No real session data or model calls used.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { aggregateUsageSnapshot, emptyUsage, formatUsageTokens, selectUsageRange, USAGE_RANGES } = await jiti.import("../lib/usage.ts");
const base = process.env.USAGE_E2E_URL || "http://127.0.0.1:30142";
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ locale: "en", timezoneId: "Asia/Shanghai", viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

function fixture(multiplier = 1) {
  const dates = ["2026-08-01", "2026-08-21", "2026-09-04", "2026-09-08"];
  return aggregateUsageSnapshot({
    unreadableFiles: 0, skippedLines: 0,
    sessions: [{ path: "fixture", created: 0, project: "/demo", projectKey: "/demo", records: dates.map((day, index) => ({
      ...emptyUsage(), key: day, timestamp: Date.parse(`${day}T00:00:00Z`), kind: "assistant", model: "test-model", provider: "test",
      input: (index + 1) * 100 * multiplier, totalTokens: (index + 1) * 100 * multiplier, records: 1,
    })) }],
  }, { now: Date.parse("2026-09-08T10:00:00Z") + multiplier * 1000, timeZone: "Asia/Shanghai" });
}

const first = fixture();
const second = fixture(2);
let nextReply = { snapshot: first, status: 200 };
let requests = 0;
const requestParams = [];
const pendingReleases = [];
function holdRefresh(snapshot) {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const start = new Promise((resolve) => { started = resolve; });
  nextReply = { snapshot, status: 200, gate, started };
  pendingReleases.push(release);
  return { release, start };
}

try {
  await page.clock.install({ time: new Date("2026-09-08T10:00:00Z") });
  // Empty catalogue avoids the unrelated asynchronous initial project restore
  // closing the global dropdown while the test is starting.
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [], sessionListVersion: 0 } }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [], sessionListVersion: 0 } }));
  await page.route("**/api/agent/running", (route) => route.fulfill({ json: { runningSessionIds: [], sessionListVersion: 0 } }));
  await page.route("**/api/usage?*", async (route) => {
    requests++;
    const reply = nextReply;
    reply.started?.();
    await reply.gate;
    const params = new URL(route.request().url()).searchParams;
    requestParams.push(params);
    // Legacy responses allow this regression test to expose the old flashing
    // implementation, instead of failing only because its API shape differs.
    const payload = params.get("view") === "snapshot" ? reply.snapshot : selectUsageRange(reply.snapshot, params.get("range") || "30d");
    await route.fulfill({ status: reply.status, json: reply.status === 200 ? payload : { error: "simulated refresh failure" } });
  });
  await page.goto(base, { waitUntil: "networkidle" });
  // Pause before opening usage; later timer checks need no real 30s sleeps.
  await page.clock.pauseAt(new Date("2026-09-08T11:00:00Z"));
  await page.getByRole("button", { name: "Token usage", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Token usage", exact: true });
  await panel.locator(".usage-card").first().waitFor();
  // Development Strict Mode can start and abort an extra mount request.
  // The regression is zero additional requests for range switches.
  const initialRequests = requests;
  assert.ok(initialRequests >= 1);
  if (process.env.E2E_SERVER_MODE === "start") assert.equal(initialRequests, 1);

  await panel.evaluate((element) => {
    window.usageOriginalContent = element.querySelector("#usage-content");
    window.usageOriginalCards = [...element.querySelectorAll(".usage-card")];
  });
  const assertContentMounted = async () => {
    assert.equal(await page.evaluate(() => window.usageOriginalContent.isConnected), true, "content must not be unmounted");
    assert.equal(await panel.locator("#usage-content").isVisible(), true);
    assert.equal(await panel.locator(":scope > .usage-empty").count(), 0, "no loading placeholder after first load");
  };
  const assertCardsMounted = async () => {
    await assertContentMounted();
    assert.equal(await page.evaluate(() => window.usageOriginalCards.every((card) => card.isConnected)), true, "cards retain their DOM/focus");
  };
  const assertTotal = async (snapshot, range) => {
    assert.equal(await panel.locator(".usage-period-total strong").innerText(), `${formatUsageTokens(snapshot.ranges[range].total.totalTokens)} tok`);
  };

  // Clicking the overview cards updates breakdowns immediately; no requests,
  // no spinner, no detached DOM and no loss of focus, even on a cold range.
  for (const range of ["today", "7d", "all", "30d", "today", "all"]) {
    const card = panel.locator(".usage-card").nth(USAGE_RANGES.indexOf(range));
    await card.click();
    await assertCardsMounted();
    assert.equal(await card.getAttribute("aria-pressed"), "true");
    assert.equal(await card.evaluate((element) => element === document.activeElement), true);
    assert.equal(await panel.locator(".usage-chip strong").first().innerText(), formatUsageTokens(first.ranges[range].total.totalTokens));
    assert.equal(await panel.getByRole("button", { name: "Refresh", exact: true }).isEnabled(), true);
    assert.equal(requests, initialRequests, "switching a range must not fetch");
  }

  // Select menus use the same instant path; search and table nodes survive.
  await panel.getByRole("tab", { name: "By project", exact: true }).click();
  await panel.getByRole("searchbox").fill("demo");
  await panel.evaluate((element) => {
    window.usageOriginalTable = element.querySelector(".usage-table");
    window.usageOriginalSearch = element.querySelector(".usage-search");
  });
  for (const range of USAGE_RANGES) {
    await panel.getByRole("combobox", { name: "Time range" }).selectOption(range);
    await assertContentMounted();
    await assertTotal(first, range);
    assert.equal(await page.evaluate(() => window.usageOriginalTable.isConnected && window.usageOriginalSearch.isConnected), true);
    assert.equal(await panel.getByRole("searchbox").inputValue(), "demo");
    assert.equal(requests, initialRequests);
  }

  // Hold refresh indefinitely while rapidly switching; all ranges still refer
  // to the prior complete snapshot until one atomic successful replacement.
  const slow = holdRefresh(second);
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await slow.start;
  assert.equal(requests, initialRequests + 1);
  await panel.locator('#usage-content[aria-busy="true"]').waitFor();
  for (const range of ["today", "all", "7d"]) {
    await panel.getByRole("combobox", { name: "Time range" }).selectOption(range);
    await assertContentMounted();
    await assertTotal(first, range);
    assert.equal(requests, initialRequests + 1);
  }
  slow.release();
  await panel.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  await assertContentMounted();
  await assertTotal(second, "7d");
  assert.equal(await panel.getByRole("combobox").inputValue(), "7d");
  await panel.getByRole("combobox").selectOption("today");
  await assertTotal(second, "today");
  assert.equal(requests, initialRequests + 1, "refresh publishes every range, not only the active one");

  // Failure keeps all cached ranges usable. Retry replaces them together.
  nextReply = { snapshot: second, status: 500 };
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(requests, initialRequests + 2);
  await panel.getByRole("combobox").selectOption("all");
  await assertTotal(second, "all");
  await assertContentMounted();
  assert.equal(requests, initialRequests + 2);
  const third = fixture(3);
  nextReply = { snapshot: third, status: 200 };
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await panel.getByRole("alert").waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  await assertTotal(third, "all");
  await assertContentMounted();
  assert.equal(requests, initialRequests + 3);
  assert.equal(requestParams.at(-1).get("refresh"), "1", "manual refresh must bypass the server cache");

  const waitForTotal = async (snapshot, range = "all") => {
    await panel.locator(".usage-period-total").getByText(`${formatUsageTokens(snapshot.ranges[range].total.totalTokens)} tok`, { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Refresh", exact: true }).waitFor();
    await assertContentMounted();
    assert.equal(await page.evaluate(() => window.usageOriginalTable.isConnected && window.usageOriginalSearch.isConnected), true);
    assert.equal(await panel.getByRole("searchbox").inputValue(), "demo");
  };
  let checkpoint = requests;
  const fourth = fixture(4);
  nextReply = { snapshot: fourth, status: 200 };
  await panel.getByRole("searchbox").focus();
  await page.clock.runFor(29_999);
  assert.equal(requests, checkpoint);
  await page.clock.runFor(1);
  await waitForTotal(fourth);
  assert.equal(requests, checkpoint + 1, "one automatic sync after 30 seconds");
  assert.equal(requestParams.at(-1).has("refresh"), false, "automatic reads use the server's background cache");
  assert.equal(await panel.getByRole("searchbox").evaluate((element) => element === document.activeElement), true);

  // Hidden tabs are NOT a gate. Server refresh is independently covered by the
  // service tests; the browser can keep syncing when its timers are allowed to run.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const fifth = fixture(5);
  nextReply = { snapshot: fifth, status: 200 };
  await page.clock.runFor(30_000);
  await waitForTotal(fifth);
  assert.equal(requests, checkpoint + 2, "hidden tabs still synchronize");

  // Slow reads cannot overlap or clear existing content. Reconnect events also
  // coalesce with the pending request rather than issuing a duplicate.
  const sixth = fixture(6);
  const automatic = holdRefresh(sixth);
  await page.clock.runFor(30_000);
  await automatic.start;
  await page.clock.runFor(45_000);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  assert.equal(requests, checkpoint + 3);
  await panel.locator('#usage-content[aria-busy="true"]').waitFor();
  await panel.getByRole("combobox").selectOption("today");
  await assertTotal(fifth, "today");
  await assertContentMounted();
  automatic.release();
  await waitForTotal(sixth, "today");

  // Failed automatic reads preserve content and retry on the next interval.
  nextReply = { snapshot: sixth, status: 500 };
  await page.clock.runFor(30_000);
  await panel.getByRole("alert").waitFor();
  await assertTotal(sixth, "today");
  await assertContentMounted();
  const seventh = fixture(7);
  nextReply = { snapshot: { ...seventh, stale: true }, status: 200 };
  await page.clock.runFor(30_000);
  await waitForTotal(seventh, "today");
  assert.ok((await panel.getByRole("alert").innerText()).includes("last successful snapshot"));
  const eighth = fixture(8);
  nextReply = { snapshot: eighth, status: 200 };
  await page.clock.runFor(30_000);
  await waitForTotal(eighth, "today");
  await panel.getByRole("alert").waitFor({ state: "hidden" });
  assert.equal(requests, checkpoint + 6);

  // Manual refresh does not wait for the next automatic deadline.
  checkpoint = requests;
  await page.clock.runFor(1000);
  const ninth = fixture(9);
  nextReply = { snapshot: ninth, status: 200 };
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitForTotal(ninth, "today");
  assert.equal(requests, checkpoint + 1);
  assert.equal(requestParams.at(-1).get("refresh"), "1");
  await page.clock.runFor(29_999);
  assert.equal(requests, checkpoint + 1);

  // Closing cancels only this panel's network work. No leaked timer or online
  // listener; a late result cannot overwrite a newly opened panel's snapshot.
  const closing = holdRefresh(fixture(10));
  await page.clock.runFor(1);
  await closing.start;
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  checkpoint = requests;
  await page.clock.runFor(90_000);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
  });
  assert.equal(requests, checkpoint, "closed panel must leave no client polling behind");
  const eleventh = fixture(11);
  nextReply = { snapshot: eleventh, status: 200 };
  await page.getByRole("button", { name: "Token usage", exact: true }).click();
  await panel.locator(".usage-card").last().getByText(`${formatUsageTokens(eleventh.ranges.all.total.totalTokens)} tok`, { exact: true }).waitFor();
  assert.equal(requestParams.at(-1).has("refresh"), false, "reopening uses the latest background snapshot");
  closing.release();
  checkpoint = requests;
  const twelfth = fixture(12);
  nextReply = { snapshot: twelfth, status: 200 };
  await page.clock.runFor(30_000);
  await panel.locator(".usage-card").last().getByText(`${formatUsageTokens(twelfth.ranges.all.total.totalTokens)} tok`, { exact: true }).waitFor();
  assert.equal(requests, checkpoint + 1, "only the new panel's timer survives");
  assert.deepEqual(errors, []);
  console.log("Usage regression passed: local range switching, stable DOM/focus, 30s and hidden-tab sync, immediate manual refresh, failures and cleanup.");
} finally {
  for (const release of pendingReleases) release();
  await browser.close();
}
