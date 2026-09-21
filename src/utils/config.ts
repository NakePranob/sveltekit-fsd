import path from "path";
import fs from "fs-extra";
import pc from "picocolors";
import { PackageManager, ProjectConfig, ProjectFeatures } from "../types";
import { Locale } from "./copy";
import { detectPackageManager, hasPrettierConfig, toPosix, writeJson } from "./project";

const CONFIG_FILE = "sveltekit-fsd.config.json";
export const CONFIG_SCHEMA_VERSION = 1;

export function configPath(projectDir: string): string {
  return path.join(projectDir, CONFIG_FILE);
}

export function isProjectDir(projectDir: string): boolean {
  return fs.existsSync(configPath(projectDir));
}

export type ProjectResolution =
  | { found: true; projectDir: string; via: "self" | "parent" | "workspace" }
  | { found: false; candidates: string[] };

/**
 * Workspace children of a monorepo root that hold a project config.
 *
 * Reads package.json `workspaces` in both shapes every manager documents —
 * a plain array (`["web"]`) and `{ packages: [...] }` — expanding exact
 * names plus one trailing `/*` level (`packages/*`). Anything fancier
 * (braces, `**`) is out of scope on purpose: half-matching a glob could
 * resolve to the wrong project, and a miss with a good error beats that.
 * A missing or unparseable package.json means no workspaces, not a failure.
 */
export function workspaceCandidates(startDir: string): string[] {
  const found: string[] = [];
  let entries: unknown = undefined;
  try {
    const pkg = fs.readJsonSync(path.join(startDir, "package.json")) as { workspaces?: unknown };
    entries = pkg.workspaces;
  } catch {
    return found;
  }
  const patterns =
    (Array.isArray(entries) ? entries : (entries as { packages?: unknown } | undefined)?.packages) ?? [];
  if (!Array.isArray(patterns)) return found;
  const seen = new Set<string>();
  const consider = (dir: string) => {
    const resolved = path.resolve(startDir, dir);
    if (!seen.has(resolved) && isProjectDir(resolved)) {
      seen.add(resolved);
      found.push(resolved);
    }
  };
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern === "") continue;
    if (pattern.endsWith("/*")) {
      const base = path.resolve(startDir, pattern.slice(0, -2));
      let children: string[] = [];
      try {
        children = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const child of children) consider(path.join(base, child));
    } else {
      consider(pattern);
    }
  }
  return found;
}

/**
 * Where the CLI actually works: the directory holding the config file.
 *
 * Commands used to read process.cwd() and nothing further, which broke the
 * two ways people really invoke them — from a subdirectory of the project
 * (…/src/pages/…) and from a monorepo root whose workspace holds the
 * project (bun/npm/yarn/pnpm `workspaces`). Both resolve here: upward first,
 * then a workspace child when exactly one holds a config. Several candidates
 * is a miss, not a guess — the caller reports them and the user picks.
 */
export function resolveProjectDir(startDir: string): ProjectResolution {
  const start = path.resolve(startDir);
  let dir = start;
  for (;;) {
    if (isProjectDir(dir)) {
      return { found: true, projectDir: dir, via: dir === start ? "self" : "parent" };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const candidates = workspaceCandidates(start);
  if (candidates.length === 1) {
    return { found: true, projectDir: candidates[0], via: "workspace" };
  }
  return { found: false, candidates };
}

/**
 * resolveProjectDir, but throwing the error a miss deserves: what was
 * searched, and — when workspaces hold configs — which directories to
 * re-run from instead of `init`, which would scaffold a second project in
 * the wrong place.
 */
export function requireProjectDir(startDir: string): string {
  const resolved = resolveProjectDir(startDir);
  if (!resolved.found) {
    const lines = [
      `no ${CONFIG_FILE} found — searched upward from ${startDir}, then its package.json workspaces.`,
    ];
    if (resolved.candidates.length > 1) {
      lines.push("Several workspaces hold a project; re-run from the one you mean:");
      for (const candidate of resolved.candidates) {
        lines.push(`  ${toPosix(path.relative(path.resolve(startDir), candidate))}`);
      }
    } else {
      lines.push("Run `sveltekit-fsd init` in a SvelteKit project first.");
    }
    throw new Error(lines.join("\n"));
  }
  if (resolved.via === "workspace") {
    console.log(pc.dim(`using project at ${toPosix(path.relative(path.resolve(startDir), resolved.projectDir))}`));
  }
  return resolved.projectDir;
}

export function writeConfig(projectDir: string, config: ProjectConfig): void {
  writeJson(configPath(projectDir), config);
}

/**
 * Detects which features are actually on disk.
 *
 * Every command reads the config file, but a key the file does not define used
 * to mean "false" to every caller — so `add auth` would re-install a shared/api
 * that was already there and clobber the catalog someone had filled in. The tree
 * always knew the answer; this stops the guessing. The file still wins wherever
 * it has a value: an explicit `false` is an answer, not a hole.
 */
export function detectFeatures(projectDir: string, srcDir = "src"): ProjectFeatures {
  const has = (relative: string) => fs.existsSync(path.join(projectDir, srcDir, relative));
  return {
    errorHandling: has("shared/api/client.ts"),
    auth: has("shared/auth/session.ts"),
    prettier: hasPrettierConfig(projectDir),
  };
}

export function readConfig(projectDir: string): ProjectConfig {
  const file = configPath(projectDir);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${projectDir} isn't a sveltekit-fsd project — no ${CONFIG_FILE}.\n` +
        "Run `sveltekit-fsd init` in a SvelteKit project first."
    );
  }

  const raw = fs.readJsonSync(file) as Partial<ProjectConfig>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  }

  const schemaVersion = raw.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`${CONFIG_FILE} has invalid schemaVersion "${String(schemaVersion)}" — expected a positive integer`);
  }
  if (schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `${CONFIG_FILE} uses schemaVersion ${schemaVersion}, but this CLI supports up to ${CONFIG_SCHEMA_VERSION} — upgrade sveltekit-fsd first`
    );
  }

  const srcDir = raw.srcDir ?? "src";
  const routesDir = raw.routesDir ?? `${srcDir}/app/routes`;
  if (!fs.existsSync(path.join(projectDir, routesDir))) {
    throw new Error(
      `${CONFIG_FILE} points routesDir at "${routesDir}", which doesn't exist — fix the path, or re-run \`sveltekit-fsd init\``
    );
  }

  const detected = detectFeatures(projectDir, srcDir);
  const features = { ...(raw.features ?? {}) } as Partial<ProjectFeatures>;
  for (const key of Object.keys(detected) as (keyof ProjectFeatures)[]) {
    if (typeof features[key] !== "boolean") features[key] = detected[key];
  }

  return {
    schemaVersion,
    locale: (raw.locale as Locale) ?? "th",
    srcDir,
    routesDir,
    alias: raw.alias ?? "@",
    packageManager: (raw.packageManager as PackageManager) ?? detectPackageManager(projectDir),
    features: features as ProjectFeatures,
    ...(raw.scaffoldVersion ? { scaffoldVersion: raw.scaffoldVersion } : {}),
  };
}

export function setFeature(projectDir: string, feature: keyof ProjectFeatures, value: boolean): void {
  const config = readConfig(projectDir);
  writeConfig(projectDir, { ...config, features: { ...config.features, [feature]: value } });
}
