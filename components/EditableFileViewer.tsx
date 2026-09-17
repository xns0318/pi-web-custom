"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { FileViewer } from "./FileViewer";
import { useI18n } from "@/hooks/useI18n";
import { draftDirty, fileInWorkspace, type FileDraft, type FileEditorStore } from "@/lib/file-editor-state";
import { changeWorkspaceFile, FileRequestError, readWorkspaceFile, workspaceErrorCode } from "@/lib/workspace-file-client";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { isAudioPath, isDocumentPreviewPath, isImagePath, isVideoPath } from "@/lib/file-types";
import type { EditableFile } from "@/lib/workspace-file-types";

function EditorLoading() {
  const { t } = useI18n();
  return <div role="status" style={{ padding: 16 }}>{t("workspace.loading")}</div>;
}
const CodeEditor = dynamic(() => import("./CodeEditor"), { ssr: false, loading: EditorLoading });
type Props = ComponentProps<typeof FileViewer> & {
  store: FileEditorStore;
  requestEdit?: boolean;
  onEditRequestHandled: () => void;
  onSaved: () => void;
};
const initialDraft = (snapshot: EditableFile): FileDraft => ({ ...snapshot, baseline: snapshot.content, saving: false, error: null });

export function EditableFileViewer({ store, requestEdit, onEditRequestHandled, onSaved, ...viewer }: Props) {
  const { filePath, cwd, watchEnabled } = viewer;
  const { t } = useI18n();
  const draft = useSyncExternalStore(store.subscribe, () => store.get(filePath), () => undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const [showDisk, setShowDisk] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const canEdit = Boolean(cwd && fileInWorkspace(filePath, cwd) && filePath !== cwd);
  const textCandidate = !isImagePath(filePath) && !isAudioPath(filePath) && !isVideoPath(filePath) && !isDocumentPreviewPath(filePath);

  const openEditor = useCallback(async () => {
    if (!cwd || !canEdit) return;
    const existing = store.get(filePath);
    if (existing) { store.set(filePath, { ...existing, viewOnly: false }); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true); setError(null);
    try {
      const snapshot = await readWorkspaceFile(cwd, filePath, controller.signal);
      if (!controller.signal.aborted) store.set(filePath, initialDraft(snapshot));
    } catch (reason) {
      if (!controller.signal.aborted) setError(workspaceErrorCode(reason));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [canEdit, cwd, filePath, store]);
  useEffect(() => () => { controllerRef.current?.abort(); }, [filePath, cwd]);
  useEffect(() => {
    if (requestEdit) { void openEditor(); onEditRequestHandled(); }
  }, [requestEdit, openEditor, onEditRequestHandled]);

  // Watching never replaces an editor document. It updates the baseline only
  // when the disk text is unchanged; otherwise retain the draft and flag conflict.
  const editing = Boolean(draft && !draft.viewOnly);
  useEffect(() => {
    if (!editing || !cwd || !canEdit || watchEnabled === false) return;
    const controller = new AbortController();
    let sequence = 0;
    const sync = async () => {
      const current = store.get(filePath);
      if (!current || current.saving) return;
      const request = ++sequence;
      try {
        const disk = await readWorkspaceFile(cwd, filePath, controller.signal);
        const latest = store.get(filePath);
        if (controller.signal.aborted || request !== sequence || !latest || latest.saving || latest.version !== current.version) return;
        if (disk.version === latest.version) return;
        store.set(filePath, disk.content === latest.baseline
          ? { ...latest, version: disk.version, bom: disk.bom, error: null, disk: undefined, revalidate: false }
          : { ...latest, error: "changed", disk });
      } catch (reason) {
        const latest = store.get(filePath);
        if (!controller.signal.aborted && request === sequence && latest && !latest.saving) store.set(filePath, { ...latest, error: workspaceErrorCode(reason) });
      }
    };
    const events = new EventSource(`/api/files/${encodeFilePathForApi(filePath)}?type=watch`);
    events.addEventListener("connected", sync);
    events.addEventListener("change", sync);
    const online = () => { void sync(); };
    window.addEventListener("online", online);
    return () => { controller.abort(); events.close(); window.removeEventListener("online", online); };
  }, [editing, cwd, canEdit, filePath, store, watchEnabled]);

  const save = useCallback(async () => {
    const current = store.get(filePath);
    if (!current || current.saving || loading || !cwd || !canEdit || !draftDirty(current)) return;
    store.set(filePath, { ...current, saving: true, error: null });
    try {
      let version = current.version;
      if (current.revalidate) {
        const disk = await readWorkspaceFile(cwd, filePath);
        if (disk.content !== current.baseline) throw new FileRequestError("changed");
        version = disk.version;
      }
      const snapshot = await changeWorkspaceFile<EditableFile>({ operation: "save", workspace: cwd, path: filePath, content: current.content, version });
      const latest = store.get(filePath);
      if (latest) store.set(filePath, { ...latest, ...snapshot, content: snapshot.content, baseline: snapshot.content, saving: false, error: null, disk: undefined, revalidate: false });
    } catch (reason) {
      const latest = store.get(filePath);
      if (latest) store.set(filePath, { ...latest, saving: false, error: workspaceErrorCode(reason) });
    } finally { onSaved(); }
  }, [canEdit, cwd, filePath, loading, onSaved, store]);

  const loadDisk = async (discard: boolean) => {
    if (!cwd || !canEdit) return;
    if (discard && draftDirty(store.get(filePath)) && !window.confirm(t("workspace.discard"))) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const disk = await readWorkspaceFile(cwd, filePath, controller.signal);
      if (controller.signal.aborted) return;
      const current = store.get(filePath);
      if (current) store.set(filePath, discard
        ? { ...initialDraft(disk), revision: (current.revision ?? 0) + 1 }
        : { ...current, disk });
      setShowDisk(!discard);
    } catch (reason) {
      const current = store.get(filePath);
      if (!controller.signal.aborted && current) store.set(filePath, { ...current, error: workspaceErrorCode(reason) });
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };

  const exit = () => {
    if (draft?.saving || (draftDirty(draft) && !window.confirm(t("workspace.discard")))) return;
    store.remove(filePath); setError(null); setShowDisk(false); setReadRevision((value) => value + 1);
  };

  return <div className="workspace-file-viewer" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
    {(draft || (canEdit && textCandidate)) && <div className="workspace-editor-toolbar">
      {draft && editing ? <>
        <span className="workspace-editor-status">{t(draft.saving ? "workspace.saving" : draftDirty(draft) ? "workspace.unsaved" : "workspace.saved")}</span>
        <button type="button" onClick={() => void save()} disabled={!canEdit || draft.saving || loading || !draftDirty(draft)} title="Ctrl/Cmd + S">{t("workspace.save")}</button>
        <button type="button" onClick={exit} disabled={draft.saving || loading}>{t("workspace.exitEdit")}</button>
      </> : <button type="button" onClick={() => void openEditor()} disabled={loading || !canEdit}>{t(loading ? "workspace.loading" : "workspace.edit")}</button>}
    </div>}
    {draft?.viewOnly && <div role="status" className="workspace-file-warning">{t("workspace.viewingDisk")}</div>}
    {draft && !canEdit && <div role="status" className="workspace-file-warning">{t("workspace.wrongWorkspace")}</div>}
    {(draft?.error || error) && <div role="alert" className="workspace-file-warning">
      <div>{t(`workspace.error.${draft?.error || error}`)}</div>
      {draft && canEdit && <div className="workspace-editor-toolbar">
        <button type="button" onClick={() => void loadDisk(false)} disabled={loading || draft.saving}>{t("workspace.viewDisk")}</button>
        <button type="button" onClick={() => void loadDisk(true)} disabled={loading || draft.saving}>{t("workspace.reloadDisk")}</button>
      </div>}
    </div>}
    {draft && showDisk && draft.disk && <details open className="workspace-disk-version">
      <summary>{t("workspace.diskVersion")}</summary>
      <pre>{draft.disk.content}</pre>
      <button type="button" disabled={!canEdit || draft.saving || loading} onClick={() => {
        const reviewed = draft.disk;
        if (!reviewed || !window.confirm(t("workspace.rebaseConfirm"))) return;
        const current = store.get(filePath);
        if (current) store.set(filePath, { ...current, baseline: reviewed.content, version: reviewed.version, bom: reviewed.bom, error: null, disk: undefined });
        setShowDisk(false);
      }}>{t("workspace.rebase")}</button>
    </details>}
    {draft && editing ? <CodeEditor key={`${filePath}:${draft.revision ?? 0}`} path={filePath} label={t("workspace.editorFor", { name: getFileName(filePath) })} draft={draft} readOnly={!canEdit || draft.saving || loading} onSave={() => void save()} onChange={(content, editorState) => {
      const current = store.get(filePath);
      if (current) store.set(filePath, { ...current, content, editorState });
    }} /> : <div style={{ flex: 1, minHeight: 0 }}><FileViewer key={readRevision} {...viewer} /></div>}
    <style>{`
      .workspace-editor-toolbar { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:6px; padding:5px 10px; border-bottom:1px solid var(--border); font-size:11px; flex-shrink:0; }
      .workspace-editor-toolbar button, .workspace-disk-version button { font:inherit; border:1px solid var(--border); border-radius:4px; background:var(--bg-panel); color:var(--text); padding:4px 9px; cursor:pointer; }
      .workspace-editor-toolbar button:disabled { opacity:.5; cursor:default; }
      .workspace-editor-status { margin-right:auto; color:var(--text-muted); }
      .workspace-file-warning { padding:7px 10px; color:var(--text); background:color-mix(in srgb, #f59e0b 12%, var(--bg)); font-size:12px; line-height:1.6; }
      .workspace-disk-version { padding:8px 10px; font-size:12px; border-bottom:1px solid var(--border); }
      .workspace-disk-version pre { max-height:160px; overflow:auto; font:12px var(--font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
    `}</style>
  </div>;
}
