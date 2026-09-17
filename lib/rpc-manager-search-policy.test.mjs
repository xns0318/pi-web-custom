import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { PRESET_DEFAULT, PRESET_FULL, PRESET_READ_ONLY } = await jiti.import("./tool-presets.ts");

async function fixture(selection, t, enforcePolicy = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-search-policy-"));
  let commandReload;
  let extensionApi;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
  });
  await modelRuntime.setRuntimeApiKey("openai", "fixture-not-a-real-key");
  await modelRuntime.setRuntimeApiKey("google", "fixture-not-a-real-key");
  const model = modelRuntime.getModel("openai", "gpt-4o");
  const gemini = modelRuntime.getModel("google", "gemini-2.5-flash");
  assert.ok(model);
  assert.ok(gemini);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => {
      extensionApi = pi;
      for (const name of ["web_search", "url_context", "ordinary_extension"]) {
        pi.registerTool({ name, label: name, description: name, promptSnippet: `fixture ${name}`,
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
        });
      }
      const reactivate = () => pi.setActiveTools([...pi.getActiveTools(), "web_search", "url_context"]);
      pi.on("session_start", reactivate);
      pi.on("model_select", reactivate);
      pi.registerCommand("fixture-reload", { description: "Test extension reload", handler: async (_args, ctx) => { await ctx.reload(); } });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, settingsManager, modelRuntime, model,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(root),
  });
  const bindExtensions = session.bindExtensions.bind(session);
  session.bindExtensions = async (bindings) => {
    commandReload = bindings.commandContextActions.reload;
    await bindExtensions(bindings);
  };
  const wrapper = new AgentSessionWrapper(session, enforcePolicy ? { toolSelection: selection } : {});
  wrapper.setActiveToolSelection(selection);
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  // Tests must not persist project trust or touch the user's runtime settings.
  wrapper.syncProjectTrust = () => {};
  t.after(async () => { await wrapper.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { wrapper, session, model, gemini, reloadViaExtension: () => commandReload(), getExtensionApi: () => extensionApi };
}

async function assertSearch(wrapper, expected) {
  const tools = await wrapper.send({ type: "get_tools" });
  const active = tools.filter((tool) => tool.active).map((tool) => tool.name);
  const prompt = (await wrapper.send({ type: "get_state" })).systemPrompt;
  for (const name of ["web_search", "url_context"]) {
    assert.equal(active.includes(name), expected.includes(name), `active ${name}`);
    assert.equal(prompt.includes(`- ${name}: fixture ${name}`), expected.includes(name), `prompt ${name}`);
  }
  assert.ok(active.includes("ordinary_extension"));
}

for (const [name, selection] of [["Default", PRESET_DEFAULT], ["Read-only", PRESET_READ_ONLY]]) {
  test(`${name}: real SDK startup, both reload paths and model events cannot re-enable search`, async (t) => {
    const { wrapper, session, model, gemini, reloadViaExtension } = await fixture(selection, t);
    await assertSearch(wrapper, []);
    await wrapper.send({ type: "reload" });
    await assertSearch(wrapper, []);
    await reloadViaExtension();
    await assertSearch(wrapper, []);
    // Direct SDK calls also cover extensions using pi.setModel, not only RPC.
    await session.setModel(gemini);
    await assertSearch(wrapper, []);
    await session.setModel(model);
    await assertSearch(wrapper, []);
  });
}

test("real SDK Full -> Default -> Full handles model compatibility and dynamic registration", async (t) => {
  const { wrapper, session, model, gemini, getExtensionApi } = await fixture(PRESET_FULL, t);
  await assertSearch(wrapper, ["web_search"]);
  await session.setModel(gemini);
  await assertSearch(wrapper, ["web_search", "url_context"]);
  await wrapper.send({ type: "set_tools", toolNames: PRESET_DEFAULT });
  await assertSearch(wrapper, []);
  getExtensionApi().registerTool({ name: "new_extension", label: "New", description: "New", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }) });
  await assertSearch(wrapper, []);
  await wrapper.send({ type: "reload" });
  await assertSearch(wrapper, []);
  await wrapper.send({ type: "set_tools", toolNames: PRESET_FULL });
  await assertSearch(wrapper, ["web_search", "url_context"]);
  await session.setModel(model);
  await assertSearch(wrapper, ["web_search"]);
});

test("profile-controlled wrappers remain outside the normal Web preset policy", async (t) => {
  const { wrapper } = await fixture(PRESET_READ_ONLY, t, false);
  await assertSearch(wrapper, ["web_search", "url_context"]);
});
