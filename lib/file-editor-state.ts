import type { EditorState } from "@codemirror/state";
import type { EditableFile } from "./workspace-file-types";

/** UI-only containment hint; the server independently authorizes real paths. */
export function fileInWorkspace(file: string, root: string): boolean {
  const normalize = (value: string) => {
    const slashes = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(slashes) ? slashes.toLowerCase() : slashes;
  };
  const target = normalize(file), base = normalize(root);
  if (target.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) return false;
  return target === base || target.startsWith(`${base}/`);
}
export interface FileDraft extends EditableFile {
  baseline: string;
  saving: boolean;
  error: string | null;
  editorState?: EditorState;
  viewOnly?: boolean;
  revision?: number;
  revalidate?: boolean;
  disk?: EditableFile;
}
// EOL convention belongs to the disk baseline, not to editable text. A reviewed
// external LF/CRLF conversion must not leave a successfully saved draft dirty.
export const draftDirty = (draft?: FileDraft) => Boolean(draft && draft.content !== draft.baseline
  && draft.content.replace(/\r\n/g, "\n") !== draft.baseline.replace(/\r\n/g, "\n"));

/** Page-memory only: never put file content/credentials into browser storage. */
export function createFileEditorStore() {
  const drafts = new Map<string, FileDraft>();
  const listeners = new Set<() => void>();
  let statusVersion = 0;
  const notify = () => listeners.forEach((listener) => listener());
  return {
    get: (path: string) => drafts.get(path),
    status: () => statusVersion,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(path: string, next: FileDraft) {
      const previous = drafts.get(path);
      if (!previous || draftDirty(previous) !== draftDirty(next) || previous.saving !== next.saving) statusVersion++;
      drafts.set(path, next);
      notify();
    },
    affected(path: string) { return [...drafts.entries()].filter(([key]) => fileInWorkspace(key, path)); },
    hasPending() { return [...drafts.values()].some((draft) => draftDirty(draft) || draft.saving); },
    remove(path: string) { if (drafts.delete(path)) { statusVersion++; notify(); } },
    removeTree(path: string) {
      for (const key of drafts.keys()) if (fileInWorkspace(key, path)) drafts.delete(key);
      statusVersion++; notify();
    },
    clearClean() {
      for (const [key, draft] of drafts) if (!draftDirty(draft) && !draft.saving) drafts.delete(key);
      statusVersion++; notify();
    },
    rename(from: string, to: string) {
      const changed = [...drafts.entries()].filter(([key]) => fileInWorkspace(key, from));
      for (const [key] of changed) drafts.delete(key);
      for (const [key, draft] of changed) drafts.set(to + key.slice(from.length), { ...draft, error: null, disk: undefined, revalidate: true });
      statusVersion++; notify();
    },
  };
}
export type FileEditorStore = ReturnType<typeof createFileEditorStore>;
