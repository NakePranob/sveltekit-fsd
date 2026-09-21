// Config discovery: upward search, then a single workspace child.
//
// The failure this pins: every command read process.cwd() and nothing
// further, so a monorepo root (config in web/) and even a project
// subdirectory (web/src/pages/…) both died with "isn't a sveltekit-fsd
// project". Each case below builds a real tmp tree on disk — resolution
// walks the filesystem, so there is nothing useful to mock.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// pathToFileURL, not the bare path: ESM `import()` takes a URL, and on Windows
// an absolute path starts `D:\` — which the loader reads as a `d:` protocol and
// rejects. (Same reason as patch.test.mjs.)
const dist = (file) => pathToFileURL(path.join(repo, "dist", "utils", file)).href;

const { requireProjectDir, resolveProjectDir, workspaceCandidates } = await import(dist("config.js"));

const CONFIG = "sveltekit-fsd.config.json";

function mktree(structure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfd-discovery-"));
  for (const [relative, contents] of Object.entries(structure)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

const withConfig = (dir) => ({ [`${dir}/${CONFIG}`]: "{}" });

test("resolves the directory itself when it holds a config", () => {
  const root = mktree({ ...withConfig("") });
  assert.deepEqual(resolveProjectDir(root), { found: true, projectDir: root, via: "self" });
});

test("walks upward from a project subdirectory", () => {
  const root = mktree({ ...withConfig("") });
  const nested = path.join(root, "src", "pages");
  fs.mkdirSync(nested, { recursive: true });
  assert.deepEqual(resolveProjectDir(nested), { found: true, projectDir: root, via: "parent" });
});

test("upward wins over a workspace match further out", () => {
  const root = mktree({
    "package.json": JSON.stringify({ workspaces: ["web"] }),
    ...withConfig("web"),
    ...withConfig("web/nested"),
  });
  // web/nested holds its own config, so the upward walk stops there and never
  // consults the root's workspaces — nearest project is the honest answer.
  assert.deepEqual(resolveProjectDir(path.join(root, "web", "nested")), {
    found: true,
    projectDir: path.join(root, "web", "nested"),
    via: "self",
  });
});

test("resolves a single workspace child by exact name", () => {
  const root = mktree({
    "package.json": JSON.stringify({ workspaces: ["web"] }),
    ...withConfig("web"),
  });
  assert.deepEqual(resolveProjectDir(root), {
    found: true,
    projectDir: path.join(root, "web"),
    via: "workspace",
  });
});

test("resolves a single workspace child through a trailing /* glob", () => {
  const root = mktree({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    ...withConfig("packages/web"),
  });
  fs.mkdirSync(path.join(root, "packages", "docs"), { recursive: true });
  assert.deepEqual(resolveProjectDir(root), {
    found: true,
    projectDir: path.join(root, "packages", "web"),
    via: "workspace",
  });
});

test("reads the { packages: [] } workspaces shape too", () => {
  const root = mktree({
    "package.json": JSON.stringify({ workspaces: { packages: ["web"] } }),
    ...withConfig("web"),
  });
  assert.deepEqual(workspaceCandidates(root), [path.join(root, "web")]);
});

test("several workspace configs is a miss with every candidate named", () => {
  const root = mktree({
    "package.json": JSON.stringify({ workspaces: ["web", "admin"] }),
    ...withConfig("web"),
    ...withConfig("admin"),
  });
  const resolved = resolveProjectDir(root);
  assert.equal(resolved.found, false);
  if (resolved.found) throw new Error("unreachable");
  assert.deepEqual(new Set(resolved.candidates), new Set([path.join(root, "web"), path.join(root, "admin")]));
  assert.throws(() => requireProjectDir(root), /re-run from the one you mean/);
  assert.throws(() => requireProjectDir(root), /web/);
});

test("an empty directory misses with no candidates and the init hint", () => {
  const root = mktree({});
  assert.deepEqual(resolveProjectDir(root), { found: false, candidates: [] });
  assert.throws(() => requireProjectDir(root), /sveltekit-fsd init/);
});

test("a missing or unparseable package.json means no workspaces, not a failure", () => {
  const missing = mktree({});
  assert.deepEqual(workspaceCandidates(missing), []);
  const broken = mktree({ "package.json": "{not json" });
  assert.deepEqual(workspaceCandidates(broken), []);
  assert.deepEqual(resolveProjectDir(broken), { found: false, candidates: [] });
});

test("requireProjectDir returns the resolved directory", () => {
  const root = mktree({
    "package.json": JSON.stringify({ workspaces: ["web"] }),
    ...withConfig("web"),
  });
  assert.equal(requireProjectDir(root), path.join(root, "web"));
});
