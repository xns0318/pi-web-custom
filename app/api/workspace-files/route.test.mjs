import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "pi-workspace-api-"));
const file = join(root, "test.txt");
fs.writeFileSync(file, "original");
const previous = globalThis.__piAllowedRootsCache;
globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Infinity };
const jiti = createJiti(import.meta.url, { alias: { "@": join(dirname(fileURLToPath(import.meta.url)), "../../..") } });
const { GET, POST } = await jiti.import("./route.ts");
after(async () => { globalThis.__piAllowedRootsCache = previous; await rm(root, { recursive: true, force: true }); });
const get = (path = file, view = "read", headers = {}) => GET(new Request(`http://localhost/api/workspace-files?${new URLSearchParams({ workspace: root, path, view })}`, { headers: { host: "localhost", ...headers } }));
const post = (body, headers = {}) => POST(new Request("http://localhost/api/workspace-files", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify({ workspace: root, path: file, ...body }) }));

test("editor API reads no-store snapshots and rejects untrusted origins/hosts", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).content, "original");
  assert.equal((await get(file, "read", { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await get(file, "read", { host: "rebound.invalid" })).status, 403);
  assert.equal((await post({ operation: "delete" }, { "sec-fetch-site": "cross-site" })).status, 403);
});
test("mutation API validates body, operation, content type, version and paths", async () => {
  for (const body of [{}, { operation: "unknown" }, { operation: "save", content: "x" }, { operation: "rename", name: 1 }, { operation: "create-file", path: root, name: [] }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ operation: "save" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await get("/etc/passwd")).status, 403);
  assert.equal((await get(file, "unknown")).status, 400);
  const malformed = new Request("http://localhost/api/workspace-files", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: "{" });
  assert.equal((await POST(malformed)).status, 400);
});
test("save requires current version and returns 409 rather than overwriting a newer edit", async () => {
  const first = await (await get()).json();
  const saved = await post({ operation: "save", version: first.version, content: "saved" });
  assert.equal(saved.status, 200);
  assert.equal(fs.readFileSync(file, "utf8"), "saved");
  const conflict = await post({ operation: "save", version: first.version, content: "stale" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "changed");
  assert.equal(fs.readFileSync(file, "utf8"), "saved");
});
test("file/folder API create, inspect, rename and confirmed delete", async () => {
  const directory = join(root, "folder");
  assert.equal((await post({ path: root, operation: "create-directory", name: "folder" })).status, 200);
  assert.equal((await post({ path: directory, operation: "create-file", name: "child" })).status, 200);
  assert.equal((await post({ path: directory, operation: "create-file", name: "child" })).status, 409);
  const meta = await (await get(directory, "inspect")).json();
  assert.equal(meta.empty, false);
  const renamed = await post({ path: directory, operation: "rename", name: "renamed", version: meta.version });
  assert.equal(renamed.status, 200);
  const target = (await renamed.json()).newPath;
  const current = await (await get(target, "inspect")).json();
  assert.equal((await post({ path: target, operation: "delete", version: current.version, confirmation: "DELETE" })).status, 400);
  assert.equal((await post({ path: target, operation: "delete", version: current.version, confirmation: "renamed" })).status, 200);
  assert.equal(fs.existsSync(target), false);
  assert.equal((await get(root, "inspect")).status, 403);
});
test("request body is bounded even without a trustworthy Content-Length", async () => {
  const oversized = new Request("http://localhost/api/workspace-files", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ content: "x".repeat(7 * 1024 * 1024) }) });
  assert.equal((await POST(oversized)).status, 413);
  assert.equal((await post({ operation: "create-file", path: root, name: "fine" }, { "content-length": String(100 * 1024 * 1024) })).status, 413);
});
