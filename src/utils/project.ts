import path from "path";
import fs from "fs-extra";
import { execFileSync } from "child_process";
import pc from "picocolors";
import { PackageManager } from "../types";

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function packageJsonPath(projectDir: string): string {
  return path.join(projectDir, "package.json");
}

export function readPackageJson(projectDir: string): PackageJson {
  const file = packageJsonPath(projectDir);
  if (!fs.existsSync(file)) {
    throw new Error(`no package.json in ${projectDir} — run this inside a SvelteKit project`);
  }
  return fs.readJsonSync(file) as PackageJson;
}

export function hasDependency(projectDir: string, name: string): boolean {
  const pkg = readPackageJson(projectDir);
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

/**
 * Writes JSON back with the indentation the file already had.
 *
 * `{ spaces: 2 }` is right for a file this CLI creates and wrong for one it
 * edits — and `sv create` writes package.json with **tabs**. A project whose
 * formatter is set to anything else would otherwise get package.json and
 * sveltekit-fsd.config.json silently reindented by every `add`, and then a
 * `prettier --check` fails on files nobody touched by hand.
 */
export function writeJson(file: string, data: unknown): void {
  fs.writeJsonSync(file, data, { spaces: detectIndent(file) });
}

/** First indented line wins: JSON's own nesting means every deeper level is a
 *  multiple of it. Falls back to 2 for a file being created. */
function detectIndent(file: string): number | string {
  if (!fs.existsSync(file)) return 2;
  const match = /\n([ \t]+)"/.exec(fs.readFileSync(file, "utf8"));
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

/**
 * The git repository root at or above `projectDir`, or `projectDir` when there
 * is no repository.
 *
 * Agent tooling reads `.claude/` and `.agents/` from the repository root, not
 * from whichever directory a command ran in. In a monorepo — a `web/` beside an
 * `api/` — writing a skill next to package.json puts it somewhere nothing ever
 * loads it, which is a silent failure: the file exists, looks right, and is
 * never read.
 */
export function findRepoRoot(projectDir: string): string {
  let dir = path.resolve(projectDir);
  for (;;) {
    // A file, not a directory, inside a worktree or a submodule.
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(projectDir);
    dir = parent;
  }
}

// Lockfile, not the `packageManager` field: the field is often absent and the
// lockfile is what actually decided which client installed node_modules.
export function detectPackageManager(projectDir: string): PackageManager {
  const lockfiles: [string, PackageManager][] = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, manager] of lockfiles) {
    if (fs.existsSync(path.join(projectDir, lockfile))) return manager;
  }
  return "npm";
}

/**
 * Writes an agent skill where the agents actually look for it.
 *
 * Real files under `.agents/skills/<name>/`, symlinked from
 * `.claude/skills/<name>`: Claude Code reads the second, Codex and anything
 * following the AGENTS.md convention read the first, and one copy means one
 * thing to keep current. Both go at the repository root — see findRepoRoot for
 * why a monorepo workspace is the wrong place.
 *
 * `files` is the skill's whole tree, keyed by path relative to the skill
 * directory, so a multi-file skill (SKILL.md plus references/) lands in one
 * call. Returns what was written, as paths relative to `projectDir`, because
 * that is the directory the user typed the command in.
 */
export function writeAgentSkill(
  projectDir: string,
  name: string,
  files: Record<string, string>
): { files: string[]; note?: string } {
  const root = findRepoRoot(projectDir);
  const relative = (target: string) => toPosix(path.relative(projectDir, target)) || ".";

  const dir = path.join(root, ".agents", "skills", name);
  const written: string[] = [];
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = path.join(dir, ...relativePath.split("/"));
    fs.ensureDirSync(path.dirname(file));
    fs.writeFileSync(file, contents);
    written.push(relative(file));
  }

  const link = path.join(root, ".claude", "skills", name);
  // lstat, not existsSync: a symlink left pointing at a deleted target is still
  // a thing in the way, and existsSync follows it and says no.
  if (lstatOrNull(link)) return { files: written };

  fs.ensureDirSync(path.dirname(link));
  try {
    fs.symlinkSync(path.join("..", "..", ".agents", "skills", name), link, "dir");
    return { files: written, note: `${relative(link)} -> .agents/skills/${name}` };
  } catch {
    // Windows refuses symlinks without developer mode or elevation. A second real
    // copy still works for Claude Code — it just has to be rewritten by the next
    // `init`, which is what the CLI does anyway.
    for (const [relativePath, contents] of Object.entries(files)) {
      const file = path.join(link, ...relativePath.split("/"));
      fs.ensureDirSync(path.dirname(file));
      fs.writeFileSync(file, contents);
      written.push(relative(file));
    }
    return { files: written, note: `${relative(link)}/ ${pc.dim("(copied — this OS refused a symlink)")}` };
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Where this project's SvelteKit config lives.
 *
 * Two places, and which one is live is not a matter of taste: `@sveltejs/kit`
 * loads the config from the Vite config **first** and only falls back to
 * `svelte.config.js` when there is none there. Current `sv create` puts
 * everything in `vite.config.ts` and writes no `svelte.config.js` at all, while
 * every project made before that has the opposite shape — and the FSD guide
 * still documents the `svelte.config.js` form.
 *
 * Writing to the wrong one is the bad failure available here: the file looks
 * right, the values are correct, and SvelteKit never reads them, so the routes
 * stay where they were and the alias never resolves.
 */
export type KitConfig = { file: string; style: "vite" | "svelte" };

export function detectKitConfig(projectDir: string): KitConfig {
  const pkg = readPackageJson(projectDir);
  if (!(pkg.dependencies?.["@sveltejs/kit"] ?? pkg.devDependencies?.["@sveltejs/kit"])) {
    throw new Error(
      "this package.json has no `@sveltejs/kit` dependency — create the app first (`npx sv create`), then run `sveltekit-fsd init` inside it"
    );
  }

  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]) {
    const file = path.join(projectDir, name);
    if (fs.existsSync(file) && /\bsveltekit\s*\(/.test(fs.readFileSync(file, "utf8"))) {
      return { file: name, style: "vite" };
    }
  }
  for (const name of ["svelte.config.js", "svelte.config.ts"]) {
    if (fs.existsSync(path.join(projectDir, name))) return { file: name, style: "svelte" };
  }
  throw new Error(
    "found no SvelteKit config — expected a `sveltekit()` plugin call in vite.config.ts, or a svelte.config.js"
  );
}

/**
 * Puts `kit.files` and `kit.alias` into the project's SvelteKit config.
 *
 * This is the one edit the whole layout depends on: `files.routes` is what
 * moves routing into the FSD app layer, and `alias` is what makes
 * `@/pages/login` resolve — in Vite, in `svelte-check`, and in steiger, because
 * SvelteKit writes both into the generated `.svelte-kit/tsconfig.json` that the
 * project's own tsconfig extends. Nothing here touches tsconfig.json itself.
 *
 * Inserted after the opening brace of the object that already configures
 * SvelteKit, rather than rebuilt: that object holds the adapter, the compiler
 * options and whatever else the project has set, and none of it is ours to
 * rewrite. Every way this can miss returns "manual" and leaves the file alone.
 */
export function patchKitConfig(
  projectDir: string,
  config: KitConfig,
  options: { routesDir: string; appTemplate: string; alias: string; srcDir: string }
): "patched" | "already" | "manual" {
  const file = path.join(projectDir, config.file);
  const source = fs.readFileSync(file, "utf8");
  if (source.includes("appTemplate")) return "already";

  const block =
    `files: {\n` +
    `\t\t\t\troutes: '${options.routesDir}',\n` +
    `\t\t\t\tappTemplate: '${options.appTemplate}'\n` +
    `\t\t\t},\n` +
    `\t\t\talias: {\n` +
    `\t\t\t\t'${options.alias}/*': '${options.srcDir}/*'\n` +
    `\t\t\t},\n`;

  if (config.style === "vite") {
    // Anchored on `sveltekit(` and the first thing after it, which is either the
    // options object or nothing at all. A call with a spread variable instead of
    // a literal is left for the user.
    const call = /\bsveltekit\s*\(\s*(\{|\))/.exec(source);
    if (!call) return "manual";
    const at = call.index + call[0].length;
    if (call[1] === "{") {
      return write(file, source.slice(0, at) + `\n\t\t\t${block.trimEnd()}` + source.slice(at));
    }
    // `sveltekit()` — give it an options object of its own.
    const openAt = source.lastIndexOf("(", at);
    return write(file, `${source.slice(0, openAt + 1)}{\n\t\t\t${block.trimEnd()}\n\t\t}${source.slice(at - 1)}`);
  }

  // svelte.config.js: the same block goes inside `kit: { ... }`.
  const kit = /\bkit\s*:\s*\{/.exec(source);
  if (!kit) return "manual";
  const at = kit.index + kit[0].length;
  return write(file, source.slice(0, at) + `\n\t\t${block.trimEnd()}` + source.slice(at));
}

function write(file: string, contents: string): "patched" {
  fs.writeFileSync(file, contents);
  return "patched";
}

/** The block `patchKitConfig` would have inserted, for printing when it could
 *  not find a place to put it. One source of truth for both. */
export function kitConfigSnippet(options: {
  routesDir: string;
  appTemplate: string;
  alias: string;
  srcDir: string;
}): string {
  return (
    `  files: {\n` +
    `    routes: '${options.routesDir}',\n` +
    `    appTemplate: '${options.appTemplate}'\n` +
    `  },\n` +
    `  alias: {\n` +
    `    '${options.alias}/*': '${options.srcDir}/*'\n` +
    `  }`
  );
}

/**
 * Adds dependencies that are missing, leaving any already-declared version
 * alone — a project pinned to axios ^1.5 should not get silently bumped because
 * a template happened to be written against a newer one.
 * Returns the names actually added.
 */
export function addDependencies(
  projectDir: string,
  deps: Record<string, string>,
  kind: "dependencies" | "devDependencies" = "dependencies"
): string[] {
  const file = packageJsonPath(projectDir);
  const pkg = fs.readJsonSync(file) as PackageJson;
  const target = { ...(pkg[kind] ?? {}) };
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  const added: string[] = [];
  for (const [name, range] of Object.entries(deps)) {
    if (declared[name]) continue;
    target[name] = range;
    added.push(name);
  }
  if (added.length === 0) return [];

  // Sorted so a diff of package.json stays reviewable instead of appending in
  // whatever order a template listed its dependencies.
  pkg[kind] = Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)));
  writeJson(file, pkg);
  return added;
}

export function installDependencies(projectDir: string, manager: PackageManager): void {
  const command = manager === "npm" ? ["npm", "install"] : [manager, "install"];
  console.log(pc.dim(`> ${command.join(" ")}`));
  execFileSync(command[0], command.slice(1), { cwd: projectDir, stdio: "inherit" });
}

export type HookResult =
  | { status: "installed" | "exists"; file: string; huskyOwnsHooks: boolean }
  | { status: "no-repo" | "foreign-hooks-path"; file?: string; huskyOwnsHooks: boolean };

/**
 * Writes a commit-msg hook where git will actually run it.
 *
 * Three cases, and the first one is why this is not a template entry like
 * everything else:
 *
 * - **husky already owns the hooks.** It points `core.hooksPath` at `.husky`, so
 *   a hook written to `.githooks` would never run — and setting the path
 *   ourselves would turn husky's own hooks off. The hook goes to `.husky/`
 *   instead and nothing is configured.
 * - **`core.hooksPath` is set to something else.** Somebody chose that; the file
 *   is written anyway so it can be moved or pointed at, and the caller says so
 *   rather than silently taking the setting over.
 * - **no repository at all.** `init` runs before `git init` often enough, and a
 *   hook in a directory git has never heard of is litter.
 *
 * Hooks live at the repository root, not in the project directory: in a monorepo
 * the workspace has no `.git` of its own.
 */
export function installCommitHook(projectDir: string, contents: string): HookResult {
  const repoRoot = findRepoRoot(projectDir);
  const huskyOwnsHooks = fs.existsSync(path.join(repoRoot, ".husky"));
  if (!fs.existsSync(path.join(repoRoot, ".git"))) return { status: "no-repo", huskyOwnsHooks };

  const dir = huskyOwnsHooks ? ".husky" : ".githooks";
  const file = path.posix.join(dir, "commit-msg");
  const full = path.join(repoRoot, dir, "commit-msg");
  if (fs.existsSync(full)) return { status: "exists", file, huskyOwnsHooks };

  fs.ensureDirSync(path.dirname(full));
  fs.writeFileSync(full, contents);
  // A hook git cannot execute is a hook git skips, with no message at all.
  fs.chmodSync(full, 0o755);
  if (huskyOwnsHooks) return { status: "installed", file, huskyOwnsHooks };

  const configured = gitConfig(repoRoot, "core.hooksPath");
  if (configured !== undefined && configured !== dir) {
    return { status: "foreign-hooks-path", file, huskyOwnsHooks };
  }
  if (configured === undefined) {
    try {
      execFileSync("git", ["config", "core.hooksPath", dir], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      return { status: "foreign-hooks-path", file, huskyOwnsHooks };
    }
  }
  return { status: "installed", file, huskyOwnsHooks };
}

function gitConfig(repoRoot: string, key: string): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", key], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value === "" ? undefined : value;
  } catch {
    // `git config --get` exits 1 when the key is unset, which is not an error.
    return undefined;
  }
}

export function runCommand(projectDir: string, manager: PackageManager, args: string[]): void {
  const runner = manager === "npm" ? "npx" : manager === "yarn" ? "yarn" : manager === "pnpm" ? "pnpm" : "bunx";
  console.log(pc.dim(`> ${runner} ${args.join(" ")}`));
  execFileSync(runner, args, { cwd: projectDir, stdio: "inherit" });
}

/**
 * Adds a step to a package script, or creates it. Appended with `&&` rather than
 * replaced: `lint` already runs prettier and eslint in a project made with those
 * add-ons, and all three checks matter.
 */
export function appendScript(projectDir: string, name: string, step: string): boolean {
  const file = packageJsonPath(projectDir);
  const pkg = fs.readJsonSync(file) as PackageJson;
  const scripts = (pkg.scripts ??= {});
  const existing = scripts[name];
  if (existing?.includes(step)) return false;
  scripts[name] = existing ? `${existing} && ${step}` : step;
  writeJson(file, pkg);
  return true;
}

/** Appends an export line to a barrel, creating it if absent. */
export function appendExport(projectDir: string, barrel: string, line: string): boolean {
  const file = path.join(projectDir, barrel);
  if (!fs.existsSync(file)) {
    fs.ensureDirSync(path.dirname(file));
    fs.writeFileSync(file, `${line}\n`);
    return true;
  }
  const current = fs.readFileSync(file, "utf8");
  if (current.includes(line)) return false;
  fs.writeFileSync(file, current.replace(/\n*$/, "\n") + `${line}\n`);
  return true;
}

/** Appends a block to .env.example, skipping it if the key is already there. */
export function appendEnvExample(projectDir: string, key: string, block: string): boolean {
  const file = path.join(projectDir, ".env.example");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.includes(key)) return false;
  fs.writeFileSync(file, current === "" ? block : current.replace(/\n*$/, "\n\n") + block);
  return true;
}

/**
 * The root layout — `<routesDir>/+layout.svelte`. Every route renders inside it,
 * which is what makes it the composition root: the stylesheet import and the
 * query provider both belong here and nowhere else.
 */
export function rootLayoutPath(routesDir: string): string {
  return path.posix.join(routesDir, "+layout.svelte");
}

/**
 * The stylesheet the root layout imports, as it is written in the import.
 *
 * Read from the layout rather than guessed from a filename: `sv add tailwindcss`
 * has written `src/app.css` and `src/routes/layout.css` in different versions,
 * and the only thing that reliably names the live one is the import that pulls
 * it in.
 */
export function detectStylesheetImport(projectDir: string, layoutFile: string): string | undefined {
  const file = path.join(projectDir, layoutFile);
  if (!fs.existsSync(file)) return undefined;
  const match = /^\s*import\s+["'](\.[^"']*\.css|\$lib\/[^"']*\.css)["'];?\s*$/m.exec(fs.readFileSync(file, "utf8"));
  return match?.[1];
}

/**
 * Repoints the root layout's stylesheet import at the FSD app layer.
 *
 * The CSS moves because Tailwind v4's `@theme` is project-wide configuration,
 * which is app-layer, not route-adjacent. The import in `+layout.svelte` is its
 * only reference, and it is a *relative* path — so leaving it while the file
 * moves is not a stale import, it is an import that now resolves to a different
 * file or to nothing at all.
 */
export function patchLayoutStyleImport(
  projectDir: string,
  layoutFile: string,
  from: string,
  alias: string,
  stylesheet: string
): boolean {
  const file = path.join(projectDir, layoutFile);
  const source = fs.readFileSync(file, "utf8");
  const target = `import '${alias}/${stylesheet}';`;
  if (source.includes(target)) return false;

  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*)import\\s+["']${escaped}["'];?[ \\t]*$`, "m");
  const patched = source.replace(pattern, `$1${target}`);
  if (patched === source) return false;
  fs.writeFileSync(file, patched);
  return true;
}

/**
 * Names the tree Tailwind has to scan for class names.
 *
 * Automatic detection walks up from the stylesheet to the project root, so this
 * is belt-and-braces rather than strictly required — and it is cheap insurance
 * against the one failure mode that is invisible: a class that exists in a
 * component and in no stylesheet renders as nothing at all, with no error
 * anywhere. Inserted after the last `@import`, because an `@source` above
 * `@import "tailwindcss"` is ignored.
 */
export function addTailwindSource(cssFile: string, source: string): void {
  const contents = fs.readFileSync(cssFile, "utf8");
  if (contents.includes("@source")) return;

  const block =
    `\n/* This file lives in the FSD app layer rather than beside the routes, so\n` +
    `   name the tree Tailwind scans for class names instead of relying on where\n` +
    `   automatic detection decides the project root is. */\n` +
    `@source "${source}";\n`;

  const imports = [...contents.matchAll(/^@import .*$/gm)];
  const last = imports[imports.length - 1];
  // `last.index === 0` is a real position, not "not found" — a stylesheet whose
  // very first line is `@import "tailwindcss"` is the common case.
  if (last?.index === undefined) {
    fs.writeFileSync(cssFile, block.trimStart() + "\n" + contents);
    return;
  }
  const insertAt = contents.indexOf("\n", last.index) + 1;
  fs.writeFileSync(cssFile, contents.slice(0, insertAt) + block + contents.slice(insertAt));
}

const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.js",
  ".prettierrc.mjs",
  ".prettierrc.cjs",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.mjs",
  "prettier.config.cjs",
  "prettier.config.ts",
];

export function findPrettierConfig(projectDir: string): string | undefined {
  return PRETTIER_CONFIG_FILES.find((name) => fs.existsSync(path.join(projectDir, name)));
}

export function hasPrettierConfig(projectDir: string): boolean {
  if (findPrettierConfig(projectDir) !== undefined) return true;
  // A "prettier" key in package.json is a config too, and a common one.
  const pkg = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkg)) return false;
  try {
    return "prettier" in (fs.readJsonSync(pkg) as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * Repoints prettier's `tailwindStylesheet` at the moved stylesheet.
 *
 * `sv add prettier` writes that key pointing at wherever the Tailwind entry was
 * at the time, and Tailwind v4 has no config file for the plugin to fall back
 * on — so a stale pointer does not error, it just stops sorting classes.
 * Silent, and invisible until someone reads a diff and finds the order drifting
 * back. Text replace rather than a parse: the file is `.js` as often as it is
 * JSON, and only this one string needs to change.
 */
export function patchPrettierTailwindStylesheet(projectDir: string, stylesheet: string): string | undefined {
  const name = findPrettierConfig(projectDir);
  if (!name) return undefined;
  const file = path.join(projectDir, name);
  const source = fs.readFileSync(file, "utf8");
  const patched = source.replace(
    /(["']?tailwindStylesheet["']?\s*:\s*)(["'])[^"']*\2/,
    `$1$2./${stylesheet}$2`
  );
  if (patched === source) return undefined;
  fs.writeFileSync(file, patched);
  return name;
}

/**
 * Wraps the root layout's rendered children in `<Providers>`.
 *
 * `{@render children()}` appears exactly once in a SvelteKit root layout and is
 * unambiguous — unlike React's `{children}`, which is also the destructured
 * parameter. The import goes at the end of the `<script>` block, which is the
 * only place an import can go in a Svelte component.
 *
 * Regex, not an AST: this runs once, on a file whose shape `sv create` fixes,
 * and every way it can miss — already wrapped, no script block, no render tag —
 * returns without touching the file so the caller can print instructions.
 */
export function patchLayoutProviders(
  projectDir: string,
  layoutFile: string,
  alias: string
): "patched" | "already" | "manual" {
  const file = path.join(projectDir, layoutFile);
  if (!fs.existsSync(file)) return "manual";
  const source = fs.readFileSync(file, "utf8");
  if (/<Providers[\s>]/.test(source)) return "already";

  const render = /\{@render\s+children\??\.?\(\)\}/.exec(source);
  const scriptClose = source.indexOf("</script>");
  // index 0 is a real position for neither of these — a layout starts with
  // `<script`, so a match at 0 would mean a file with no script tag at all.
  if (!render || render.index === undefined || scriptClose === -1 || render.index < scriptClose) return "manual";

  // The render tag sits after the script block, so replacing it first keeps the
  // script offset computed from the original source valid.
  const wrapped =
    source.slice(0, render.index) +
    `<Providers>\n\t${render[0]}\n</Providers>` +
    source.slice(render.index + render[0].length);

  return write(file, withImport(wrapped, scriptClose, `import { Providers } from '${alias}/app/providers';`));
}

/**
 * Splices an import into a Svelte component's `<script>` block, after the last
 * import already there.
 *
 * Svelte hoists imports wherever they sit, so the placement is cosmetic — but a
 * project with an import-order lint rule would flag the alternative, and a
 * generated file that fails the project's own lint is a generated file people
 * delete instead of fixing.
 */
function withImport(source: string, scriptClose: number, line: string): string {
  const script = source.slice(0, scriptClose);
  const imports = [...script.matchAll(/^[ \t]*import .*$/gm)];
  const lastImport = imports[imports.length - 1];
  // index 0 is a real position: a script block whose first line is an import.
  const insertAt = lastImport?.index === undefined ? scriptClose : script.indexOf("\n", lastImport.index) + 1;
  return source.slice(0, insertAt) + `\t${line}\n` + source.slice(insertAt);
}

/**
 * Adds an import to the root layout — used for the stylesheet when there was no
 * stylesheet to move, so the file this CLI just created is actually loaded. A
 * stylesheet nothing imports is worse than none: it looks like the theme, and
 * editing it changes nothing.
 */
export function addLayoutImport(projectDir: string, layoutFile: string, line: string): boolean {
  const file = path.join(projectDir, layoutFile);
  if (!fs.existsSync(file)) return false;
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(line)) return false;

  const scriptClose = source.indexOf("</script>");
  if (scriptClose === -1) {
    // A layout with no script block at all — give it one.
    fs.writeFileSync(file, `<script lang="ts">\n\t${line}\n</script>\n\n${source}`);
    return true;
  }
  fs.writeFileSync(file, withImport(source, scriptClose, line));
  return true;
}

const ESLINT_CONFIG_FILES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.ts", "eslint.config.cjs"];

function findEslintConfig(projectDir: string): string | undefined {
  return ESLINT_CONFIG_FILES.map((name) => path.join(projectDir, name)).find((candidate) =>
    fs.existsSync(candidate)
  );
}

/**
 * Whether the project's own flat config already restricts imports.
 *
 * `init` runs on projects that are not empty. One that has written its own
 * `no-restricted-imports` block has an import boundary already — a second one
 * spread in from `eslint.fsd.js` is either a duplicate or a disagreement, and
 * flat config resolves a disagreement by silently keeping the last block that
 * matched the file. Leaving it alone is the only answer that cannot be wrong.
 */
export function eslintRestrictsImports(projectDir: string): boolean {
  const file = findEslintConfig(projectDir);
  return file !== undefined && fs.readFileSync(file, "utf8").includes("no-restricted-imports");
}

/**
 * Spreads the generated FSD boundary config into the project's flat ESLint
 * config.
 *
 * Two shapes, because `sv create` has written both: `export default someConst;`
 * and `export default defineConfig(a, b, c);` spread over thirty lines. The
 * second is why this does not look for an identifier and give up — it captures
 * whatever the default export evaluates to, names it, and appends our blocks
 * after it. `defineConfig(...)` and `ts.config(...)` both return arrays, so the
 * spread is valid for either.
 *
 * Appended **after** the project's own config on purpose: flat config lets a
 * later block override an earlier one, so the boundary rules win over anything
 * that disagrees rather than being silently dropped.
 */
export function patchEslintConfig(projectDir: string, configFile: string): "patched" | "already" | "manual" | "missing" {
  const file = findEslintConfig(projectDir);
  if (!file) return "missing";

  const source = fs.readFileSync(file, "utf8");
  if (source.includes(configFile)) return "already";

  const exportAt = source.lastIndexOf("export default");
  if (exportAt === -1) return "manual";
  // Anything after the default export would be re-ordered by the rewrite below,
  // so a config that keeps exporting things past it is left alone.
  if (/^\s*(export|import)\s/m.test(source.slice(exportAt + "export default".length))) return "manual";

  const expression = source
    .slice(exportAt + "export default".length)
    .trim()
    .replace(/;\s*$/, "");
  if (expression === "") return "manual";

  const imports = [...source.matchAll(/^import .*$/gm)];
  const lastImport = imports[imports.length - 1];
  // index 0 is a real position: a config whose first line is an import.
  if (lastImport?.index === undefined) return "manual";
  const importAt = source.indexOf("\n", lastImport.index) + 1;

  const rewritten =
    source.slice(0, exportAt) +
    `const baseConfig = ${expression};\n\n` +
    `export default [...baseConfig, ...fsdBoundary];\n`;
  return write(file, rewritten.slice(0, importAt) + `import fsdBoundary from './${configFile}';\n` + rewritten.slice(importAt));
}
