// Actual password middleware + local APIs + upstream paginated text preview.
// Starts its own production server and touches only temporary fixture files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(existsSync(join(root, ".next/BUILD_ID")), "Run from the independently built production candidate");
const artifacts = mkdtempSync(join(tmpdir(), "pi-web-stable-integration-"));
const fixtures = join(artifacts, "fixtures");
const agentDir = join(fixtures, "agent");
const workspace = join(fixtures, "workspace");
const home = join(fixtures, "home");
for (const dir of [agentDir, workspace, home]) mkdirSync(dir, { recursive: true });
const medium = join(workspace, "paged.txt");
const large = join(workspace, "read-only-large.txt");
const mediumText = Array.from({ length: 6000 }, (_, i) => `Line ${i}: 中文分页 ${"x".repeat(50)}\n`).join("") + "END_MARKER\n";
writeFileSync(medium, mediumText);
writeFileSync(large, "x".repeat(1024 * 1024) + "large tail\n");
const password = "isolated-e2e-password";
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(artifacts, "server.log"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.endsWith("_API_KEY") || key.endsWith("_TOKEN") || key.endsWith("_PASSWORD") || key.startsWith("PI_SESSION_") || key === "PI_CODING_AGENT_SESSION_DIR") delete env[key];
}
Object.assign(env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: password, PI_WEB_HOSTNAME: "127.0.0.1", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", NEXT_TELEMETRY_DISABLED: "1" });
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
const serverExit = once(server, "exit");
let browser;
let page;
try {
  for (let i = 0; ; i++) {
    const response = await fetch(`${base}/api/web-auth`).catch(() => null);
    if (response?.ok) break;
    assert.ok(i < 120 && server.exitCode === null, "Server did not become ready");
    await delay(500);
  }
  for (const path of ["/api/usage", "/api/workspace-files", "/api/provider-usage/query"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, `unauthenticated ${path}`);
  }
  const basic = { Authorization: `Basic ${Buffer.from(`pi:${password}`).toString("base64")}` };
  assert.equal((await fetch(`${base}/api/usage`, { headers: basic })).status, 200, "existing Basic API auth still works");
  assert.equal((await fetch(`${base}/api/usage`, { headers: { ...basic, Origin: "https://untrusted.invalid" } })).status, 403);
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
  const context = await browser.newContext({ locale: "en", viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?cwd=${encodeURIComponent(workspace)}`, { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.locator("#web-login-password").fill("incorrect");
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.trim().length > 0);
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.locator("#web-login-password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/" && url.searchParams.get("cwd") === workspace);
  const cookie = (await context.cookies()).find((item) => item.name === "pi_web_session");
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie.sameSite, "Strict", "use the formal release, not the later main cookie change");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/", "login persists across refresh");
  assert.equal((await context.request.get(`${base}/api/usage?view=snapshot`)).status(), 200);

  const encoded = medium.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const first = await (await context.request.get(`${base}/api/files/${encoded}?type=read`)).json();
  assert.equal(first.truncated, true);
  const second = await (await context.request.get(`${base}/api/files/${encoded}?type=read&offset=${first.nextOffset}`)).json();
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, mediumText, "UTF-8 survives paginated reads");
  const panel = page.locator("#file-panel");
  await page.locator(`[data-file-path=${JSON.stringify(medium)}]`).click();
  const more = panel.getByRole("button", { name: "Load more", exact: true });
  await more.waitFor();
  const initialLines = await panel.locator(".file-source-line").count();
  await more.click();
  await more.waitFor({ state: "hidden" });
  assert.ok(await panel.locator(".file-source-line").count() > initialLines);
  await panel.getByText("END_MARKER", { exact: true }).waitFor({ state: "attached" });
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = panel.locator(".cm-content");
  await editor.waitFor();
  await editor.fill("manual save after paginated preview\n");
  assert.equal(readFileSync(medium, "utf8"), mediumText, "preview/editor transition must not auto-save");
  await editor.focus(); await page.keyboard.press("Control+s");
  await panel.getByText("Saved", { exact: true }).waitFor();
  assert.equal(readFileSync(medium, "utf8"), "manual save after paginated preview\n");

  await page.locator(`[data-file-path=${JSON.stringify(large)}]`).click();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(await panel.locator(".cm-content").count(), 0, "files over 1 MiB remain preview-only");
  await panel.getByRole("button", { name: "Load more", exact: true }).waitFor();
  const oversized = await context.request.get(`${base}/api/workspace-files?${new URLSearchParams({ workspace, path: large })}`);
  assert.equal(oversized.status(), 413);
  assert.equal((await oversized.json()).code, "tooLarge");
  const created = await context.request.post(`${base}/api/workspace-files`, { data: { operation: "create-file", workspace, path: workspace, name: "authenticated.txt" } });
  assert.equal(created.status(), 200);
  assert.equal(existsSync(join(workspace, "authenticated.txt")), true);
  await page.getByRole("button", { name: "Token usage", exact: true }).click();
  await page.getByRole("dialog", { name: "Token usage", exact: true }).locator(".usage-card").first().waitFor();
  await page.screenshot({ path: join(artifacts, "authenticated-local-features.png") });
  assert.equal((await context.request.delete(`${base}/api/web-auth`)).status(), 200);
  for (const path of ["/api/usage", "/api/workspace-files"]) assert.equal((await context.request.get(`${base}${path}`)).status(), 401);
  assert.deepEqual(errors, []);
  console.log(`PASS: password login/logout, Basic API auth, origin checks, local API protection, UTF-8 pagination, manual save and 1 MiB editing limit; artifacts: ${artifacts}`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM"); await serverExit; log.end();
  rmSync(fixtures, { recursive: true, force: true });
}
