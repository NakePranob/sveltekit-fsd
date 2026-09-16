#!/usr/bin/env node
// Drives the real binary through init -> add -> generate -> extend against a
// fixture, then inspects what came out. No network, no package install: the
// fixture is the smallest tree the CLI's detection accepts, and this repo's own
// node_modules is symlinked in so steiger can run over the result.
//
// Three checks, three different failures, none subsuming another:
//   - assertions on generated text  — a template that stopped emitting something
//   - `steiger` on the fixture      — a lint config that is inert or too strict
//   - `test:integration`            — a real SvelteKit app that builds and typechecks
// The middle one matters more than it looks: reading a generated steiger.config
// and asserting on its text cannot tell a working config from an inert one. A
// rule name the plugin does not have reads exactly the same as one it does.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "bin", "sveltekit-fsd.js");

let failures = 0;
const check = (ok, what) => {
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${what}`);
};

function makeFixture(name, { eslint = true, tailwind = true, vitest = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sveltekit-fsd-${name}-`));
  const devDependencies = {
    "@sveltejs/kit": "^2.63.0",
    svelte: "^5.56.1",
    ...(tailwind ? { tailwindcss: "^4.3.0" } : {}),
    ...(vitest ? { vitest: "^4.1.8" } : {}),
  };
  write(dir, "package.json", JSON.stringify({ name, private: true, type: "module", scripts: {}, devDependencies }, null, 2));
  write(
    dir,
    "vite.config.ts",
    `import adapter from '@sveltejs/adapter-auto';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n\tplugins: [\n\t\tsveltekit({\n\t\t\tadapter: adapter()\n\t\t})\n\t]\n});\n`
  );
  write(dir, "src/app.html", "<!doctype html>\n<html>\n\t<body>%sveltekit.body%</body>\n</html>\n");
  write(
    dir,
    "src/routes/+layout.svelte",
    tailwind
      ? `<script lang="ts">\n\timport './layout.css';\n\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n`
      : `<script lang="ts">\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n`
  );
  if (tailwind) write(dir, "src/routes/layout.css", "@import 'tailwindcss';\n");
  if (eslint) {
    write(
      dir,
      "eslint.config.js",
      `import js from '@eslint/js';\nimport { defineConfig } from 'eslint/config';\n\nexport default defineConfig(js.configs.recommended, {\n\trules: {}\n});\n`
    );
  }
  // steiger and its plugin are devDependencies of this repo precisely so the
  // fixture can borrow them without an install.
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

function write(dir, file, contents) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function read(dir, file) {
  return fs.readFileSync(path.join(dir, file), "utf8");
}

function exists(dir, file) {
  return fs.existsSync(path.join(dir, file));
}

function run(dir, args) {
  return execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Every generated file, so the whole-tree assertions below need no list. */
function generatedFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

console.log("smoke: full project (eslint + tailwind + vitest)");
const full = makeFixture("full", { vitest: true });
run(full, ["init", "--locale", "en", "--no-install", "--no-hooks", "--defaults"]);
run(full, ["add", "auth", "-y", "--no-install"]);
run(full, ["generate", "page", "dashboard", "--auth", "--title", "Dashboard", "--defaults"]);
run(full, ["generate", "layout", "admin", "--guard", "--defaults"]);
run(full, ["generate", "slice", "features", "checkout", "--segments", "ui,model,api,lib", "--errors"]);

// --- the layout init is responsible for -------------------------------------
check(exists(full, "src/app/routes/+layout.svelte"), "routes moved into the app layer");
check(!exists(full, "src/routes"), "the old routes directory is gone");
check(exists(full, "src/app/index.html"), "app.html moved to the app layer");
check(exists(full, "src/app/styles/app.css"), "the stylesheet moved to the app layer");
check(!exists(full, "src/routes/layout.css") && !exists(full, "src/app/routes/layout.css"), "no stylesheet left behind");

const vite = read(full, "vite.config.ts");
check(vite.includes("routes: 'src/app/routes'"), "kit.files.routes points at the app layer");
check(vite.includes("appTemplate: 'src/app/index.html'"), "kit.files.appTemplate points at the moved template");
check(!vite.includes("lib: '"), "kit.files.lib is left alone — $lib stays SvelteKit's");
check(vite.includes("'@/*': 'src/*'"), "the @ alias is declared");
check(vite.includes("adapter: adapter()"), "the project's own adapter survived the patch");

check(!exists(full, "tsconfig.json"), "tsconfig.json is not created — SvelteKit generates the alias half");
check(read(full, "src/app/routes/+layout.svelte").includes("'@/app/styles/app.css'"), "the stylesheet import was repointed through the alias");
check(read(full, "src/app/styles/app.css").includes("@source"), "Tailwind is told which tree to scan");

const eslintConfig = read(full, "eslint.config.js");
check(eslintConfig.includes("import fsdBoundary from './eslint.fsd.js'"), "the boundary config is imported");
check(eslintConfig.includes("export default [...baseConfig, ...fsdBoundary]"), "the boundary config is spread after the project's own");
check(eslintConfig.match(/export default/g).length === 1, "exactly one default export survives the patch");

const boundary = read(full, "eslint.fsd.js");
check(!/[`"']\$lib\//.test(boundary), "no boundary pattern pretends $lib is an FSD alias");
check(boundary.includes("src/app/routes/**"), "the routes tree gets its own block");
check(
  boundary.indexOf("src/app/**") < boundary.indexOf("src/app/routes/**"),
  "the routes block comes after the app block — flat config keeps the last match, not the union"
);

const steigerConfig = read(full, "steiger.config.ts");
check(steigerConfig.includes("./src/lib/**"), "steiger ignores SvelteKit's own $lib");
check(steigerConfig.includes("./src/app/routes/**"), "steiger ignores the routing tree");
check(
  JSON.parse(read(full, "package.json")).scripts.lint.includes("svelte-kit sync && steiger"),
  "lint syncs SvelteKit before steiger — .svelte-kit is gitignored, and steiger dies rather than degrades without it"
);

// --- what add and generate are responsible for ------------------------------
check(exists(full, "src/shared/api/client.ts"), "the api client is written");
check(exists(full, "src/shared/api/client.test.ts"), "a vitest project gets the client test");
check(read(full, "src/shared/api/client.test.ts").includes('from "vitest"'), "the test is written against the runner the project has");
check(exists(full, "src/app/providers/providers.svelte"), "the query provider is written");
const layout = read(full, "src/app/routes/+layout.svelte");
check(layout.includes("<Providers>") && layout.includes("{@render children()}"), "the root layout renders through Providers");
check(layout.indexOf("import { Providers }") < layout.indexOf("</script>"), "the Providers import is inside the script block");

check(exists(full, "src/pages/login/ui/login-form.svelte"), "the login form is written");
check(read(full, "src/shared/auth/require-session.ts").includes("ResolvedPathname"), "safeNext returns a type goto() accepts");
check(
  !/goto\(\s*[`'"]/.test(read(full, "src/shared/auth/require-session.ts") + read(full, "src/shared/auth/session.ts")),
  "no goto() takes a bare string — svelte/no-navigation-without-resolve is an error in a stock SvelteKit project"
);

check(exists(full, "src/pages/dashboard/ui/dashboard-page.svelte"), "the page component is written");
check(read(full, "src/app/routes/dashboard/+page.svelte").includes('from "@/pages/dashboard"'), "the route renders the page through its public API");
check(read(full, "src/pages/dashboard/ui/dashboard-page.svelte").includes("<svelte:head>"), "the page owns its own title");
check(exists(full, "src/app/layouts/admin-guard.svelte"), "the layout guard is written");
check(exists(full, "src/app/routes/(admin)/+layout.svelte"), "the layout is applied to a route group");

check(exists(full, "src/features/checkout/model/checkout.svelte.ts"), "a model segment is named .svelte.ts so its runes compile");
check(
  read(full, "src/features/checkout/index.ts").includes('from "./model/checkout.svelte"'),
  "and is imported without the .ts"
);
check(/createQuery<[^>]*>\(\(\) => \(\{/.test(read(full, "src/features/checkout/api/checkout.ts")), "query options are a function, so they stay reactive");

// --- the skills -------------------------------------------------------------
check(exists(full, ".agents/skills/sveltekit-fsd/SKILL.md"), "the CLI skill is written");
check(exists(full, ".agents/skills/feature-sliced-design/SKILL.md"), "the FSD methodology skill is written");
check(
  exists(full, ".agents/skills/feature-sliced-design/references/framework-integration.md"),
  "the methodology skill's references come with it"
);
check(
  read(full, ".agents/skills/feature-sliced-design/references/framework-integration.md").includes("## SvelteKit"),
  "the methodology skill knows about SvelteKit"
);
check(
  read(full, ".agents/skills/feature-sliced-design/references/cross-import-patterns.md").includes("{{ comment.text }}"),
  "the methodology skill is copied verbatim — Handlebars would have eaten this Vue example"
);
check(read(full, "AGENTS.md").includes("Feature-Sliced Design"), "AGENTS.md gained the FSD section");
// init leaves `kit.files.lib` alone, and every doc it writes has to say so. These
// four once told agents `$lib` and `@/` were one tree, which sends them to write
// `$lib/shared/...` imports that resolve nowhere.
for (const doc of [
  "docs/fsd.md",
  "AGENTS.md",
  ".agents/skills/sveltekit-fsd/SKILL.md",
  ".agents/skills/feature-sliced-design/references/framework-integration.md",
]) {
  const text = read(full, doc);
  check(!/^\s+lib: '|(is|are) the same tree/m.test(text), `${doc} does not claim $lib and @/ are one tree`);
}

// --- nothing a template should never emit -----------------------------------
for (const file of generatedFiles(full)) {
  const contents = fs.readFileSync(file, "utf8");
  // posix, because this is compared against a "/" path below and `path.relative`
  // hands back backslashes on Windows — where the comparison would silently stop
  // matching and the exemption would swallow the whole tree instead of one skill.
  const relative = path.relative(full, file).split(path.sep).join("/");
  // Only the methodology skill is exempt — it is copied byte-for-byte, Vue
  // examples and all. `.agents/skills/sveltekit-fsd/SKILL.md` IS rendered, and
  // skipping the whole `.agents/` tree would have exempted the one generated
  // file most likely to carry an unrendered expression.
  if (relative.includes("skills/feature-sliced-design/")) continue;
  if (relative.startsWith(".claude/")) continue; // the symlinked copy of both
  check(!contents.includes("{{"), `no unrendered Handlebars in ${relative}`);
  check(!contents.includes("\r\n"), `no CRLF in ${relative}`);
}

// --- extending, not rewriting ----------------------------------------------
const untouched = read(full, "src/features/checkout/ui/checkout.svelte");
run(full, ["generate", "slice", "features", "cart", "--segments", "ui", "--defaults"]);
run(full, ["generate", "slice", "features", "cart", "--segments", "ui,model", "--defaults"]);
check(exists(full, "src/features/cart/model/cart.svelte.ts"), "a second run adds the missing segment");
const cartIndex = read(full, "src/features/cart/index.ts");
check(cartIndex.includes("./ui/cart.svelte") && cartIndex.includes("./model/cart.svelte"), "and both exports are in the slice's index.ts");
check(cartIndex.match(/from ".\/ui\/cart.svelte"/g).length === 1, "without duplicating the export it already had");
check(read(full, "src/features/checkout/ui/checkout.svelte") === untouched, "an unrelated slice is left byte-for-byte alone");

check(
  fails(full, ["generate", "slice", "features", "cart", "--segments", "ui,model", "--defaults"], "already has every segment"),
  "a third run with nothing to add says so instead of writing"
);
check(
  fails(full, ["init", "--defaults"], "already a sveltekit-fsd project"),
  "init refuses to run twice"
);
check(
  fails(full, ["add", "auth", "-y"], "already installed"),
  "add auth refuses to run twice"
);

// A layout applied a second time adds one route file and no second export —
// even after `sv add prettier`'s singleQuote has rewritten the export line,
// which an exact-text match misses and appends again: a duplicate export is a
// syntax error. The rewrite is done by hand; this fixture has no prettier.
const layouts = path.join(full, "src/app/layouts/index.ts");
fs.writeFileSync(layouts, fs.readFileSync(layouts, "utf8").replaceAll('"', "'"));
run(full, ["generate", "layout", "admin", "--route", "reports-shell", "--defaults"]);
check(exists(full, "src/app/routes/reports-shell/+layout.svelte"), "an existing layout can be applied to a second route");
check(read(full, "src/app/layouts/index.ts").match(/AdminLayout/g).length === 1, "without exporting AdminLayout twice");

// A page generated under a route group does not get a second route file.
run(full, ["generate", "page", "reports", "--route", "(admin)/reports", "--defaults"]);
check(exists(full, "src/app/routes/(admin)/reports/+page.svelte"), "a page can be routed into a group");
run(full, ["generate", "page", "reports", "--errors", "--defaults"]);
check(!exists(full, "src/app/routes/reports/+page.svelte"), "and extending it does not add a second route for the same page");

// --- the linter has to actually be live -------------------------------------
// Reading steiger.config.ts and asserting on its text cannot tell a working
// config from an inert one: a rule name the plugin does not have reads exactly
// like one it does. So run it. `checkout` has no consumers, which is what
// fsd/insignificant-slice reports — as a *warning*, because a fresh slice
// failing CI teaches people to delete the linter rather than the slice.
const steiger = spawnBin(full, "steiger", ["./src"]);
check(steiger.status === 0, `steiger exits 0 on a freshly generated project (got ${steiger.status})`);
// stderr as well as stdout: steiger prints findings to stderr and still exits 0,
// so a check that only read stdout would pass against a linter saying nothing.
check(/insignificant-slice/.test(steiger.output), "steiger is live — it reports the unreferenced slice");
check(!/✘|error/i.test(steiger.output), "and reports no errors, so `lint` stays green after a generate");

// --- a half-installed project still has to lint clean -----------------------
// `add error-handling` writes shared/auth/access-token.ts, and `add auth` may
// not be run for months. A segment with one file and no index.ts is an error to
// steiger, so an add that reported success would leave `lint` red.
console.log("smoke: error handling without auth");
const half = makeFixture("half");
run(half, ["init", "--locale", "en", "--no-install", "--no-hooks", "--defaults"]);
run(half, ["add", "error-handling", "-y", "--no-install"]);
check(exists(half, "src/shared/auth/index.ts"), "shared/auth gets a public API from the add that creates it");
const halfSteiger = spawnBin(half, "steiger", ["./src"]);
check(halfSteiger.status === 0, `steiger exits 0 with error handling and no auth (got ${halfSteiger.status})`);
check(!/✘/.test(halfSteiger.output), `steiger reports no errors on a half-installed project:\n${halfSteiger.output}`);

// And `add auth` has to extend that file rather than overwrite it — the two
// commands can be months apart, long enough for the project to have added its
// own exports.
fs.appendFileSync(path.join(half, "src/shared/auth/index.ts"), 'export const PROJECT_OWNED = true;\n');
run(half, ["add", "auth", "-y", "--no-install"]);
const authIndex = read(half, "src/shared/auth/index.ts");
check(authIndex.includes("PROJECT_OWNED"), "add auth keeps what the project put in shared/auth/index.ts");
check(authIndex.includes("./access-token") && authIndex.includes("./session") && authIndex.includes("./require-session"),
  "and every export is there afterwards");
check(authIndex.match(/from "\.\/access-token"/g).length === 1, "without duplicating the line it already had");

// A config that already sets `alias` would override the one init adds — JS keeps
// the later of two equal keys — so init has to refuse, and refuse before it has
// moved anything: routes relocated with nothing pointing at them is no app.
console.log("smoke: a kit config init cannot patch safely");
const owned = makeFixture("owned");
write(
  owned,
  "vite.config.ts",
  `import { sveltekit } from '@sveltejs/kit/vite';\n\nexport default {\n\tplugins: [sveltekit({ alias: { $components: 'src/components' } })]\n};\n`
);
check(
  fails(owned, ["init", "--locale", "en", "--no-install", "--no-hooks", "--defaults"], "Nothing was moved"),
  "init refuses a config that already sets alias"
);
check(exists(owned, "src/routes/+layout.svelte") && exists(owned, "src/app.html"), "and moves nothing");
check(!exists(owned, "sveltekit-fsd.config.json"), "and writes nothing");

console.log("smoke: minimal project (no eslint, no tailwind, no vitest)");
const min = makeFixture("min", { eslint: false, tailwind: false });
const minOut = run(min, ["init", "--locale", "th", "--no-install", "--no-hooks", "--defaults"]);
check(!exists(min, "src/app/styles/app.css"), "no stylesheet is written for a project with no Tailwind");
check(/no Tailwind/.test(minOut), "and init says why, since the generated markup is Tailwind classes");
check(/no flat ESLint config found/.test(minOut), "init says what to do about a project with no ESLint");
check(exists(min, "eslint.fsd.js"), "but still writes the boundary config, ready for one");
run(min, ["add", "error-handling", "-y", "--no-install"]);
check(!exists(min, "src/shared/api/client.test.ts"), "no test is written for a project with no runner that resolves the alias");
check(/no client.test.ts written/.test(run(min, ["config", "show"])) === false, "config show does not repeat the add's advice");
check(/copy language\s+th/.test(run(min, ["config", "show"])), "config show reports the locale that was chosen");

if (failures > 0) {
  console.error(`\n${failures} smoke check${failures > 1 ? "s" : ""} failed`);
  process.exit(1);
}
console.log("\nsmoke: ok");

/** Runs a command that is expected to fail, and says whether it failed for the
 *  stated reason rather than by crashing somewhere else. */
function fails(dir, args, because) {
  try {
    run(dir, args);
    return false;
  } catch (error) {
    return String(error.stderr ?? "").includes(because);
  }
}

/**
 * Runs a dependency's CLI through node, resolved from its `bin` field rather
 * than from `node_modules/.bin`.
 *
 * `.bin/steiger` is a symlink to the real `.mjs` on unix and a shell shim on
 * Windows — so handing the `.bin` path to `node` works on one and fails with a
 * syntax error on the other, which reads as "the linter found problems".
 *
 * Both streams, deliberately: steiger prints its findings to stderr and still
 * exits 0 for a warning, so a check that only read stdout would pass against a
 * linter that said nothing at all.
 */
function spawnBin(dir, pkg, args) {
  const root = path.join(repo, "node_modules", pkg);
  const { bin } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = typeof bin === "string" ? bin : bin[pkg];
  const result = spawnSync(process.execPath, [path.join(root, entry), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
