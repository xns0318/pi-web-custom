// Exercises the two policies that meet at the v0.9.1 merge conflict through real
// startup, rather than only constructing an AgentSessionWrapper. No model calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("real RPC startup preserves Web search presets and exact subagent prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-startup-integration-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const previous = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].map((key) => [key, process.env[key]]));
  const wrappers = [];
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd);
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "openai", defaultModel: "gpt-4o", compaction: { enabled: false },
    }));
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-not-a-real-key" } }));
    await writeFile(join(agentDir, "extensions", "search-fixture.js"), `
      export default function (pi) {
        for (const name of ["web_search", "url_context", "ordinary_extension"]) {
          pi.registerTool({ name, label: name, description: name,
            promptSnippet: "fixture " + name,
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [], details: {} }) });
        }
        pi.on("session_start", () => pi.setActiveTools([
          ...pi.getActiveTools(), "web_search", "url_context", "ordinary_extension",
        ]));
      }
    `);
    const { startRpcSession } = await jiti.import("./rpc-manager.ts");
    const { PRESET_DEFAULT, PRESET_FULL, PRESET_READ_ONLY } = await jiti.import("./tool-presets.ts");
    const stamp = "2026-09-16T00:00:00.000Z";
    const makeSession = async (id, customType, data) => {
      const file = join(root, `${id}.jsonl`);
      await writeFile(file, [
        { type: "session", version: 3, id, timestamp: stamp, cwd },
        { type: "custom", id: "policy", parentId: null, timestamp: stamp, customType, data },
        { type: "message", id: "user", parentId: "policy", timestamp: stamp, message: { role: "user", content: "Fixture history only", timestamp: Date.parse(stamp) } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      return file;
    };
    for (const [preset, selection] of [["default", PRESET_DEFAULT], ["read-only", PRESET_READ_ONLY], ["full", PRESET_FULL], ["chat-only", []]]) {
      const id = `startup-${preset}`;
      const file = await makeSession(id, "pi-web:tool-selection", { version: 1, tools: selection });
      const { session } = await startRpcSession(id, file, undefined);
      wrappers.push(session);
      await session.waitUntilReady();
      const active = (await session.send({ type: "get_tools" })).filter((tool) => tool.active).map((tool) => tool.name);
      assert.equal(active.includes("web_search"), preset === "full", preset);
      assert.equal(active.includes("url_context"), false, "OpenAI is not a URL Context model");
      assert.equal(active.includes("ordinary_extension"), preset !== "chat-only", preset);
      if (preset === "chat-only") assert.deepEqual(active, []);
      const prompt = (await session.send({ type: "get_state" })).systemPrompt;
      assert.equal(prompt.includes("- web_search: fixture web_search"), preset === "full", preset);
      const saved = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
      const selections = saved.filter((entry) => entry.customType === "pi-web:tool-selection");
      assert.ok(selections.length > 0);
      assert.deepEqual(selections.at(-1).data.tools, selection, "persisted selections stay builtin-only");
    }
    // Replace-mode profiles can have tools; exactSystemPrompt must not be gated
    // on Chat only. The profile's extension allowlist must not become Web Default.
    for (const exactSystemPrompt of ["Exact profile prompt\nNo SDK suffix.", ""]) {
      const id = `startup-profile-${exactSystemPrompt ? "text" : "empty"}`;
      const file = await makeSession(id, "pi-web:subagent", {
        version: 1, parentSessionId: "fixture-parent", parentSessionPath: join(root, "parent.jsonl"),
        resourceSnapshot: { version: 1, appendSystemPrompt: ["Fallback must not win"],
          tools: ["read", "web_search"], loadSkills: false, loadExtensions: true, exactSystemPrompt },
      });
      const { session } = await startRpcSession(id, file, undefined);
      wrappers.push(session);
      await session.waitUntilReady();
      assert.equal((await session.send({ type: "get_state" })).systemPrompt, exactSystemPrompt);
      assert.ok((await session.send({ type: "get_tools" })).some((tool) => tool.name === "web_search" && tool.active));
      await session.send({ type: "reload" });
      assert.equal((await session.send({ type: "get_state" })).systemPrompt, exactSystemPrompt);
      assert.ok((await session.send({ type: "get_tools" })).some((tool) => tool.name === "web_search" && tool.active));
    }
  } finally {
    await Promise.all(wrappers.map((wrapper) => wrapper.shutdown()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
