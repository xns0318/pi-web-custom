// Read-only UI smoke test against an already-running, isolated checkout.
// USAGE_E2E_URL=http://127.0.0.1:30142 node e2e/usage.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.USAGE_E2E_URL || "http://127.0.0.1:30142";
const artifacts = new URL("../test-results/usage/", import.meta.url).pathname;
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  const api = await context.request.get(`${base}/api/usage?range=30d&timeZone=Asia%2FShanghai`);
  assert.equal(api.status(), 200);
  assert.equal(api.headers()["cache-control"], "no-store");
  const report = await api.json();
  for (const rows of [report.daily, report.projects, report.models]) {
    assert.equal(rows.reduce((sum, row) => sum + row.totalTokens, 0), report.total.totalTokens);
  }
  const snapshotResponse = await context.request.get(`${base}/api/usage?view=snapshot&timeZone=Asia%2FShanghai`);
  assert.equal(snapshotResponse.status(), 200);
  const snapshot = await snapshotResponse.json();
  assert.deepEqual(Object.keys(snapshot.ranges), ["today", "7d", "30d", "all"]);
  assert.equal((await context.request.get(`${base}/api/usage?range=invalid`)).status(), 400);
  assert.equal((await context.request.get(`${base}/api/usage?timeZone=invalid`)).status(), 400);
  assert.equal((await context.request.get(`${base}/api/usage`, { headers: { Origin: "https://untrusted.invalid" } })).status(), 403);

  // Usage is independent of session selection. Avoid the asynchronous initial
  // workspace restore closing the dropdown after the test has already opened it.
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [], sessionListVersion: 0 } }));
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [], sessionListVersion: 0 } }));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Token 用量", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Token 用量" });
  await panel.locator(".usage-card").first().waitFor();
  assert.equal(await panel.locator(".usage-card").count(), 4);
  await page.screenshot({ path: `${artifacts}/overview.png` });

  await panel.getByRole("tab", { name: "逐日", exact: true }).click();
  assert.equal(await panel.locator("tbody tr").count(), 30);
  await panel.getByRole("combobox", { name: "统计时段" }).selectOption("7d");
  await page.waitForFunction(() => document.querySelectorAll(".usage-table tbody tr").length === 7);
  await page.screenshot({ path: `${artifacts}/daily.png` });
  await panel.getByRole("tab", { name: "按模型", exact: true }).click();
  await panel.locator("tbody tr").first().waitFor();
  await panel.getByRole("tab", { name: "按项目", exact: true }).click();
  await panel.getByRole("combobox", { name: "统计时段" }).selectOption("all");
  await panel.getByRole("button", { name: "刷新", exact: true }).waitFor();
  await page.screenshot({ path: `${artifacts}/projects.png` });
  await panel.getByRole("searchbox").fill("no-such-project-123456789");
  assert.ok((await panel.locator("tbody").innerText()).includes("暂无用量记录"));
  await panel.getByRole("searchbox").fill("");
  await panel.getByRole("tab", { name: "按项目", exact: true }).focus();
  await page.keyboard.press("Home");
  assert.equal(await panel.getByRole("tab", { name: "概览", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Token 用量", exact: true }).evaluate((element) => document.activeElement === element), true);

  // Retain the last good snapshot on a refresh failure; retry recovers.
  await page.getByRole("button", { name: "Token 用量", exact: true }).click();
  await panel.locator(".usage-card").first().waitFor();
  await page.route("**/api/usage?*", (route) => route.fulfill({ status: 500, json: { error: "fixture failure" } }));
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(await panel.locator(".usage-card").count(), 4);
  await page.unroute("**/api/usage?*");
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await panel.getByRole("alert").waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "关闭", exact: true }).click();

  // Narrow mobile: open from More, keep the panel within the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-mobile-toolbar-more]").click();
  await page.locator('[data-mobile-toolbar-action="usage"]').click();
  await panel.locator(".usage-card").first().waitFor();
  const box = await panel.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 391);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: `${artifacts}/mobile.png` });
  await panel.getByRole("tab", { name: "按项目", exact: true }).click();
  await panel.locator(".usage-table").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  // Empty history remains useful; translations and dark theme need no special CSS.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, records: 0 };
  await page.route("**/api/usage?*", (route) => route.fulfill({ json: {
    ...snapshot, overview: Object.fromEntries(["today", "7d", "30d", "all"].map((key) => [key, empty])),
    ranges: Object.fromEntries(["today", "7d", "30d", "all"].map((key) => [key, { total: empty, projects: [], models: [], daily: [] }])),
    coverage: { sessions: 0, duplicateRecords: 0, unreadableFiles: 0, skippedLines: 0 },
  } }));
  await page.getByRole("button", { name: "Token 用量", exact: true }).click();
  await panel.locator(".usage-card").first().waitFor();
  assert.ok((await panel.locator(".usage-card").first().innerText()).includes("0 tok"));
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.unroute("**/api/usage?*");
  for (const [locale, title, projects] of [["en", "Token usage", "By project"], ["zh-TW", "Token 用量", "依專案"]]) {
    await page.evaluate((locale) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", "dark"); }, locale);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: title, exact: true }).click();
    const localizedPanel = page.getByRole("dialog", { name: title });
    await localizedPanel.locator(".usage-card").first().waitFor();
    await localizedPanel.getByRole("tab", { name: projects, exact: true }).click();
    assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("dark")), true);
    await page.screenshot({ path: `${artifacts}/${locale}-dark.png` });
  }
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log(`Usage UI/API checks passed; screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
