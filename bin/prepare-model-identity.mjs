#!/usr/bin/env node
// Reproducible, metadata-only compatibility patch for the pinned Pi SDK.
// Never run dependency preparation in a live installation. See docs/model-identity.md.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const manifest = JSON.parse(readFileSync(new URL("./model-identity-patches.json", import.meta.url), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function replaceOnce(text, before, after) {
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) !== -1) return null;
  return text.slice(0, index) + after + text.slice(index + before.length);
}

export function planModelIdentityPatch(source, patch) {
  if (sha256(source) === patch.sha256) {
    const result = replaceOnce(source, patch.before, patch.after);
    if (result !== null) return result;
  } else {
    // Accept only the exact already-patched file, not a marker or partial match.
    const original = replaceOnce(source, patch.after, patch.before);
    if (original !== null && sha256(original) === patch.sha256) return source;
  }
  throw new Error(`Model identity patch: unexpected SDK contents in ${patch.file}. Review the patch before upgrading dependencies.`);
}

export function modelIdentityPackageDirs() {
  // npm can retain a second, bundled pi-ai underneath pi-coding-agent even
  // when both versions match. Patching only the direct dependency misses RPC.
  const packages = [manifest.package, "@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core"];
  const pending = packages.map((name) => dirname(dirname(fileURLToPath(import.meta.resolve(name)))));
  const seen = new Set();
  const result = [];
  for (const path of pending) {
    const directory = realpathSync(path);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (pkg.name === manifest.package) result.push(directory);
    for (const name of packages) {
      const nested = join(directory, "node_modules", name);
      if (existsSync(join(nested, "package.json"))) pending.push(nested);
    }
  }
  return result;
}

function planPackage(packageDir) {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (pkg.name !== manifest.package || pkg.version !== manifest.version) {
    throw new Error(`Model identity patch requires ${manifest.package}@${manifest.version}; found ${pkg.name}@${pkg.version}.`);
  }
  return manifest.patches.map((patch) => {
    const path = join(packageDir, patch.file);
    const source = readFileSync(path, "utf8");
    return { path, source, result: planModelIdentityPatch(source, patch) };
  }).filter(({ source, result }) => source !== result);
}

export function prepareModelIdentity(packageDirs, { check = false } = {}) {
  // Validate all copies and all files BEFORE writing any. Re-running is idempotent.
  const changes = (Array.isArray(packageDirs) ? packageDirs : [packageDirs]).flatMap(planPackage);
  if (check && changes.length > 0) {
    throw new Error("Model identity SDK patch is missing. Run node bin/prepare-model-identity.mjs in this inactive installation.");
  }
  for (const { path, result } of changes) {
    const temporary = `${path}.pi-web-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, result, { flag: "wx", mode: statSync(path).mode & 0o777 });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return changes.length;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const count = prepareModelIdentity(modelIdentityPackageDirs(), { check: process.argv.includes("--check") });
    console.log(`[pi-web] Model identity SDK metadata: ${count ? `patched ${count} files` : "verified"}`);
  } catch (error) {
    console.error(`[pi-web] ${error.message}`);
    process.exitCode = 1;
  }
}
