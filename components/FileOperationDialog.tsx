"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileDirectory, getFileName, joinFilePath } from "@/lib/file-paths";
import { draftDirty, type FileEditorStore } from "@/lib/file-editor-state";
import { changeWorkspaceFile, inspectWorkspaceFile, workspaceErrorCode } from "@/lib/workspace-file-client";
import type { FileAction, FileInspection, FileMutation } from "@/lib/workspace-file-types";

export function FileOperationDialog({ action, store, onClose, onCommitted, onRefresh }: {
  action: FileAction; store: FileEditorStore; onClose: () => void; onCommitted: (result: FileMutation) => void; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(action.operation === "rename" ? getFileName(action.path) : "");
  const [confirmation, setConfirmation] = useState("");
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!action.operation.startsWith("create-"));
  const [error, setError] = useState<string | null>(null);
  useSyncExternalStore(store.subscribe, store.status, () => 0);
  const isDelete = action.operation === "delete";
  const typedConfirmation = isDelete && inspection?.kind === "directory" && !inspection.empty;
  const pending = store.affected(action.path).filter(([, draft]) => draft.saving || (isDelete && draftDirty(draft)));

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    input.current?.select();
    return () => { element.close(); };
  }, []);
  useEffect(() => {
    if (action.operation.startsWith("create-")) return;
    const controller = new AbortController();
    void inspectWorkspaceFile(action.workspace, action.path, controller.signal).then((data) => {
      if (!controller.signal.aborted) setInspection(data);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(workspaceErrorCode(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [action]);

  async function submit() {
    if (busy || loading || pending.length) return;
    const destination = action.operation === "rename" ? joinFilePath(getFileDirectory(action.path), name)
      : action.operation.startsWith("create-") ? joinFilePath(action.path, name) : null;
    if (destination && store.affected(destination).some(([, draft]) => draftDirty(draft) || draft.saving)) {
      setError("pendingDraft"); return;
    }
    setBusy(true); setError(null);
    try {
      const result = await changeWorkspaceFile<FileMutation>({ ...action, name, version: inspection?.version,
        confirmation: typedConfirmation ? confirmation : "DELETE" });
      onCommitted(result);
      onClose();
    } catch (reason) { setError(workspaceErrorCode(reason)); }
    finally { setBusy(false); onRefresh(); }
  }
  const allowed = !busy && !loading && !pending.length && (action.operation.startsWith("create-") || inspection)
    && (isDelete ? !typedConfirmation || confirmation === getFileName(action.path) : Boolean(name));
  return <dialog ref={dialog} className="workspace-operation-dialog" aria-labelledby="workspace-operation-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2 id="workspace-operation-title">{t(`workspace.${action.operation}`)}</h2>
      <p className="workspace-operation-path">{action.path}</p>
      {isDelete ? <>
        <p>{t(inspection?.kind === "directory" ? "workspace.deleteDirectoryWarning" : "workspace.deleteWarning")}</p>
        {typedConfirmation && <label>{t("workspace.typeName", { name: getFileName(action.path) })}
          <input ref={input} aria-label={t("workspace.confirmName")} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" />
        </label>}
      </> : <label>{t("workspace.name")}<input ref={input} aria-label={t("workspace.name")} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} autoComplete="off" /></label>}
      {loading && <p role="status">{t("workspace.loading")}</p>}
      {pending.length > 0 && <div role="alert"><p>{t("workspace.error.pendingDraft")}</p><ul>{pending.map(([path]) => <li key={path}>{path}</li>)}</ul></div>}
      {error && <p role="alert">{t(`workspace.error.${error}`)}</p>}
      <div className="workspace-operation-buttons">
        <button type="button" onClick={onClose} disabled={busy}>{t("files.cancel")}</button>
        <button type="submit" disabled={!allowed} className={isDelete ? "is-danger" : ""}>{t(busy ? "workspace.working" : isDelete ? "workspace.permanentDelete" : "workspace.confirm")}</button>
      </div>
    </form>
    <style>{`
      .workspace-operation-dialog { width:min(460px, calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:auto; padding:20px; border:1px solid var(--border); border-radius:10px; background:var(--bg-panel); color:var(--text); font-size:13px; }
      .workspace-operation-dialog::backdrop { background:#0006; }
      .workspace-operation-dialog h2 { margin:0 0 12px; font-size:16px; }
      .workspace-operation-dialog p { margin:10px 0; line-height:1.6; }
      .workspace-operation-path, .workspace-operation-dialog li { overflow-wrap:anywhere; font-family:var(--font-mono); font-size:12px; }
      .workspace-operation-dialog label { display:block; margin:12px 0; }
      .workspace-operation-dialog input { display:block; width:100%; margin-top:8px; padding:8px; border:1px solid var(--border); border-radius:4px; color:var(--text); background:var(--bg); font:inherit; box-sizing:border-box; }
      .workspace-operation-dialog [role=alert] { color:#ef4444; }
      .workspace-operation-buttons { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
      .workspace-operation-buttons button { padding:7px 12px; border:1px solid var(--border); border-radius:5px; background:var(--bg); color:var(--text); font:inherit; cursor:pointer; }
      .workspace-operation-buttons .is-danger { background:#b91c1c; color:white; border-color:#b91c1c; }
      .workspace-operation-buttons button:disabled { opacity:.5; cursor:default; }
    `}</style>
  </dialog>;
}
