#!/usr/bin/env node
// Slow and networked, and the only check that proves the generated code is real:
// a genuine `sv create`, a genuine install, then svelte-check, eslint, steiger,
// vitest and vite build over what this CLI produced.
//
// The smoke test cannot do any of this. It asserts on generated *text*, which
// catches a template that stopped emitting something and nothing else — a
// template can emit perfectly plausible Svelte that does not compile, or call a
// TanStack Query API that moved between majors, and read fine to every
// assertion. This is also the only place a declared dependency range is
// actually resolved.
import { execFileSync, spawn as spawnProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "bin", "sveltekit-fsd.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sveltekit-fsd-integration-"));
const app = path.join(dir, "app");

// Which `sv` scaffolds the app, and so which SvelteKit major is under test:
// `latest` makes a Kit 3 project; 0.17.1 is the last `sv` that makes a Kit 2 one.
// CI runs both.
const svVersion = process.env.SV_VERSION ?? "latest";

// What SvelteKit 3 prints when a project leans on an API it deprecated. A fresh
// project this CLI wrote must not trip any of them — `alias` is the option the
// whole import spelling used to rest on, and it is slated for removal.
const KIT3_DEPRECATIONS = ["config_option_deprecated_alias", "env_module_deprecated"];

const step = (what) => console.log(`\n▸ ${what}`);

function run(command, args, cwd = app) {
  console.log(`  $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** Runs a command that may legitimately be noisy, and returns both streams plus
 *  the exit code — steiger reports warnings on stderr and still exits 0. */
function capture(command, args, cwd = app) {
  console.log(`  $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

step(`sv@${svVersion} create`);
run(
  "npx",
  ["-y", `sv@${svVersion}`, "create", "app", "--template", "minimal", "--types", "ts",
   "--add", "prettier", "eslint", "tailwindcss=plugins:none", "vitest=usages:unit", "--no-install"],
  dir
);

step("sveltekit-fsd init / add / generate");
run(process.execPath, [cli, "init", "--locale", "en", "--no-install", "--no-hooks", "--defaults"]);
run(process.execPath, [cli, "add", "auth", "-y", "--no-install"]);
run(process.execPath, [cli, "generate", "page", "dashboard", "--auth", "--title", "Dashboard", "--defaults"]);
run(process.execPath, [cli, "generate", "page", "reports", "settings", "--no-route", "--defaults"]);
run(process.execPath, [cli, "generate", "page", "admin/profile", "--root", "src/domain", "--route", "admin/profile", "--defaults"]);
run(process.execPath, [cli, "generate", "layout", "admin", "--guard", "--defaults"]);
run(process.execPath, [cli, "generate", "slice", "features", "checkout", "--segments", "ui,model,api,lib,config", "--errors"]);
run(process.execPath, [cli, "generate", "slice", "e", "employee/employee-record", "profile", "-s", "ui", "api", "-r", "src/domain", "--defaults"]);

step("install");
run("npm", ["install"]);

if (fs.existsSync(path.join(app, ".claude/settings.json")) || fs.existsSync(path.join(app, ".claude/hooks"))) {
  throw new Error("init installed an agent lifecycle hook or modified agent settings");
}

// Re-run the formatter pass the CLI could not do before node_modules existed.
// `init` formats what it writes with the project's own prettier, and on a fresh
// clone there is none to resolve yet — so the check below would otherwise fail
// on files that the normal flow (create, install, init) formats fine.
step("format the files init wrote before prettier existed");
run("npx", ["prettier", "--write", "."]);

const kitMajor = Number(JSON.parse(fs.readFileSync(path.join(app, "node_modules/@sveltejs/kit/package.json"), "utf8")).version.split(".")[0]);
const alias = JSON.parse(fs.readFileSync(path.join(app, "sveltekit-fsd.config.json"), "utf8")).alias;
console.log(`\n  SvelteKit ${kitMajor}, imports spelled ${alias}/`);

step("svelte-check — this is the typecheck, and it needs svelte-kit sync first");
const check = capture("npm", ["run", "check"]);
if (check.status !== 0) throw new Error(`npm run check failed (exit ${check.status})`);
if (kitMajor === 3) failOnDeprecations("npm run check", check.output);

step("eslint — the FSD boundary, plus the project's own rules");
run("npx", ["eslint", "."]);

step("the boundary rules have to bite, not just load");
// A config that loads and matches nothing reads exactly like one that works.
// In the project's own spelling: on `#`, an unescaped pattern is a gitignore
// comment, and a probe written with `@/` would never have noticed.
fs.mkdirSync(path.join(app, "src/shared/lib"), { recursive: true });
fs.writeFileSync(
  path.join(app, "src/shared/lib/boundary-probe.ts"),
  `import { DashboardPage } from "${alias}/pages/dashboard";\n\nexport const probe = DashboardPage;\n`
);
const probe = capture("npx", ["eslint", "src/shared/lib/boundary-probe.ts"]);
if (probe.status === 0 || !probe.output.includes("no-restricted-imports")) {
  throw new Error("eslint.fsd.js did not flag an upward import from shared/ — the boundary is inert");
}
fs.rmSync(path.join(app, "src/shared/lib"), { recursive: true });

step("steiger — whole-tree, and it must stay green on generated code");
const steiger = capture("npx", ["steiger", "./src"]);
if (steiger.status !== 0) throw new Error(`steiger failed on a freshly generated project (exit ${steiger.status})`);
if (!steiger.output.includes("insignificant-slice")) {
  throw new Error("steiger reported nothing at all — the config is inert, not clean");
}

step("vitest — the generated refresh and open-redirect tests");
run("npm", ["test"]);

step("vite build");
run("npm", ["run", "build"]);

// The only check here that runs the code rather than reading it. Everything
// above — svelte-check, eslint, steiger, vite build — passed against a
// `requireSession` that called `$effect` from a plain `.ts`, where runes are
// never compiled and the identifier survives into the output. `$effect` is a
// declared global, so the types were fine; the page 500s at request time with
// "$effect is not defined". Nothing static can see that, so this asks the dev
// server for the pages instead.
step("render the generated pages — the guarded one included");
await renderCheck([
  ["/login", "the login page `add auth` wrote"],
  ["/dashboard", "a page generated with --auth, whose guard calls $effect"],
]);

step("lint — prettier --check included, since `add prettier` puts it there");
run("npm", ["run", "lint"]);

// The ship path, which nothing else exercises: every test above runs the CLI
// out of the checkout, where `getTemplatesRoot` finds templates/ one directory
// further up than it does once installed. A template tree left out of `files`,
// or a candidate path that only works from source, fails here and nowhere else.
step("pack, install the tarball, and generate with that");
const packed = path.join(dir, "packed");
fs.mkdirSync(packed, { recursive: true });
run("npm", ["pack", "--pack-destination", packed], repo);
const tarball = path.join(packed, fs.readdirSync(packed).find((f) => f.endsWith(".tgz")));
fs.writeFileSync(path.join(packed, "package.json"), JSON.stringify({ name: "host", private: true }));
run("npm", ["install", tarball], packed);
const installed = path.join(packed, "node_modules", ".bin", "sveltekit-fsd");
run(installed, ["generate", "slice", "entities", "loan", "--segments", "ui", "--defaults"]);
if (!fs.existsSync(path.join(app, "src/entities/loan/ui/loan.svelte"))) {
  throw new Error("the installed CLI did not render its templates");
}

console.log(`\nintegration: ok\n${app}`);

function failOnDeprecations(where, output) {
  const hit = KIT3_DEPRECATIONS.filter((code) => output.includes(code));
  if (hit.length > 0) throw new Error(`${where} printed SvelteKit 3 deprecations: ${hit.join(", ")}`);
}

/** Starts the dev server, asks it for each route, and fails on anything that is
 *  not a 200 — printing the server's own log, which is where the stack is. */
async function renderCheck(routes) {
  const port = 5199;
  const log = [];
  // Its own process group, so the whole tree can be taken down at the end.
  // `npm run dev` is a parent of vite, and signalling only the parent leaves
  // vite running with the inherited pipes open — which keeps this script's event
  // loop alive after it has printed its result, and the job is then killed by
  // its timeout having actually passed.
  const dev = spawnProcess("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: app,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  dev.stdout.on("data", (d) => log.push(String(d)));
  dev.stderr.on("data", (d) => log.push(String(d)));

  try {
    const base = `http://localhost:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await fetch(base);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`dev server never came up:\n${log.join("")}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    for (const [route, what] of routes) {
      const response = await fetch(base + route);
      console.log(`  ${route} -> ${response.status}`);
      if (!response.ok) {
        throw new Error(`${route} (${what}) rendered ${response.status}, not 200:\n${log.join("")}`);
      }
    }
    // The env module is only loaded once a page renders, so this is the first
    // point its deprecation could show up.
    if (kitMajor === 3) failOnDeprecations("the dev server", log.join(""));
  } finally {
    try {
      process.kill(-dev.pid, "SIGKILL"); // the group, not just npm
    } catch {
      dev.kill("SIGKILL");
    }
    dev.stdout.destroy();
    dev.stderr.destroy();
    dev.unref();
  }
}
