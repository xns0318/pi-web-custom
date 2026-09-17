"use client";

import { useEffect, useMemo, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultHighlightStyle, HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import type { FileDraft } from "@/lib/file-editor-state";

const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#c4b5fd" }, { tag: tags.comment, color: "#9ca3af", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#86efac" },
  { tag: [tags.number, tags.bool, tags.null], color: "#fdba74" },
  { tag: [tags.propertyName, tags.typeName, tags.tagName], color: "#93c5fd" },
  { tag: tags.heading, color: "#93c5fd", fontWeight: "bold" },
]);
const phraseKeys: Record<string, string> = {
  Find: "find", Replace: "replaceLabel", next: "next", previous: "previous", all: "all",
  "match case": "matchCase", regexp: "regexp", "by word": "wholeWord", replace: "replace",
  "replace all": "replaceAll", close: "close", "Go to line": "goToLine", go: "go",
  "current match": "currentMatch", "on line": "onLine", "replaced match on line $": "replacedOne",
  "replaced $ matches": "replacedMany", "Fold line": "fold", "Unfold line": "unfold",
};
function language(path: string) {
  const name = path.split(/[\\/]/).at(-1)!.toLowerCase();
  const ext = name.split(".").at(-1);
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext!)) return javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "tsx" || ext === "jsx" });
  if (ext === "json" || ext === "jsonl") return json();
  if (ext === "py") return python();
  if (ext === "md" || ext === "mdx") return markdown();
  if (ext === "css") return css();
  if (ext === "html" || ext === "htm") return html();
  if (ext === "sql") return sql();
  if (ext === "yml" || ext === "yaml") return yaml();
  if (ext === "toml") return StreamLanguage.define(toml);
  if (["sh", "bash", "zsh"].includes(ext!) || name.startsWith(".env")) return StreamLanguage.define(shell);
  return [];
}
function theme(dark: boolean) {
  return EditorView.theme({
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--text)", minHeight: "100%" },
    ".cm-gutters": { backgroundColor: "var(--bg-panel)", color: "var(--text-dim)", borderRight: "1px solid var(--border)" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
    ".cm-panels, .cm-tooltip": { backgroundColor: "var(--bg-panel)", color: "var(--text)", borderColor: "var(--border)" },
    ".cm-textfield, .cm-button": { background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" },
  }, { dark });
}
interface Props {
  path: string;
  label: string;
  draft: FileDraft;
  readOnly: boolean;
  onChange: (content: string, state: EditorState) => void;
  onSave: () => void;
}
export default function CodeEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const refs = useRef(props);
  refs.current = props;
  const { isDark } = useTheme();
  const { t } = useI18n();
  const phrases = useMemo(() => Object.fromEntries(Object.entries(phraseKeys).map(([phrase, key]) => [phrase, t(`workspace.cm.${key}`)])), [t]);
  const themeSlot = useRef(new Compartment());
  const phrasesSlot = useRef(new Compartment());
  const readOnlySlot = useRef(new Compartment());

  useEffect(() => {
    const { path, draft, label, readOnly } = refs.current;
    const extensions = [
      basicSetup, language(path), EditorState.lineSeparator.of(draft.eol),
      themeSlot.current.of([theme(isDark), syntaxHighlighting(isDark ? darkHighlight : defaultHighlightStyle)]),
      phrasesSlot.current.of(EditorState.phrases.of(phrases)),
      readOnlySlot.current.of(EditorState.readOnly.of(readOnly)), keymap.of([indentWithTab]),
      EditorView.contentAttributes.of({ "aria-label": label }),
      Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { refs.current.onSave(); return true; } }])),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) refs.current.onChange(update.state.sliceDoc(), update.state);
      }),
    ];
    // Reconfigure callbacks on remount/rename without discarding document,
    // selection or undo history held by the page-owned draft store.
    const state = draft.editorState
      ? draft.editorState.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: draft.content, extensions });
    const editor = new EditorView({ state, parent: host.current! });
    view.current = editor;
    editor.focus();
    return () => { editor.destroy(); view.current = null; };
    // The parent keys this component by file identity/reload revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A leading BOM pasted into a BOM-less file becomes disk metadata on save.
  // Reflect the API's canonical text without resetting normal save/undo history.
  useEffect(() => {
    const editor = view.current;
    const content = props.draft.content.replace(/\r\n/g, "\n");
    if (editor && editor.state.sliceDoc().replace(/\r\n/g, "\n") !== content) {
      const separator = editor.state.facet(EditorState.lineSeparator) || "\n";
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: editor.state.toText(content.replace(/\n/g, separator)) } });
    }
  }, [props.draft.content]);
  useEffect(() => { view.current?.dispatch({ effects: themeSlot.current.reconfigure([theme(isDark), syntaxHighlighting(isDark ? darkHighlight : defaultHighlightStyle)]) }); }, [isDark]);
  useEffect(() => { view.current?.dispatch({ effects: phrasesSlot.current.reconfigure(EditorState.phrases.of(phrases)) }); }, [phrases]);
  useEffect(() => { view.current?.dispatch({ effects: readOnlySlot.current.reconfigure(EditorState.readOnly.of(props.readOnly)) }); }, [props.readOnly]);
  return <div ref={host} className="workspace-code-editor" style={{ flex: 1, minHeight: 0, overflow: "hidden" }} />;
}
