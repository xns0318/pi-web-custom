import fs from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { samePath } from "./paths";
import { EDIT_MAX_BYTES, type EditableFile, type FileInspection, type FileMutation, type FileOperation } from "./workspace-file-types";

export class WorkspaceFileError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
const fail = (code: string, status = 400): never => { throw new WorkspaceFileError(code, status); };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const stamp = (s: fs.Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.uid, s.gid].join(":");
const identity = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;

// Serialize this app's mutations, including overlapping/nested workspace roots.
// External editors do not participate: revalidate immediately before committing.
declare global { var __piWorkspaceFileQueue: Promise<unknown> | undefined; }
function mutate<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = (globalThis.__piWorkspaceFileQueue ?? Promise.resolve()).then(operation);
  globalThis.__piWorkspaceFileQueue = result.catch(() => {});
  return result;
}

function absolute(value: string) {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) fail("invalidPath");
  return path.resolve(value);
}
function scope(workspace: string, roots: Set<string>) {
  const root = absolute(workspace);
  if (!isPathWithinRoots(root, roots) || !isExistingPathWithinRoots(root, roots)) fail("outsideWorkspace", 403);
  const real = fs.realpathSync(root);
  if ([root, real].some((value) => value.split(path.sep).some((part) => part.toLowerCase() === ".git"))) fail("protectedPath", 403);
  if (!fs.statSync(real).isDirectory()) fail("notDirectory");
  return { root, real };
}
type Scope = ReturnType<typeof scope>;

function resolveTarget(area: Scope, requested: string, allowRoot = false) {
  const lexical = absolute(requested);
  if (!isPathWithinRoots(lexical, new Set([area.root]))) fail("outsideWorkspace", 403);
  const relative = path.relative(area.root, lexical);
  if (!relative && !allowRoot) fail("protectedPath", 403);
  const parts = relative ? relative.split(path.sep) : [];
  if (parts.some((part) => part.toLowerCase() === ".git")) fail("protectedPath", 403);
  // A workspace alias may resolve to an authorized root, but do not follow
  // symlinks inside it for edit/manage operations (including the leaf itself).
  if (fs.realpathSync(area.root) !== area.real) fail("changed", 409);
  let target = area.real;
  for (const part of parts) {
    target = path.join(target, part);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail("symbolicLink", 403);
    if (!stat.isFile() && !stat.isDirectory()) fail("unsupportedFile", 415);
  }
  return target;
}

function validName(name: string) {
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)
    || Buffer.byteLength(name) > 255 || !name.isWellFormed()) fail("invalidName");
  if (name.toLowerCase() === ".git") fail("protectedPath", 403);
}

function readText(target: string): EditableFile {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail("unsupportedFile", 415);
    if (before.size > EDIT_MAX_BYTES) fail("tooLarge", 413);
    // Bound the read even if another process grows the file after stat().
    const buffer = Buffer.alloc(EDIT_MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > EDIT_MAX_BYTES) fail("tooLarge", 413);
    const after = fs.fstatSync(fd);
    if (stamp(before) !== stamp(after) || !identity(after, fs.lstatSync(target))) fail("changed", 409);
    const bytes = buffer.subarray(0, count);
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes); }
    catch { return fail("unsupportedEncoding", 415); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) fail("unsupportedFile", 415);
    const withoutCrLf = content.replace(/\r\n/g, "");
    if (withoutCrLf.includes("\r") || (content.includes("\r\n") && withoutCrLf.includes("\n"))) fail("mixedNewlines", 415);
    return { content, bom, eol: content.includes("\r\n") ? "\r\n" : "\n", version: digest(`${stamp(after)}:${digest(bytes)}`) };
  } finally { fs.closeSync(fd); }
}

function inspect(target: string, requested: string): FileInspection {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() && !stat.isDirectory()) fail("unsupportedFile", 415);
  return { path: requested, kind: stat.isDirectory() ? "directory" : "file", version: digest(stamp(stat)),
    ...(stat.isDirectory() ? { empty: fs.readdirSync(target).length === 0 } : {}) };
}
function unchanged(target: string, expected: string) {
  if (!expected || digest(stamp(fs.lstatSync(target))) !== expected) fail("changed", 409);
}

// Cleanup must not follow a substituted parent or remove somebody else's
// replacement. If an external process moved our temporary, leave it alone.
function removeCreatedPath(target: string, original: fs.Stats, directory = false) {
  try {
    if (samePath(fs.realpathSync(path.dirname(target)), path.dirname(target))
      && identity(original, fs.lstatSync(target))) {
      if (directory) fs.rmdirSync(target); else fs.unlinkSync(target);
    }
  } catch { /* Preserve the actual mutation error; cleanup is best effort. */ }
}

// Refuse recursive operations over nested repository metadata. Do not traverse
// symlinks; rm removes such child links, not their targets. Bound the preflight.
async function checkTree(target: string) {
  const pending = [target];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    if (fs.lstatSync(directory).isSymbolicLink()) fail("changed", 409);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 100_000) fail("treeTooLarge", 413);
      if (entry.name.toLowerCase() === ".git") fail("protectedPath", 403);
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
}

export function createWorkspaceFiles(allowedRoots: Set<string>) {
  return {
    read(workspace: string, requested: string) {
      return readText(resolveTarget(scope(workspace, allowedRoots), requested));
    },
    inspect(workspace: string, requested: string) {
      return inspect(resolveTarget(scope(workspace, allowedRoots), requested), requested);
    },
    save(workspace: string, requested: string, content: string, version: string): Promise<EditableFile> {
      return mutate(() => {
        if (!content.isWellFormed()) fail("unsupportedEncoding", 415);
        if (Buffer.byteLength(content) > EDIT_MAX_BYTES) fail("tooLarge", 413);
        const area = scope(workspace, allowedRoots);
        const target = resolveTarget(area, requested);
        const original = readText(target);
        if (original.version !== version) fail("changed", 409);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) fail("unsupportedFile", 415);
        // The editor normalizes its document internally; retain the file's
        // original BOM and newline convention, without formatting its contents.
        const normalized = content.replace(/\r\n/g, "\n");
        if (normalized.includes("\r")) fail("mixedNewlines", 415);
        const output = (original.bom ? "\ufeff" : "") + normalized.replace(/\n/g, original.eol);
        if (Buffer.byteLength(output) > EDIT_MAX_BYTES) fail("tooLarge", 413);
        const stat = fs.statSync(target);
        const temporary = path.join(path.dirname(target), `.pi-web-edit-${randomUUID()}.tmp`);
        let fd: number | undefined;
        let created: fs.Stats | undefined;
        try {
          fd = fs.openSync(temporary, "wx", 0o600);
          created = fs.fstatSync(fd);
          fs.writeFileSync(fd, output, "utf8");
          const own = fs.fstatSync(fd);
          if (own.uid !== stat.uid || own.gid !== stat.gid) fs.fchownSync(fd, stat.uid, stat.gid);
          fs.fchmodSync(fd, stat.mode & 0o777);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
          // No event-loop yield between final validation and atomic replacement.
          if (resolveTarget(area, requested) !== target || readText(target).version !== version) fail("changed", 409);
          fs.renameSync(temporary, target);
          created = undefined;
          return readText(target);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          if (created) removeCreatedPath(temporary, created);
        }
      });
    },
    change(workspace: string, requested: string, operation: FileOperation, name = "", version = "", confirmation = ""): Promise<FileMutation> {
      return mutate(async () => {
        const area = scope(workspace, allowedRoots);
        const create = operation === "create-file" || operation === "create-directory";
        const target = resolveTarget(area, requested, create);
        if (create) {
          validName(name);
          if (!fs.statSync(target).isDirectory()) fail("notDirectory");
          const destination = path.join(target, name);
          // Both creation APIs are exclusive; no check-then-overwrite.
          if (operation === "create-file") fs.closeSync(fs.openSync(destination, "wx", 0o666));
          else fs.mkdirSync(destination);
          return { operation, workspace, path: path.join(requested, name), kind: operation === "create-file" ? "file" : "directory" };
        }
        const initial = fs.lstatSync(target);
        unchanged(target, version);
        const info = inspect(target, requested);
        if (info.kind === "directory") await checkTree(target);
        resolveTarget(area, requested);
        unchanged(target, version);
        if (operation === "delete") {
          if (confirmation !== (info.kind === "directory" && !info.empty ? path.basename(requested) : "DELETE")) fail("confirmationRequired");
          if (info.kind === "directory") await rm(target, { recursive: true, force: false });
          else fs.unlinkSync(target);
          return { operation, workspace, path: requested, kind: info.kind };
        }
        validName(name);
        const destination = path.join(path.dirname(target), name);
        if (samePath(target, destination)) fail("sameName");
        if (info.kind === "file") {
          // link() fails atomically on ANY existing target, including symlinks.
          // Same-directory rename does not cross filesystems. Never fall back
          // to an overwriting rename when hard links are unsupported.
          fs.linkSync(target, destination);
          try {
            if (!identity(initial, fs.lstatSync(target)) || !identity(initial, fs.lstatSync(destination))) fail("changed", 409);
            fs.unlinkSync(target);
          } catch (error) {
            removeCreatedPath(destination, initial);
            throw error;
          }
        } else {
          // Exclusively reserve an empty destination. rename cannot overwrite
          // a nonempty directory if another process starts writing into it.
          fs.mkdirSync(destination, { mode: 0o700 });
          const reservation = fs.lstatSync(destination);
          try {
            if (!identity(reservation, fs.lstatSync(destination))) fail("changed", 409);
            fs.renameSync(target, destination);
          } catch (error) {
            removeCreatedPath(destination, reservation, true);
            throw error;
          }
        }
        return { operation, workspace, path: requested, newPath: path.join(path.dirname(requested), name), kind: info.kind };
      });
    },
  };
}
