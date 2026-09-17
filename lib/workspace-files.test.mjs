import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createWorkspaceFiles } = await jiti.import("./workspace-files.ts");
const { EDIT_MAX_BYTES } = await jiti.import("./workspace-file-types.ts");

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), "pi-workspace-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  const outside = join(base, "other-worktree");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  const file = join(root, "文件.txt");
  fs.writeFileSync(file, "original\n");
  const files = createWorkspaceFiles(new Set([root, outside]));
  return { base, root, outside, file, files };
}
const code = (name) => (error) => error.code === name;

test("read/save handles UTF-8, BOM, CRLF, permissions and returns a fresh version", async (t) => {
  const { root, file, files } = await setup(t);
  fs.writeFileSync(file, "\ufeff中文\r\nsecond\r\n", { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  const original = files.read(root, file);
  assert.equal(original.bom, true);
  assert.equal(original.eol, "\r\n");
  assert.equal(original.content, "中文\r\nsecond\r\n");
  const saved = await files.save(root, file, "新内容\nsecond\n", original.version);
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeff新内容\r\nsecond\r\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.notEqual(saved.version, original.version);
  assert.deepEqual(files.read(root, file), saved);
  assert.deepEqual(fs.readdirSync(root), ["文件.txt"], "no temporary file left behind");
});

test("a content BOM after the encoding BOM is preserved rather than decoded away", async (t) => {
  const { root, file, files } = await setup(t);
  fs.writeFileSync(file, "\ufeff\ufeffcontent\n");
  const original = files.read(root, file);
  assert.equal(original.content, "\ufeffcontent\n");
  await files.save(root, file, original.content + "new\n", original.version);
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeff\ufeffcontent\nnew\n");
});

test("external writes conflict; failed save leaves disk unchanged", async (t) => {
  const { root, file, files } = await setup(t);
  const old = files.read(root, file);
  fs.writeFileSync(file, "changed by agent\n");
  await assert.rejects(files.save(root, file, "my draft", old.version), code("changed"));
  assert.equal(fs.readFileSync(file, "utf8"), "changed by agent\n");
  fs.unlinkSync(file);
  await assert.rejects(files.save(root, file, "do not recreate", old.version), code("ENOENT"));
  assert.equal(fs.existsSync(file), false);
});

test("concurrent saves against one version have exactly one winner", async (t) => {
  const { root, file, files } = await setup(t);
  const old = files.read(root, file);
  const results = await Promise.allSettled([files.save(root, file, "first", old.version), files.save(root, file, "second", old.version)]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.equal(results[1].reason.code, "changed");
  assert.equal(fs.readFileSync(file, "utf8"), "first");
});

test("unsupported encodings, binary, mixed line endings and large files stay read-only", async (t) => {
  const { root, file, files } = await setup(t);
  for (const [bytes, error] of [[Buffer.from([0xff, 0xfe]), "unsupportedEncoding"], ["a\0b", "unsupportedFile"], ["a\r\nb\n", "mixedNewlines"], [Buffer.alloc(EDIT_MAX_BYTES + 1, 65), "tooLarge"]]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => files.read(root, file), code(error));
  }
  fs.writeFileSync(file, "valid");
  const original = files.read(root, file);
  await assert.rejects(files.save(root, file, "\ud800", original.version), code("unsupportedEncoding"));
  await assert.rejects(files.save(root, file, "\0", original.version), code("unsupportedFile"));
  await assert.rejects(files.save(root, file, "中".repeat(EDIT_MAX_BYTES), original.version), code("tooLarge"));
  assert.equal(fs.readFileSync(file, "utf8"), "valid");
});

test("current workspace containment rejects traversal, sibling worktrees and unauthorized roots", async (t) => {
  const { root, outside, files, file } = await setup(t);
  const other = join(outside, "secret"); fs.writeFileSync(other, "outside");
  for (const target of [other, join(root, "..", "other-worktree", "secret")]) {
    assert.throws(() => files.read(root, target), code("outsideWorkspace"));
    await assert.rejects(files.change(root, target, "delete", "", "fake", "DELETE"), code("outsideWorkspace"));
  }
  assert.throws(() => files.read("/", file), code("outsideWorkspace"));
  assert.equal(fs.readFileSync(other, "utf8"), "outside");
});

test("symlink leaves, intermediate links and links substituted after reading are rejected", async (t) => {
  const { root, outside, file, files } = await setup(t);
  const secret = join(outside, "secret"); fs.writeFileSync(secret, "untouched");
  fs.symlinkSync(outside, join(root, "link"));
  assert.throws(() => files.read(root, join(root, "link", "secret")), code("symbolicLink"));
  await assert.rejects(files.change(root, join(root, "link"), "create-file", "bad"), code("symbolicLink"));
  const original = files.read(root, file);
  fs.unlinkSync(file); fs.symlinkSync(secret, file);
  await assert.rejects(files.save(root, file, "bad", original.version), code("symbolicLink"));
  await assert.rejects(files.change(root, file, "delete", "", "fake", "DELETE"), code("symbolicLink"));
  assert.equal(fs.readFileSync(secret, "utf8"), "untouched");
});

test("workspace root and Git metadata are protected, including a forged .git workspace", async (t) => {
  const { root, files } = await setup(t);
  const git = join(root, ".git"); fs.mkdirSync(git); fs.writeFileSync(join(git, "config"), "protected");
  for (const target of [root, git, join(git, "config")]) {
    await assert.rejects(files.change(root, target, "delete", "", "fake", "DELETE"), code("protectedPath"));
    await assert.rejects(files.change(root, target, "rename", "other", "fake"), code("protectedPath"));
  }
  assert.throws(() => files.read(git, join(git, "config")), code("protectedPath"));
  await assert.rejects(files.change(root, root, "create-file", ".git"), code("protectedPath"));
  await files.change(root, root, "create-file", ".gitignore");
  await files.change(root, root, "create-file", ".env");
});

test("exclusive create validates names and never replaces existing files/directories/symlinks", async (t) => {
  const { root, file, outside, files } = await setup(t);
  for (const name of ["", ".", "..", "../bad", "a/b", "a\\b", "bad\0", "中".repeat(100)]) {
    await assert.rejects(files.change(root, root, "create-file", name), code("invalidName"));
  }
  const made = await files.change(root, root, "create-directory", "新目录");
  await files.change(root, made.path, "create-file", "a #%.md");
  assert.equal(fs.existsSync(join(made.path, "a #%.md")), true);
  for (const name of ["文件.txt", "新目录"]) await assert.rejects(files.change(root, root, "create-file", name), code("EEXIST"));
  fs.symlinkSync(outside, join(root, "alias"));
  await assert.rejects(files.change(root, root, "create-directory", "alias"), code("EEXIST"));
  assert.equal(fs.readFileSync(file, "utf8"), "original\n");
});

test("rename file and nonempty folder preserves contents without clobbering collisions", async (t) => {
  const { root, file, files } = await setup(t);
  const renamed = await files.change(root, file, "rename", "new.txt", files.inspect(root, file).version);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(renamed.newPath, "utf8"), "original\n");
  const folder = join(root, "folder"); fs.mkdirSync(folder); fs.writeFileSync(join(folder, "child"), "child");
  const other = join(root, "occupied"); fs.mkdirSync(other);
  await assert.rejects(files.change(root, folder, "rename", "occupied", files.inspect(root, folder).version), code("EEXIST"));
  await assert.rejects(files.change(root, renamed.newPath, "rename", "occupied", files.inspect(root, renamed.newPath).version), code("EEXIST"));
  const result = await files.change(root, folder, "rename", "moved", files.inspect(root, folder).version);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.readFileSync(join(result.newPath, "child"), "utf8"), "child");
});

test("delete requires confirmation and handles nonempty folders without following child links", async (t) => {
  const { root, file, outside, files } = await setup(t);
  const version = files.inspect(root, file).version;
  await assert.rejects(files.change(root, file, "delete", "", version, ""), code("confirmationRequired"));
  await files.change(root, file, "delete", "", version, "DELETE");
  assert.equal(fs.existsSync(file), false);
  const folder = join(root, "folder"); fs.mkdirSync(folder);
  fs.writeFileSync(join(folder, ".hidden"), "delete this too");
  fs.writeFileSync(join(outside, "safe"), "safe");
  fs.symlinkSync(outside, join(folder, "link"));
  const info = files.inspect(root, folder); assert.equal(info.empty, false);
  await assert.rejects(files.change(root, folder, "delete", "", info.version, "DELETE"), code("confirmationRequired"));
  await files.change(root, folder, "delete", "", info.version, "folder");
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.readFileSync(join(outside, "safe"), "utf8"), "safe");
});

test("stale rename/delete confirmations and nested Git metadata are rejected", async (t) => {
  const { root, file, files } = await setup(t);
  const info = files.inspect(root, file); fs.writeFileSync(file, "new content");
  for (const operation of ["rename", "delete"]) await assert.rejects(files.change(root, file, operation, "other", info.version, "DELETE"), code("changed"));
  const folder = join(root, "nested"); fs.mkdirSync(folder); fs.writeFileSync(join(folder, ".git"), "gitdir: elsewhere");
  for (const operation of ["rename", "delete"]) await assert.rejects(files.change(root, folder, operation, "other", files.inspect(root, folder).version, "nested"), code("protectedPath"));
});

test("atomic save of a hardlinked file does not rewrite another workspace's link", async (t) => {
  const { root, outside, file, files } = await setup(t);
  const other = join(outside, "other"); fs.linkSync(file, other);
  await files.save(root, file, "new", files.read(root, file).version);
  assert.equal(fs.readFileSync(other, "utf8"), "original\n");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
});

test("failed atomic replacement retains the original file and removes its temporary", async (t) => {
  const { root, file, files } = await setup(t);
  const original = files.read(root, file);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  await assert.rejects(files.save(root, file, "must not replace", original.version), code("EACCES"));
  assert.equal(fs.readFileSync(file, "utf8"), "original\n");
  assert.deepEqual(fs.readdirSync(root), ["文件.txt"]);
});

test("last-moment external changes are revalidated before atomic replacement", async (t) => {
  const { root, file, files } = await setup(t);
  const original = files.read(root, file);
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd) => { sync(fd); fs.writeFileSync(file, "agent won\n"); });
  await assert.rejects(files.save(root, file, "stale write", original.version), code("changed"));
  assert.equal(fs.readFileSync(file, "utf8"), "agent won\n");
  assert.deepEqual(fs.readdirSync(root), ["文件.txt"]);
});
