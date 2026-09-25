import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import { WebSocketServer } from "ws";
import { completionEvents, anthropicEvents, responseEvents, googleEvents, sseBody, fixtureModel, fixtureCodexKey, fixtureText } from "../e2e/fixtures/model-identity-provider.mjs";

const jiti = createJiti(import.meta.url);
const { withModelIdentity } = await jiti.import("./model-identity-capture.ts");

async function consume(api, events, options = {}) {
  const { stream: original } = await import(`@earendil-works/pi-ai/api/${api}`);
  let calls = 0;
  const stream = await withModelIdentity(original)(fixtureModel(api), { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, {
    apiKey: api === "openai-codex-responses" ? fixtureCodexKey : "fixture-key",
    transport: "sse", maxRetries: 0, timeoutMs: 1000,
    fetch: async (url) => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      calls++;
      return new Response(sseBody(events), { headers: { "content-type": "text/event-stream" } });
    },
    ...options,
  });
  const frames = [];
  for await (const event of stream) {
    // Snapshot mutable provider partials, exactly as SSE serialization would.
    frames.push(JSON.parse(JSON.stringify(event)));
  }
  assert.equal(calls, 1);
  return { frames, message: await stream.result() };
}

for (const [api, eventsFor] of [
  ["openai-completions", completionEvents],
  ["anthropic-messages", anthropicEvents],
  ["openai-responses", responseEvents],
  ["azure-openai-responses", responseEvents],
  ["openai-codex-responses", responseEvents],
]) {
  for (const returned of ["provider/Actual-Model-2026", "selected-alias", undefined, "", 42]) {
    test(`${api}: records raw returned ID ${JSON.stringify(returned)}, without guessing`, async () => {
      const { frames, message } = await consume(api, eventsFor(returned));
      assert.equal(message.stopReason, "stop", message.errorMessage);
      assert.equal(message.responseModel, typeof returned === "string" && returned.length ? returned : undefined);
      assert.equal(message.modelIdentity.selectedModelId, "selected-alias");
      assert.equal(message.modelIdentity.selectedProvider, "fixture");
      assert.equal(message.model, api === "anthropic-messages" ? returned : "selected-alias", "do not alter SDK accounting model semantics");
      assert.equal(message.usage.totalTokens, 10);
      assert.equal(message.content.find((block) => block.type === "text")?.text, fixtureText);
      assert.ok(frames.some((event) => event.type === "text_delta"));
      for (const frame of frames) {
        const partial = frame.partial ?? frame.message ?? frame.error;
        assert.equal(partial.modelIdentity.selectedModelId, "selected-alias");
      }
    });
  }
}

for (const terminal of ["incomplete", "failed"]) {
  test(`Responses keeps metadata on ${terminal} terminal events`, async () => {
    const { message } = await consume("openai-responses", responseEvents("raw/error-model", terminal));
    assert.equal(message.responseModel, "raw/error-model");
    assert.equal(message.modelIdentity.selectedModelId, "selected-alias");
    assert.equal(message.stopReason, terminal === "failed" ? "error" : "length");
  });
}

test("Responses captures terminal-only model and preserves missing-terminal error handling", async () => {
  const events = responseEvents(undefined);
  events.at(-1).response.model = "terminal-only";
  assert.equal((await consume("openai-responses", events)).message.responseModel, "terminal-only");
  const incomplete = await consume("openai-responses", responseEvents("early-raw").slice(0, -1));
  assert.equal(incomplete.message.stopReason, "error");
  assert.match(incomplete.message.errorMessage, /terminal response event/);
  assert.equal(incomplete.message.responseModel, "early-raw");
});

test("last nonempty returned ID wins; missing metadata never overwrites it", async () => {
  const events = responseEvents("initial");
  events.at(-1).response.model = "final/raw-model";
  assert.equal((await consume("openai-responses", events)).message.responseModel, "final/raw-model");
  delete events.at(-1).response.model;
  assert.equal((await consume("openai-responses", events)).message.responseModel, "initial");
  const chunks = completionEvents("initial");
  chunks.at(-1).model = "final/raw-model";
  assert.equal((await consume("openai-completions", chunks)).message.responseModel, "final/raw-model");
});

for (const api of ["google-generative-ai", "google-vertex"]) {
  test(`${api}: captures modelVersion with the real adapter on loopback`, async (t) => {
    let returned;
    let calls = 0;
    const server = createServer((request, response) => {
      calls++;
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sseBody(googleEvents(returned)));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { stream: original } = await import(`@earendil-works/pi-ai/api/${api}`);
    for (returned of ["gemini-raw-version", "selected-alias", undefined, "", 42]) {
      const stream = await withModelIdentity(original)(fixtureModel(api, `http://127.0.0.1:${server.address().port}/v1`), { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, { apiKey: "fixture-key", maxRetries: 0, timeoutMs: 1000 });
      const message = await stream.result();
      assert.equal(message.stopReason, "stop", message.errorMessage);
      assert.equal(message.responseModel, typeof returned === "string" && returned.length ? returned : undefined);
      assert.equal(message.modelIdentity.selectedModelId, "selected-alias");
      assert.equal(message.usage.totalTokens, 10);
    }
    assert.equal(calls, 5);
  });
}

test("Codex WebSocket captures response.model without changing transport", async (t) => {
  const server = createServer((_request, response) => { response.writeHead(500).end("SSE fallback must not be used"); });
  const wss = new WebSocketServer({ server });
  let framesSent = 0;
  wss.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    assert.equal(request.model, "selected-alias");
    for (const event of responseEvents("websocket/raw-model")) { socket.send(JSON.stringify(event)); framesSent++; }
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  const { stream: original } = await import("@earendil-works/pi-ai/api/openai-codex-responses");
  const stream = await withModelIdentity(original)(fixtureModel("openai-codex-responses", `http://127.0.0.1:${server.address().port}`), { messages: [] }, {
    apiKey: fixtureCodexKey, transport: "websocket", timeoutMs: 2000, websocketConnectTimeoutMs: 2000, maxRetries: 0,
    fetch: async () => { throw new Error("Unexpected HTTP fallback"); },
  });
  const message = await stream.result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(message.responseModel, "websocket/raw-model");
  assert.equal(message.modelIdentity.selectedModelId, "selected-alias");
  assert.equal(framesSent, 7);
});
