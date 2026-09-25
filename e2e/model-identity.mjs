// Own dev server + loopback fake provider + disposable HOME. Never targets production.
// MODEL_IDENTITY_PREVIEW=1 MODEL_IDENTITY_PREVIEW_PORT=30144 leaves a synthetic preview running.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { responseEvents, sseEvent, sseBody, fixtureModel } from "./fixtures/model-identity-provider.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, ".next/dev/lock")), "Use an independent checkout: another dev server owns this .next directory");
const preview = process.env.MODEL_IDENTITY_PREVIEW === "1";
const artifacts = mkdtempSync(join(tmpdir(), "pi-web-model-identity-e2e-"));
const home = join(artifacts, "home");
const agentDir = join(artifacts, "agent");
const workspace = join(artifacts, "workspace");
const sessionDir = join(agentDir, "sessions", "fixture");
for (const path of [home, agentDir, workspace, sessionDir]) mkdirSync(path, { recursive: true });
let hold = false;
const pending = [];
const requests = [];
const fake = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(request.url, "/v1/responses");
    assert.ok(["selected-alias", "other-alias", "same-id", "missing-id"].includes(body.model));
    assert.ok(!raw.includes("modelIdentity"), "local selection metadata must not be injected into provider payloads");
    requests.push(body.model);
    const returned = body.model === "missing-id" ? undefined : body.model === "same-id" ? body.model : `Vendor/Actual-${body.model}-2026`;
    const events = responseEvents(returned);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(events.slice(0, 4).map(sseEvent).join(""));
    if (hold) await new Promise((resolve) => pending.push(resolve));
    response.end(sseBody(events.slice(4)));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
fake.listen(0, "127.0.0.1");
await once(fake, "listening");
const providerBase = `http://127.0.0.1:${fake.address().port}/v1`;
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: providerBase, api: "openai-responses", apiKey: "fixture-not-a-real-key",
  models: ["selected-alias", "other-alias", "same-id", "missing-id"].map((id) => ({ ...fixtureModel("openai-responses", providerBase), id, name: `Demo nickname (${id})` })),
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "selected-alias", defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [] }));
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(workspace, "PREVIEW.txt"), "Synthetic model identity preview. No real provider credentials or production sessions.\n");
const legacyId = randomUUID();
const longReturnedId = `Vendor/${"LongReturnedId".repeat(25)}-<not-html>&`;
const timestamp = new Date().toISOString();
const legacy = [
  { type: "session", version: 3, id: legacyId, timestamp, cwd: workspace },
  { type: "model_change", id: "m1", parentId: null, timestamp, provider: "fixture", modelId: "selected-alias" },
  { type: "custom", id: "p1", parentId: "m1", timestamp, customType: "pi-web:tool-selection", data: { version: 1, tools: [] } },
  { type: "session_info", id: "n1", parentId: "p1", timestamp, name: "Historical / missing metadata (synthetic)" },
  { type: "message", id: "u1", parentId: "n1", timestamp, message: { role: "user", content: "Synthetic legacy message", timestamp: Date.now() } },
  { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", api: "openai-responses", provider: "fixture", model: "selected-alias", content: [{ type: "text", text: "No model identity was recorded for this historical message." }], timestamp: Date.now(), stopReason: "stop" } },
];
legacy.push(
  { type: "message", id: "u2", parentId: "a1", timestamp, message: { role: "user", content: "Long raw model ID fixture", timestamp: Date.now() } },
  { type: "message", id: "a2", parentId: "u2", timestamp, message: {
    ...legacy.at(-1).message, timestamp: Date.now(), content: [{ type: "text", text: "Synthetic long ID: wrap and display as plain text." }],
    modelIdentity: { version: 1, selectedModelId: "selected-alias", selectedProvider: "fixture" }, responseModel: longReturnedId,
  } },
);
writeFileSync(join(sessionDir, `${legacyId}.jsonl`), legacy.map(JSON.stringify).join("\n") + "\n");
const probe = createServer();
probe.listen(preview ? Number(process.env.MODEL_IDENTITY_PREVIEW_PORT || 30144) : 0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
assert.ok(![30141, 30142, 30143].includes(port), "Never use an existing production/development port");
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
// Deliberately do not inherit provider keys, proxies, auth settings, or agent paths.
const env = {
  PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TERM: "dumb", HISTFILE: "/dev/null",
  PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  PI_WEB_PASSWORD: "", PI_WEB_HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1",
};
const log = createWriteStream(join(artifacts, "server.log"));
let server;
let serverExit;
let browser;
let page;
async function start() {
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
  serverExit = once(server, "exit");
  for (let attempt = 0; ; attempt++) {
    if ((await fetch(`${base}/api/web-auth`).catch(() => null))?.ok) break;
    assert.ok(attempt < 120 && server.exitCode === null, `Isolated server failed; see ${artifacts}/server.log`);
    await delay(500);
  }
}
async function stop() {
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await serverExit; }
}
async function json(path, data) {
  const response = await fetch(`${base}${path}`, data ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : undefined);
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
async function settled(id) {
  for (let attempt = 0; ; attempt++) {
    const result = await json(`/api/agent/${id}`);
    if (!result.state?.isStreaming && !result.state?.isCompacting) return;
    assert.ok(attempt < 150, "Fixture response never settled");
    await delay(100);
  }
}
async function newSession(modelId = "selected-alias", type = "ensure_session") {
  return (await json("/api/agent/new", { cwd: workspace, type, message: "Synthetic model identity preview", provider: "fixture", modelId, toolNames: [] })).sessionId;
}
function releaseResponses() { hold = false; for (const resume of pending.splice(0)) resume(); }

try {
  await start();
  // Warm only this dev graph before opening the browser.
  await fetch(base);
  if (preview) {
    const id = await newSession("selected-alias", "prompt");
    await settled(id);
    await json(`/api/agent/${id}`, { type: "set_model", provider: "fixture", modelId: "same-id" });
    await json(`/api/agent/${id}`, { type: "prompt", message: "Synthetic matching IDs example" });
    await settled(id);
    const state = { url: `${base}/?session=${id}`, legacyUrl: `${base}/?session=${legacyId}`, pid: process.pid, nextPid: server.pid, root, artifacts, workspace, agentDir, providerBase, syntheticOnly: true };
    writeFileSync(join(artifacts, "preview-state.json"), JSON.stringify(state, null, 2) + "\n");
    console.log(JSON.stringify(state, null, 2));
    await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
    let persistedId;
    for (const [width, locale, theme, detailsName, selectedLabel, responseLabel, missing] of [
      [1440, "zh-CN", "light", "模型详情", "所选模型 ID：", "服务端返回 ID：", "未记录"],
      [390, "zh-CN", "dark", "模型详情", "所选模型 ID：", "服务端返回 ID：", "未记录"],
      [390, "en", "pine", "Model details", "Selected model ID: ", "Server-returned ID: ", "Not recorded"],
      [320, "zh-TW", "mist", "模型詳情", "所選模型 ID：", "伺服器回傳 ID：", "未記錄"],
    ]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale, reducedMotion: "reduce" });
      await context.addInitScript(({ locale, theme }) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", theme); }, { locale, theme });
      page = await context.newPage();
      page.setDefaultTimeout(45_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let id = await newSession();
      await page.goto(`${base}/?session=${id}`, { waitUntil: "networkidle" });
      await page.waitForFunction((locale) => document.documentElement.lang === locale, locale);
      hold = true;
      const input = page.locator(".chat-input-textarea");
      await input.fill("Fixture live stream");
      await input.press("Control+Enter");
      const panel = page.locator(".message-model-details").last();
      await panel.locator("summary").waitFor();
      assert.equal(await panel.evaluate((element) => element.open), false);
      await panel.locator("summary").focus();
      await page.keyboard.press("Enter");
      const selected = panel.locator('[data-model-id="selected"]');
      const returned = panel.locator('[data-model-id="response"]');
      await page.waitForFunction(() => document.querySelector('[data-model-id="response"]')?.textContent.includes("Vendor/Actual-selected-alias-2026"));
      // Empty transient sessions can be replaced by the browser's first prompt.
      await page.waitForURL((url) => Boolean(url.searchParams.get("session")));
      id = new URL(page.url()).searchParams.get("session");
      assert.ok(id);
      persistedId = id;
      assert.equal(await selected.textContent(), `${selectedLabel}selected-alias`);
      assert.equal(await returned.textContent(), `${responseLabel}Vendor/Actual-selected-alias-2026`);
      assert.equal((await json(`/api/agent/${id}`)).state.isStreaming, true, "must assert actual streaming frames, not just final history");
      await page.screenshot({ path: join(artifacts, `streaming-${width}-${locale}.png`) });
      releaseResponses();
      await settled(id);
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".message-model-details summary").first().click();
      assert.equal(await page.locator('[data-model-id="selected"]').first().textContent(), `${selectedLabel}selected-alias`);
      assert.equal(await page.locator('[data-model-id="response"]').first().textContent(), `${responseLabel}Vendor/Actual-selected-alias-2026`);
      // Change selection and reload: the old reply must retain its own selection.
      await json(`/api/agent/${id}`, { type: "set_model", provider: "fixture", modelId: "other-alias" });
      await json(`/api/agent/${id}`, { type: "prompt", message: "Second fixture model" });
      await settled(id);
      await page.reload({ waitUntil: "networkidle" });
      const details = page.locator(".message-model-details");
      await details.nth(1).locator("summary").waitFor();
      for (const element of await details.all()) await element.locator("summary").click();
      assert.deepEqual(await page.locator('[data-model-id="selected"]').allTextContents(), [`${selectedLabel}selected-alias`, `${selectedLabel}other-alias`]);
      assert.deepEqual(await page.locator('[data-model-id="response"]').allTextContents(), [`${responseLabel}Vendor/Actual-selected-alias-2026`, `${responseLabel}Vendor/Actual-other-alias-2026`]);
      assert.equal(await page.locator('[data-message-role="assistant"]').first().getByText("Demo nickname (selected-alias)", { exact: true }).count(), 1);
      for (const element of await details.all()) {
        const bounds = await element.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, "model details must fit the viewport");
      }
      await page.screenshot({ path: join(artifacts, `history-${width}-${locale}.png`) });
      const saved = await json(`/api/sessions/${id}`);
      const entries = readFileSync(saved.info.path, "utf8").trim().split("\n").map(JSON.parse);
      const replies = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").map((entry) => entry.message);
      assert.deepEqual(replies.map((reply) => reply.modelIdentity.selectedModelId), ["selected-alias", "other-alias"]);
      assert.equal(replies[0].usage.totalTokens, 10);
      await page.goto(`${base}/?session=${legacyId}`, { waitUntil: "networkidle" });
      await page.getByText(detailsName, { exact: true }).first().click();
      assert.equal(await page.locator('[data-model-id="selected"]').first().textContent(), `${selectedLabel}${missing}`);
      assert.equal(await page.locator('[data-model-id="response"]').first().textContent(), `${responseLabel}${missing}`);
      await page.getByText(detailsName, { exact: true }).last().click();
      const longId = page.locator('[data-model-id="response"]').last();
      assert.equal(await longId.textContent(), `${responseLabel}${longReturnedId}`);
      assert.equal(await longId.locator("not-html").count(), 0);
      assert.equal(await longId.evaluate((element) => element.scrollWidth <= element.clientWidth), true, "long raw IDs must wrap");
      await page.screenshot({ path: join(artifacts, `legacy-long-${width}-${locale}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px ${locale}/${theme}: live SSE, keyboard details, raw IDs/aliases, model switch, JSONL, refresh, legacy unknowns and long IDs`);
      await context.close();
    }
    // Real server restart in the fixture only: now API/UI reads JSONL, not a live SDK wrapper.
    await stop();
    await start();
    const restored = await json(`/api/sessions/${persistedId}`);
    assert.deepEqual(restored.context.messages.filter((message) => message.role === "assistant").map((message) => message.modelIdentity.selectedModelId), ["selected-alias", "other-alias"]);
    assert.equal((await json(`/api/agent/${persistedId}`)).running, false);
    assert.equal(requests.length, 8, "no extra provider requests when opening details, refreshing or restarting");
    console.log(`PASS: restored history after fixture server restart; artifacts: ${artifacts}`);
  }
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  console.error(`Artifacts: ${artifacts}`);
  throw error;
} finally {
  releaseResponses();
  await browser?.close();
  await stop();
  log.end();
  fake.closeAllConnections();
  fake.close();
}
