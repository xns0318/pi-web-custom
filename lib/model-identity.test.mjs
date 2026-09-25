import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { prepareModelIdentity, planModelIdentityPatch, modelIdentityPackageDirs } from "../bin/prepare-model-identity.mjs";

const jiti = createJiti(import.meta.url);
const { getMessageModelIdentity } = await jiti.import("./model-identity.ts");
const { withModelIdentity, installModelIdentityCapture } = await jiti.import("./model-identity-capture.ts");
const { normalizeToolCalls } = await jiti.import("./normalize.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const manifest = JSON.parse(readFileSync(new URL("../bin/model-identity-patches.json", import.meta.url), "utf8"));
const sdkDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))));

const message = (overrides = {}) => ({
  role: "assistant", api: "fixture", model: "sdk-accounting-id", provider: "fixture",
  content: [{ type: "text", text: "reply" }], timestamp: 1, stopReason: "stop",
  usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...overrides,
});
const identity = (id) => ({ version: 1, selectedModelId: id, selectedProvider: "fixture" });

test("raw identity is independent of labels, namespaces, case, and current selection", () => {
  assert.deepEqual(getMessageModelIdentity(message({ modelIdentity: identity("Alias/A"), responseModel: "Vendor/REAL-2026 " })), { selectedModelId: "Alias/A", responseModelId: "Vendor/REAL-2026 " });
  for (const invalid of [undefined, null, "", "  ", 1, {}]) {
    assert.deepEqual(getMessageModelIdentity({ model: "not-evidence", modelIdentity: identity(invalid), responseModel: invalid }), { selectedModelId: null, responseModelId: null });
  }
  assert.deepEqual(getMessageModelIdentity(message({ responseModel: "legacy-recorded" })), { selectedModelId: null, responseModelId: "legacy-recorded" });
  assert.deepEqual(getMessageModelIdentity(message({ modelIdentity: { version: 999, selectedModelId: "future" } })), { selectedModelId: null, responseModelId: null });
});

test("selected ID is snapshotted before await; interleaved calls and mutable partials stay independent", async () => {
  const streams = [];
  const contexts = [];
  const original = async (_model, context, options) => {
    contexts.push([context, options]);
    const stream = new AssistantMessageEventStream();
    streams.push(stream);
    await Promise.resolve();
    return stream;
  };
  const wrapped = withModelIdentity(original);
  const model = { id: "A", provider: "fixture" };
  const context = { messages: [] };
  const options = { signal: new AbortController().signal, transport: "websocket", onPayload() {} };
  const promiseA = wrapped(model, context, options);
  model.id = "B";
  const promiseB = wrapped(model, context, options);
  const [a, b] = await Promise.all([promiseA, promiseB]);
  assert.strictEqual(contexts[0][0], context);
  assert.strictEqual(contexts[0][1], options);
  const partial = message({ stopReason: "pending" });
  streams[0].push({ type: "start", partial });
  const iterator = a[Symbol.asyncIterator]();
  const first = (await iterator.next()).value.partial;
  assert.deepEqual(first.modelIdentity, identity("A"));
  assert.equal(first.responseModel, undefined);
  partial.responseModel = "raw-A";
  streams[0].push({ type: "text_delta", partial, contentIndex: 0, delta: "text" });
  assert.equal((await iterator.next()).value.partial.responseModel, "raw-A");
  const finalB = message({ responseModel: "raw-B" });
  streams[1].push({ type: "error", reason: "aborted", error: finalB });
  streams[1].end();
  partial.stopReason = "stop";
  streams[0].push({ type: "done", reason: "stop", message: partial });
  streams[0].end();
  await iterator.return();
  assert.deepEqual(getMessageModelIdentity(await a.result()), { selectedModelId: "A", responseModelId: "raw-A" });
  assert.deepEqual(getMessageModelIdentity(await b.result()), { selectedModelId: "B", responseModelId: "raw-B" });
  assert.equal(partial.modelIdentity, undefined, "do not mutate provider-owned messages");
  assert.equal(first.responseModel, undefined, "previous metadata snapshots must not change");
  assert.strictEqual((await a.result()).usage, partial.usage, "no accounting changes");
});

test("installation retains SDK this binding and preserves stream failures", async () => {
  const failure = new Error("fixture failure");
  const agent = { streamFunction() { assert.strictEqual(this, agent); throw failure; } };
  installModelIdentityCapture(agent);
  await assert.rejects(() => agent.streamFunction({ id: "A", provider: "fixture" }, { messages: [] }), (error) => error === failure);
  assert.doesNotThrow(() => installModelIdentityCapture({}));
  assert.doesNotThrow(() => installModelIdentityCapture(undefined));
});

test("local selection metadata is not replayed to providers, without mutating stored history", async () => {
  const saved = message({ modelIdentity: identity("earlier"), responseModel: "raw/earlier" });
  const context = { systemPrompt: "keep prompt", messages: [saved] };
  const wrapped = withModelIdentity((_model, requestContext) => {
    assert.equal(requestContext.systemPrompt, context.systemPrompt);
    assert.equal("modelIdentity" in requestContext.messages[0], false);
    assert.equal(requestContext.messages[0].responseModel, "raw/earlier");
    assert.strictEqual(requestContext.messages[0].content, saved.content);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: message() });
    stream.end();
    return stream;
  });
  const stream = await wrapped({ id: "next", provider: "fixture" }, context);
  assert.equal((await stream.result()).modelIdentity.selectedModelId, "next");
  assert.deepEqual(saved.modelIdentity, identity("earlier"));
});

test("JSONL, branches, forks, deferred thinking, normalization and UI history preserve per-message identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-model-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  manager.appendModelChange("fixture", "A");
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  const first = message({ modelIdentity: identity("A"), responseModel: "raw/A", content: [{ type: "thinking", thinking: "reasoning" }, { type: "toolCall", id: "call", name: "read", arguments: {} }] });
  const firstId = manager.appendMessage(first);
  manager.appendModelChange("fixture", "B");
  const secondId = manager.appendMessage(message({ timestamp: 2, modelIdentity: identity("B"), responseModel: "raw/B" }));
  const file = manager.getSessionFile();
  const reopened = SessionManager.open(file);
  const verify = (entries, leaf) => {
    const history = buildSessionContext(entries, leaf, { deferThinking: true });
    const assistants = history.messages.filter((entry) => entry.role === "assistant");
    assert.deepEqual(getMessageModelIdentity(assistants[0]), { selectedModelId: "A", responseModelId: "raw/A" });
    assert.deepEqual(getMessageModelIdentity(normalizeToolCalls(assistants[0])), getMessageModelIdentity(assistants[0]));
    return assistants;
  };
  assert.equal(verify(reopened.getEntries(), firstId).length, 1);
  assert.equal(verify(reopened.getEntries(), secondId).length, 2);
  const fork = SessionManager.forkFrom(file, dir, join(dir, "fork"));
  assert.equal(verify(fork.getEntries()).length, 2);
  const legacy = message();
  assert.deepEqual(getMessageModelIdentity(legacy), { selectedModelId: null, responseModelId: null });
});

test("installed SDK patch passes strict check and individual transformations are idempotent", () => {
  const copies = modelIdentityPackageDirs();
  assert.ok(copies.includes(sdkDir));
  const bundled = join(sdkDir, "..", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai");
  if (existsSync(bundled)) assert.ok(copies.includes(realpathSync(bundled)), "must include the SDK copy used by RPC");
  assert.equal(prepareModelIdentity(copies, { check: true }), 0);
  for (const patch of manifest.patches) {
    const patched = readFileSync(join(sdkDir, patch.file), "utf8");
    const original = patched.replace(patch.after, patch.before);
    assert.equal(planModelIdentityPatch(original, patch), patched);
    assert.equal(planModelIdentityPatch(patched, patch), patched);
    assert.throws(() => planModelIdentityPatch(patched + "\n// drift", patch), /unexpected SDK contents/);
  }
});

test("patch rejects drift or another SDK version before modifying any files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-model-patch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sources = new Map();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: manifest.package, version: manifest.version }));
  for (const patch of manifest.patches) {
    const original = readFileSync(join(sdkDir, patch.file), "utf8").replace(patch.after, patch.before);
    sources.set(patch.file, original);
    mkdirSync(dirname(join(dir, patch.file)), { recursive: true });
    writeFileSync(join(dir, patch.file), original);
  }
  const last = manifest.patches.at(-1).file;
  writeFileSync(join(dir, last), "unexpected SDK source");
  assert.throws(() => prepareModelIdentity(dir), /unexpected SDK contents/);
  const first = manifest.patches[0].file;
  assert.equal(readFileSync(join(dir, first), "utf8"), sources.get(first));
  writeFileSync(join(dir, last), sources.get(last));
  const badCopy = join(dir, "second-copy");
  mkdirSync(badCopy);
  writeFileSync(join(badCopy, "package.json"), JSON.stringify({ name: manifest.package, version: "next" }));
  assert.throws(() => prepareModelIdentity([dir, badCopy]), /requires/);
  assert.equal(readFileSync(join(dir, first), "utf8"), sources.get(first), "validate every SDK copy before changing the first");
  assert.throws(() => prepareModelIdentity(dir, { check: true }), /patch is missing/);
  assert.equal(prepareModelIdentity(dir), 5);
  assert.equal(prepareModelIdentity(dir), 0);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: manifest.package, version: "next" }));
  assert.throws(() => prepareModelIdentity(dir), /requires/);
});
