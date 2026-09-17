"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { getFileDirectory, getFileName } from "@/lib/file-paths";
import type { FileAction, FileOperation } from "@/lib/workspace-file-types";

export function FileActionsMenu({ workspace, path, directory, root = false, onAction, onEdit, contextPoint, onDismiss }: {
  workspace: string; path: string; directory: boolean; root?: boolean;
  onAction: (action: FileAction) => void;
  onEdit?: () => void;
  contextPoint?: { x: number; y: number } | null;
  onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const point = contextPoint ?? anchor;
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const close = () => { setAnchor(null); dismissRef.current?.(); };
  useEffect(() => {
    if (!point) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) { setAnchor(null); dismissRef.current?.(); }
    };
    const dismiss = () => { setAnchor(null); dismissRef.current?.(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); };
  }, [point]);
  const items: FileOperation[] = root ? ["create-file", "create-directory"] : ["create-file", "create-directory", "rename", "delete"];
  return <>
    <button ref={trigger} type="button" className="workspace-file-menu-button" title={t(root ? "workspace.new" : "workspace.actions", { name: getFileName(path) })}
      aria-label={t(root ? "workspace.new" : "workspace.actions", { name: getFileName(path) })} aria-haspopup="menu" aria-expanded={Boolean(point)}
      onClick={(event) => {
        event.stopPropagation();
        if (point) close();
        else { const box = event.currentTarget.getBoundingClientRect(); setAnchor({ x: box.left, y: box.bottom }); }
      }} style={root ? { width: "auto", fontSize: 11, padding: "0 8px" } : undefined}>{root ? `+ ${t("workspace.new")}` : "⋯"}</button>
    {point && createPortal(<div ref={menu} role="menu" className="workspace-file-menu" style={{ left: Math.max(4, Math.min(point.x, window.innerWidth - 194)), top: Math.max(4, Math.min(point.y, window.innerHeight - 220)) }}
      onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {onEdit && !directory && <button type="button" role="menuitem" onClick={() => { close(); onEdit(); }}>{t("workspace.edit")}</button>}
      {items.map((operation) => <button type="button" role="menuitem" key={operation} onClick={() => {
        close();
        onAction({ workspace, path: operation.startsWith("create-") && !directory ? getFileDirectory(path) : path, operation });
      }} style={operation === "delete" ? { color: "#ef4444" } : undefined}>{t(`workspace.${operation}`)}</button>)}
    </div>, document.body)}
    <style>{`
      .workspace-file-menu-button { display:flex; align-items:center; justify-content:center; width:24px; height:22px; padding:0; border:0; border-radius:4px; background:var(--bg-panel); color:var(--text-muted); cursor:pointer; font-size:17px; }
      .workspace-file-menu-button:hover { background:var(--bg-hover); color:var(--text); }
      .workspace-file-menu { position:fixed; width:190px; z-index:10000; border:1px solid var(--border); border-radius:6px; background:var(--bg-panel); padding:4px; box-shadow:0 6px 24px #0003; }
      .workspace-file-menu button { display:block; width:100%; padding:8px 12px; text-align:left; font-size:12px; font-family:inherit; background:transparent; color:var(--text); border:0; border-radius:4px; cursor:pointer; }
      .workspace-file-menu button:hover, .workspace-file-menu button:focus-visible { background:var(--bg-hover); outline:2px solid var(--accent); outline-offset:-2px; }
    `}</style>
  </>;
}
