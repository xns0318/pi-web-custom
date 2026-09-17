import { NextResponse } from "next/server";
import { getAllowedFileRoots } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { createWorkspaceFiles, WorkspaceFileError } from "@/lib/workspace-files";
import { EDIT_MAX_BYTES, type FileOperation } from "@/lib/workspace-file-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
const MAX_BODY = EDIT_MAX_BYTES * 6 + 16_384; // JSON can escape one byte as six ASCII bytes.
const operations = new Set(["save", "create-file", "create-directory", "rename", "delete"]);
const string = (value: unknown, maximum = 4096): value is string => typeof value === "string" && value.length <= maximum;
const bad = () => { throw new WorkspaceFileError("invalidRequest"); };

async function bodyWithinLimit(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY) throw new WorkspaceFileError("tooLarge", 413);
  const reader = request.body?.getReader();
  if (!reader) return bad();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw new WorkspaceFileError("tooLarge", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return bad(); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return bad();
  return data as Record<string, unknown>;
}

function failure(error: unknown) {
  const fsCode = (error as NodeJS.ErrnoException)?.code;
  const known: Record<string, [string, number]> = {
    ENOENT: ["notFound", 404], EEXIST: ["exists", 409], ENOTEMPTY: ["exists", 409],
    EACCES: ["permission", 403], EPERM: ["permission", 403], ELOOP: ["symbolicLink", 403],
    ENOTDIR: ["notDirectory", 400], EISDIR: ["unsupportedFile", 415], ENAMETOOLONG: ["invalidName", 400],
    EXDEV: ["unsupportedOperation", 409], ENOTSUP: ["unsupportedOperation", 409], EBUSY: ["busy", 409],
  };
  const [code, status] = error instanceof WorkspaceFileError ? [error.code, error.status]
    : known[fsCode ?? ""] ?? ["failed", 500];
  if (status === 500) console.error("[pi-web] Workspace file operation failed:", error);
  return NextResponse.json({ code, error: "Workspace file operation failed" }, { status, headers });
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return failure(new WorkspaceFileError("outsideWorkspace", 403));
  try {
    const params = new URL(request.url).searchParams;
    const workspace = params.get("workspace");
    const path = params.get("path");
    const view = params.get("view") ?? "read";
    if (!string(workspace) || !string(path) || !["read", "inspect"].includes(view)) return bad();
    const files = createWorkspaceFiles(await getAllowedFileRoots());
    return NextResponse.json(view === "read" ? files.read(workspace, path) : files.inspect(workspace, path), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return failure(new WorkspaceFileError("outsideWorkspace", 403));
  if (!hasJsonContentType(request)) return failure(new WorkspaceFileError("invalidRequest", 415));
  try {
    const body = await bodyWithinLimit(request);
    const { workspace, path, operation, content, version, name, confirmation } = body;
    if (!string(workspace) || !string(path) || typeof operation !== "string" || !operations.has(operation)) return bad();
    if (["save", "rename", "delete"].includes(operation) && (typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version))) return bad();
    if (["create-file", "create-directory", "rename"].includes(operation) && !string(name, 255)) return bad();
    if (operation === "delete" && !string(confirmation, 255)) return bad();
    if (operation === "save" && typeof content !== "string") return bad();
    if (operation === "save" && (content as string).length > EDIT_MAX_BYTES) throw new WorkspaceFileError("tooLarge", 413);
    const files = createWorkspaceFiles(await getAllowedFileRoots());
    const result = await (operation === "save"
      ? files.save(workspace, path, content as string, version as string)
      : files.change(workspace, path, operation as FileOperation, name as string, version as string, confirmation as string))
      // Recursive deletion can partially complete before an I/O error. Refresh
      // cached listings even on failure; never present an assumed rollback.
      .finally(() => globalThis.__piFileIndexCache?.clear());
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
