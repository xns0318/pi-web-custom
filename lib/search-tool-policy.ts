import type { AgentSessionLike, ModelLike } from "./pi-types";
import { getPresetFromToolNames } from "./tool-presets";

// This is an exposure policy for normal Web sessions, not a network sandbox.
// Keep extension names out of PRESET_FULL and persisted builtin selections.
const FULL_ONLY_SEARCH_TOOLS = new Set(["web_search", "url_context"]);

export function filterSearchTools(
  toolNames: readonly string[],
  selectedToolNames: readonly string[],
  model: ModelLike | undefined,
): string[] {
  const selection = [...new Set(selectedToolNames.map((name) => name === "powershell" ? "bash" : name))];
  const full = getPresetFromToolNames(selection) === "full";
  // Match pi-web-search's model-scoped URL Context support, including custom
  // Gemini providers identified by their API rather than their provider name.
  const supportsUrlContext = model?.api === "google-generative-ai"
    || model?.provider === "google-generative-ai";
  return [...new Set(toolNames)].filter((name) => !FULL_ONLY_SEARCH_TOOLS.has(name)
    || (full && (name !== "url_context" || supportsUrlContext)));
}

/**
 * Constrain the final SDK setter, not just Web's initial extension merge:
 * session_start, model_select, dynamic registration and reload can all call it.
 * The selected preset is authoritative; an extension cannot opt itself into Full.
 * Install only for normal Web sessions, never profile-controlled subagents.
 */
export function installSearchToolPolicy(session: AgentSessionLike, initialSelection: readonly string[]) {
  let selection = [...initialSelection];
  const originalSetTools = session.setActiveToolsByName;
  const originalSetModel = session.setModel;
  const originalNavigateTree = session.navigateTree;

  const setTools: AgentSessionLike["setActiveToolsByName"] = (names) => {
    originalSetTools.call(session, filterSearchTools(names, selection, session.model));
  };
  session.setActiveToolsByName = setTools;

  const sync = () => {
    const active = session.getActiveToolNames();
    const registeredSearch = session.getAllTools().map((tool) => tool.name)
      .filter((name) => FULL_ONLY_SEARCH_TOOLS.has(name));
    const next = filterSearchTools([...active, ...registeredSearch], selection, session.model);
    const current = new Set(active);
    if (current.size !== next.length || next.some((name) => !current.has(name))) setTools(next);
  };

  // URL Context may have been absent when the extension first captured its
  // preferences. Reconcile after model/tree changes, including extension calls,
  // so Full + Gemini can enable it without re-enabling unrelated extensions.
  const setModel: AgentSessionLike["setModel"] = async (...args) => {
    await originalSetModel.apply(session, args);
    sync();
  };
  const navigateTree: AgentSessionLike["navigateTree"] = async (...args) => {
    const result = await originalNavigateTree.apply(session, args);
    sync();
    return result;
  };
  session.setModel = setModel;
  session.navigateTree = navigateTree;

  return {
    setSelection(names: readonly string[]) { selection = [...names]; },
    sync,
    dispose() {
      if (session.setActiveToolsByName === setTools) session.setActiveToolsByName = originalSetTools;
      if (session.setModel === setModel) session.setModel = originalSetModel;
      if (session.navigateTree === navigateTree) session.navigateTree = originalNavigateTree;
    },
  };
}
