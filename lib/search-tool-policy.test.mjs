import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { filterSearchTools, installSearchToolPolicy } = await jiti.import("./search-tool-policy.ts");
const { PRESET_DEFAULT, PRESET_FULL, PRESET_READ_ONLY, getPresetFromToolNames } = await jiti.import("./tool-presets.ts");
const gemini = { id: "fixture-gemini", provider: "custom-google", api: "google-generative-ai" };
const codex = { id: "fixture-codex", provider: "openai-codex", api: "openai-codex-responses" };
const searchTools = ["web_search", "url_context"];

for (const [preset, names] of [["default", PRESET_DEFAULT], ["read-only", PRESET_READ_ONLY], ["none", []]]) {
  test(`${preset} removes search even from a stale expanded selection`, () => {
    const candidates = [...names, "ordinary_extension", ...searchTools];
    assert.deepEqual(filterSearchTools(candidates, names, gemini), [...names, "ordinary_extension"]);
  });
}

test("Full enables search, with URL Context limited to Gemini", () => {
  const candidates = [...PRESET_FULL, "ordinary_extension", ...searchTools];
  assert.deepEqual(filterSearchTools(candidates, PRESET_FULL, gemini), candidates);
  assert.deepEqual(filterSearchTools(candidates, PRESET_FULL, codex), candidates.filter((name) => name !== "url_context"));
  assert.deepEqual(filterSearchTools(searchTools, PRESET_FULL, undefined), ["web_search"]);
  assert.deepEqual(filterSearchTools(searchTools, PRESET_FULL, { provider: "google-generative-ai" }), searchTools);
});

test("Full classification ignores extensions and tolerates PowerShell, ordering and duplicates", () => {
  const full = PRESET_FULL.map((name) => name === "bash" ? "powershell" : name).reverse();
  assert.deepEqual(filterSearchTools(searchTools, [...full, ...full, "ordinary_extension"], gemini), searchTools);
  const notFull = [...PRESET_DEFAULT, "ordinary_extension", ...searchTools];
  assert.equal(notFull.length, PRESET_FULL.length);
  assert.deepEqual(filterSearchTools(searchTools, notFull, gemini), []);
  assert.equal(getPresetFromToolNames([...PRESET_DEFAULT, ...searchTools]), "default");
});

function fixture(selection = PRESET_DEFAULT) {
  const session = {
    model: codex,
    active: [...selection, "ordinary_extension", ...searchTools],
    registered: [...PRESET_FULL, "ordinary_extension", ...searchTools],
    getActiveToolNames() { return [...this.active]; },
    getAllTools() { return this.registered.map((name) => ({ name })); },
    setActiveToolsByName(names) { this.active = names.filter((name) => this.registered.includes(name)); },
    async setModel(model, options) {
      this.model = model;
      this.modelOptions = options;
      // Simulate a model_select extension attempting to reactivate its tools.
      this.setActiveToolsByName([...this.active, ...searchTools]);
    },
    async navigateTree(id, options) {
      this.treeArgs = [id, options];
      this.model = gemini;
      this.setActiveToolsByName([...this.active, ...searchTools]);
      return { cancelled: false };
    },
  };
  return session;
}

test("final setter rejects extension reactivation against the selected preset", () => {
  const session = fixture();
  const policy = installSearchToolPolicy(session, PRESET_DEFAULT);
  policy.sync();
  assert.deepEqual(session.active, [...PRESET_DEFAULT, "ordinary_extension"]);
  // Even activating more builtins must not silently upgrade the user's preset.
  session.setActiveToolsByName([...PRESET_FULL, ...searchTools, "ordinary_extension"]);
  assert.deepEqual(session.active, [...PRESET_FULL, "ordinary_extension"]);
  policy.dispose();
});

test("Default -> Full -> Default and reload-style registry refresh have no residual search", async () => {
  const session = fixture();
  const policy = installSearchToolPolicy(session, PRESET_DEFAULT);
  policy.sync();
  policy.setSelection(PRESET_FULL);
  session.setActiveToolsByName([...PRESET_FULL, "ordinary_extension", ...searchTools]);
  assert.ok(session.active.includes("web_search"));
  assert.ok(!session.active.includes("url_context"));
  await session.setModel(gemini);
  assert.ok(session.active.includes("url_context"));
  policy.setSelection(PRESET_DEFAULT);
  session.setActiveToolsByName([...PRESET_DEFAULT, "ordinary_extension", ...searchTools]);
  session.setActiveToolsByName([...session.active, ...searchTools]); // SDK reload
  assert.deepEqual(session.active, [...PRESET_DEFAULT, "ordinary_extension"]);
  await session.setModel(codex);
  await session.setModel(gemini);
  assert.deepEqual(session.active, [...PRESET_DEFAULT, "ordinary_extension"]);
  policy.dispose();
});

test("model/tree reconciliation preserves other extensions, arguments and return values", async () => {
  const session = fixture(PRESET_FULL);
  const originals = [session.setActiveToolsByName, session.setModel, session.navigateTree];
  const policy = installSearchToolPolicy(session, PRESET_FULL);
  policy.sync();
  session.setActiveToolsByName(PRESET_FULL); // another extension deliberately disables ordinary_extension
  await session.setModel(gemini, { persist: true });
  assert.deepEqual(session.modelOptions, { persist: true });
  assert.ok(!session.active.includes("ordinary_extension"));
  assert.ok(session.active.includes("url_context"));
  await session.setModel(codex);
  assert.ok(!session.active.includes("url_context"));
  assert.deepEqual(await session.navigateTree("leaf", { summarize: false }), { cancelled: false });
  assert.deepEqual(session.treeArgs, ["leaf", { summarize: false }]);
  assert.ok(session.active.includes("url_context"));
  policy.dispose();
  assert.deepEqual([session.setActiveToolsByName, session.setModel, session.navigateTree], originals);
});

test("Full never invents tools for an absent or disabled search package", () => {
  const session = fixture(PRESET_FULL);
  session.registered = [...PRESET_FULL, "ordinary_extension"];
  session.active = [...session.registered];
  const policy = installSearchToolPolicy(session, PRESET_FULL);
  policy.sync();
  assert.deepEqual(session.active, session.registered);
  policy.dispose();
});
