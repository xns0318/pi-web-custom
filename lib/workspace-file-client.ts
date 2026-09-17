import type { EditableFile, FileInspection } from "./workspace-file-types";

export class FileRequestError extends Error {
  constructor(public code: string) { super(code); }
}
export async function workspaceFileRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new FileRequestError(data.code || "failed");
  return data as T;
}
export function readWorkspaceFile(workspace: string, path: string, signal?: AbortSignal): Promise<EditableFile> {
  return workspaceFileRequest(`/api/workspace-files?${new URLSearchParams({ workspace, path })}`, { signal });
}
export function inspectWorkspaceFile(workspace: string, path: string, signal?: AbortSignal): Promise<FileInspection> {
  return workspaceFileRequest(`/api/workspace-files?${new URLSearchParams({ workspace, path, view: "inspect" })}`, { signal });
}
export function changeWorkspaceFile<T>(body: Record<string, unknown>): Promise<T> {
  // Do not abort a submitted mutation on panel unmount: it may already have
  // committed. Reconcile its result into page-owned state before allowing close.
  return workspaceFileRequest("/api/workspace-files", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
}
export const workspaceErrorCode = (error: unknown) => error instanceof FileRequestError ? error.code : "network";
