// The patchers edit files this CLI did not write, which makes them the riskiest
// code in the repo: a miss that guesses produces a project that does not build,
// hours later, on somebody else's machine. Every case below is one that was
// either seen in a real `sv create` output or is a shape the regex could plausibly
// mangle.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// pathToFileURL, not the bare path: ESM `import()` takes a URL, and on Windows
// an absolute path starts `D:\` — which the loader reads as a `d:` protocol and
// rejects. On a unix host the two spellings are indistinguishable, so this only
// ever fails in CI.
const dist = (file) => pathToFileURL(path.join(repo, "dist", "utils", file)).href;

const {
  addLayoutImport,
  appendExport,
  detectKitConfig,
  detectKitMajor,
  detectStylesheetImport,
  eslintRestrictsImports,
  patchEslintConfig,
  patchKitConfig,
  patchLayoutProviders,
  packageImportsStatus,
  patchEnvFile,
  patchLayoutStyleImport,
  patchPackageImports,
  patchPrettierTailwindStylesheet,
  stylesheetSpecifier,
  subpathImport,
} = await import(dist("project.js"));
const { validateRoute, normalizeRoute } = await import(dist("naming.js"));

const KIT_OPTIONS = {
  routesDir: "src/app/routes",
  appTemplate: "src/app/index.html",
  alias: "@",
  srcDir: "src",
};

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sveltekit-fsd-test-"));
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

const KIT_PKG = JSON.stringify({ name: "x", devDependencies: { "@sveltejs/kit": "^2.63.0" } });

test("detectKitConfig prefers the vite config, because SvelteKit does", () => {
  // Not a preference: `load_config` tries the Vite config first and only falls
  // back to svelte.config.js. Writing to the file that is not read is a silent
  // failure with correct values in it.
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({})] };\n",
    "svelte.config.js": "export default { kit: {} };\n",
  });
  assert.deepEqual(detectKitConfig(dir, 2), { file: "vite.config.ts", style: "vite" });
});

test("detectKitConfig falls back to svelte.config.js, and ignores a vite config with no sveltekit() in it", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "export default { plugins: [] };\n",
    "svelte.config.js": "export default { kit: {} };\n",
  });
  assert.deepEqual(detectKitConfig(dir, 2), { file: "svelte.config.js", style: "svelte" });
});

test("detectKitMajor refuses a project that is not SvelteKit", () => {
  const dir = fixture({ "package.json": JSON.stringify({ name: "x" }), "vite.config.ts": "" });
  assert.throws(() => detectKitMajor(dir), /@sveltejs\/kit/);
});

const kitPkg = (range) => JSON.stringify({ name: "x", devDependencies: { "@sveltejs/kit": range } });
const installedKit = (version) => JSON.stringify({ name: "@sveltejs/kit", version });

test("detectKitMajor reads the declared range when nothing is installed", () => {
  // `sv create --no-install` then `init` is a supported order, so there may be
  // no node_modules yet.
  assert.equal(detectKitMajor(fixture({ "package.json": kitPkg("^3.0.0") })), 3);
  assert.equal(detectKitMajor(fixture({ "package.json": kitPkg("~2.63.0") })), 2);
  assert.equal(detectKitMajor(fixture({ "package.json": kitPkg("npm:@sveltejs/kit@^3.0.0") })), 3);
});

test("detectKitMajor believes the installed package over the declared range", () => {
  // `>=2` or a stale caret says nothing about what the lockfile resolved; the
  // installed package is what actually runs.
  const dir = fixture({
    "package.json": kitPkg("^2.63.0"),
    "node_modules/@sveltejs/kit/package.json": installedKit("3.0.0"),
  });
  assert.equal(detectKitMajor(dir), 3);
});

test("detectKitMajor finds a package hoisted above the project, as Node would", () => {
  const dir = fixture({
    "node_modules/@sveltejs/kit/package.json": installedKit("3.1.0"),
    "web/package.json": kitPkg("workspace:*"),
  });
  assert.equal(detectKitMajor(path.join(dir, "web")), 3);
});

test("detectKitMajor refuses to guess", () => {
  // The two majors get a different config shape and import map; a wrong guess
  // is written into somebody's project.
  for (const range of ["latest", "next", "workspace:^"]) {
    assert.throws(() => detectKitMajor(fixture({ "package.json": kitPkg(range) })), /Install dependencies, then re-run/, range);
  }
});

test("detectKitMajor refuses a major it does not support, and names the ones it does", () => {
  assert.throws(() => detectKitMajor(fixture({ "package.json": kitPkg("^4.0.0") })), /SvelteKit 4 — this CLI supports SvelteKit 2 and 3/);
  assert.throws(() => detectKitMajor(fixture({ "package.json": kitPkg("^1.30.0") })), /supports SvelteKit 2 and 3/);
});

test("detectKitConfig on SvelteKit 3 refuses svelte.config.js instead of patching it", () => {
  // Kit 3 throws when that file exists, so values written there are read by
  // nothing — the routes would move with no config pointing at them.
  const dir = fixture({
    "package.json": kitPkg("^3.0.0"),
    "vite.config.ts": "export default { plugins: [] };\n",
    "svelte.config.js": "export default { kit: {} };\n",
  });
  assert.throws(() => detectKitConfig(dir, 3), /SvelteKit 3 reads its config only from vite\.config/);
  assert.deepEqual(
    detectKitConfig(fixture({ "package.json": kitPkg("^3.0.0"), "vite.config.ts": "plugins: [sveltekit()]\n" }), 3),
    { file: "vite.config.ts", style: "vite" }
  );
});

test("patchKitConfig keeps everything already in the sveltekit() options", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts":
      "import { sveltekit } from '@sveltejs/kit/vite';\n\nexport default defineConfig({\n\tplugins: [\n\t\tsveltekit({\n\t\t\tcompilerOptions: { runes: true },\n\t\t\tadapter: adapter()\n\t\t})\n\t]\n});\n",
  });
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS), "patched");
  const patched = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
  assert.match(patched, /routes: 'src\/app\/routes'/);
  assert.match(patched, /'@\/\*': 'src\/\*'/);
  assert.match(patched, /adapter: adapter\(\)/, "the project's own adapter survives");
  assert.match(patched, /compilerOptions: \{ runes: true \}/, "and so do its compiler options");
});

test("patchKitConfig gives a bare sveltekit() an options object", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "import { sveltekit } from '@sveltejs/kit/vite';\n\nexport default { plugins: [sveltekit()] };\n",
  });
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS), "patched");
  const patched = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
  assert.match(patched, /sveltekit\(\{/);
  assert.match(patched, /appTemplate: 'src\/app\/index\.html'/);
  assert.equal(patched.includes("sveltekit()"), false);
});

test("patchKitConfig writes into kit: { } for a svelte.config.js", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "svelte.config.js": "const config = {\n\tkit: {\n\t\tadapter: adapter()\n\t}\n};\n\nexport default config;\n",
  });
  assert.equal(patchKitConfig(dir, { file: "svelte.config.js", style: "svelte" }, KIT_OPTIONS), "patched");
  const patched = fs.readFileSync(path.join(dir, "svelte.config.js"), "utf8");
  assert.match(patched, /kit: \{\n\t\tfiles: \{/);
  assert.match(patched, /adapter: adapter\(\)/);
});

test("patchKitConfig reports rather than guesses when there is nowhere to put it", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "export default { plugins: [sveltekit(...shared)] };\n",
  });
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS), "manual");
  assert.equal(
    fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8"),
    "export default { plugins: [sveltekit(...shared)] };\n",
    "and leaves the file exactly as it was"
  );
});

test("patchKitConfig refuses an options object that already sets files or alias", () => {
  // Ours would go in first, and JavaScript keeps the later of two equal keys:
  // the project's `alias` silently replaces `@/*`, its `files` the moved routes.
  for (const options of ["alias: { $components: 'src/components' }", "files: { lib: 'src/lib' }"]) {
    const source = `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({ ${options} })] };\n`;
    const dir = fixture({ "package.json": KIT_PKG, "vite.config.ts": source });
    assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS), "manual", options);
    assert.equal(fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8"), source, "and leaves the file alone");
  }
});

test("patchKitConfig is idempotent", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({})] };\n",
  });
  patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS);
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS), "already");
});

const KIT3_OPTIONS = { ...KIT_OPTIONS, alias: "#" };

test("patchKitConfig writes files and no alias on the # spelling", () => {
  // Kit 3 deprecates `alias` and warns on every config load; the # spelling
  // lives in package.json imports instead.
  const dir = fixture({
    "package.json": kitPkg("^3.0.0"),
    "vite.config.ts": "export default defineConfig({\n\tplugins: [\n\t\tsveltekit({\n\t\t\tadapter: adapter()\n\t\t})\n\t]\n});\n",
  });
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT3_OPTIONS), "patched");
  const patched = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
  assert.match(patched, /routes: 'src\/app\/routes'/);
  assert.match(patched, /appTemplate: 'src\/app\/index\.html'/);
  assert.equal(patched.includes("alias"), false);
  assert.match(patched, /adapter: adapter\(\)/);
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT3_OPTIONS), "already");
});

test("patchKitConfig on the # spelling keeps the project's own alias, and still refuses a second files", () => {
  const withAlias = "export default { plugins: [sveltekit({ alias: { $components: 'src/components' } })] };\n";
  const dir = fixture({ "package.json": kitPkg("^3.0.0"), "vite.config.ts": withAlias });
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT3_OPTIONS), "patched");
  assert.match(fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8"), /\$components: 'src\/components'/);

  const withFiles = "export default { plugins: [sveltekit({ files: { routes: 'x' } })] };\n";
  const owned = fixture({ "package.json": kitPkg("^3.0.0"), "vite.config.ts": withFiles });
  assert.equal(patchKitConfig(owned, { file: "vite.config.ts", style: "vite" }, KIT3_OPTIONS), "manual");
  assert.equal(fs.readFileSync(path.join(owned, "vite.config.ts"), "utf8"), withFiles);
});

test("patchPackageImports adds the # map beside sv's own #lib, keeping the tabs", () => {
  // `sv create` writes package.json with tabs; reindenting it is a diff on a
  // file nobody touched, and a `prettier --check` failure.
  const pkg = '{\n\t"name": "x",\n\t"imports": {\n\t\t"#lib": "./src/lib/index.js",\n\t\t"#lib/*": "./src/lib/*"\n\t}\n}\n';
  const dir = fixture({ "package.json": pkg });
  const entries = subpathImport("#", "src");
  assert.deepEqual(entries, { "#/*": "./src/*/index.ts" });
  assert.equal(packageImportsStatus(dir, entries), "missing");
  assert.equal(patchPackageImports(dir, entries), "patched");
  const written = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  assert.match(written, /\n\t\t"#\/\*": "\.\/src\/\*\/index\.ts"/);
  assert.deepEqual(Object.keys(JSON.parse(written).imports), ["#lib", "#lib/*", "#/*"]);
  assert.equal(patchPackageImports(dir, entries), "already");
});

test("patchPackageImports refuses a # map that already points somewhere else", () => {
  const pkg = JSON.stringify({ name: "x", imports: { "#/*": "./src/*" } }, null, 2);
  const dir = fixture({ "package.json": pkg });
  assert.equal(packageImportsStatus(dir, subpathImport("#", "src")), "manual");
  assert.equal(patchPackageImports(dir, subpathImport("#", "src")), "manual");
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg, "and leaves the file alone");
});

const ENV_DECLARATION = "PUBLIC_API_URL: { public: true }";

test("patchEnvFile adds a variable to the project's own defineEnvVars, leaving the rest alone", () => {
  const source =
    "import { defineEnvVars } from '@sveltejs/kit/env';\n\nexport const variables = defineEnvVars({\n\tDATABASE_URL: {},\n\tPORT: { schema: (v) => Number(v ?? 3000) }\n});\n";
  const dir = fixture({ "src/env.ts": source });
  assert.equal(patchEnvFile(dir, "src/env.ts", "PUBLIC_API_URL", ENV_DECLARATION), "patched");
  const patched = fs.readFileSync(path.join(dir, "src/env.ts"), "utf8");
  assert.match(patched, /defineEnvVars\(\{\n\tPUBLIC_API_URL: \{ public: true \},\n\tDATABASE_URL: \{\},/);
  assert.equal(patched.replace(`\n\t${ENV_DECLARATION},`, ""), source, "everything that was there is byte-for-byte intact");
  assert.equal(patchEnvFile(dir, "src/env.ts", "PUBLIC_API_URL", ENV_DECLARATION), "already");
});

test("patchEnvFile finds a call at the very start of the file", () => {
  // index 0 is a real position.
  const dir = fixture({ "src/env.ts": "defineEnvVars({});\n" });
  assert.equal(patchEnvFile(dir, "src/env.ts", "PUBLIC_API_URL", ENV_DECLARATION), "patched");
  assert.match(fs.readFileSync(path.join(dir, "src/env.ts"), "utf8"), /^defineEnvVars\(\{\n\tPUBLIC_API_URL/);
});

test("patchEnvFile reports rather than guesses when there is no defineEnvVars({ to add to", () => {
  const source = "import { defineEnvVars } from '@sveltejs/kit/env';\nimport { shared } from './shared';\n\nexport const variables = defineEnvVars(shared);\n";
  const dir = fixture({ "src/env.ts": source });
  assert.equal(patchEnvFile(dir, "src/env.ts", "PUBLIC_API_URL", ENV_DECLARATION), "manual");
  assert.equal(fs.readFileSync(path.join(dir, "src/env.ts"), "utf8"), source);
});

test("patchEslintConfig handles the defineConfig(...) call sv create writes", () => {
  const dir = fixture({
    "eslint.config.js":
      "import js from '@eslint/js';\nimport ts from 'typescript-eslint';\n\nexport default defineConfig(\n\tjs.configs.recommended,\n\tts.configs.recommended,\n\t{ rules: {} }\n);\n",
  });
  assert.equal(patchEslintConfig(dir, "eslint.fsd.js"), "patched");
  const patched = fs.readFileSync(path.join(dir, "eslint.config.js"), "utf8");
  assert.match(patched, /^import fsdBoundary from '\.\/eslint\.fsd\.js';$/m);
  assert.match(patched, /const baseConfig = defineConfig\(/);
  assert.match(patched, /export default \[\.\.\.baseConfig, \.\.\.fsdBoundary\];/);
  assert.equal(patched.match(/export default/g).length, 1, "exactly one default export");
  assert.equal(
    patched.indexOf("import fsdBoundary") < patched.indexOf("const baseConfig"),
    true,
    "the import comes before the use"
  );
});

test("patchEslintConfig puts its import after a wrapped import, not inside it", () => {
  const dir = fixture({
    "eslint.config.js":
      "import js from '@eslint/js';\nimport {\n\tdefineConfig,\n\tglobalIgnores\n} from 'eslint/config';\n\nexport default defineConfig(js.configs.recommended);\n",
  });
  assert.equal(patchEslintConfig(dir, "eslint.fsd.js"), "patched");
  const patched = fs.readFileSync(path.join(dir, "eslint.config.js"), "utf8");
  assert.match(patched, /\} from 'eslint\/config';\nimport fsdBoundary from '\.\/eslint\.fsd\.js';\n/);
});

test("patchEslintConfig handles `export default someConst;`", () => {
  const dir = fixture({ "eslint.config.js": "import js from '@eslint/js';\n\nconst config = [];\n\nexport default config;\n" });
  assert.equal(patchEslintConfig(dir, "eslint.fsd.js"), "patched");
  const patched = fs.readFileSync(path.join(dir, "eslint.config.js"), "utf8");
  assert.match(patched, /const baseConfig = config;/);
  assert.match(patched, /export default \[\.\.\.baseConfig, \.\.\.fsdBoundary\];/);
});

test("patchEslintConfig leaves a config alone when something follows the default export", () => {
  // The rewrite moves the export to the end of the file, so anything after it
  // would change order. A wrong edit here is worse than printed instructions.
  const dir = fixture({
    "eslint.config.js": "import js from '@eslint/js';\n\nexport default [];\n\nexport const extra = 1;\n",
  });
  assert.equal(patchEslintConfig(dir, "eslint.fsd.js"), "manual");
});

test("patchEslintConfig says `missing` rather than inventing a config", () => {
  assert.equal(patchEslintConfig(fixture({}), "eslint.fsd.js"), "missing");
});

test("eslintRestrictsImports notices a project that already has a boundary", () => {
  const dir = fixture({ "eslint.config.js": "export default [{ rules: { 'no-restricted-imports': ['error'] } }];\n" });
  assert.equal(eslintRestrictsImports(dir), true);
  assert.equal(eslintRestrictsImports(fixture({ "eslint.config.js": "export default [];\n" })), false);
});

test("patchLayoutProviders wraps the render tag and imports inside the script block", () => {
  const dir = fixture({
    "src/app/routes/+layout.svelte":
      "<script lang=\"ts\">\n\timport favicon from '$lib/assets/favicon.svg';\n\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n",
  });
  assert.equal(patchLayoutProviders(dir, "src/app/routes/+layout.svelte", "@"), "patched");
  const patched = fs.readFileSync(path.join(dir, "src/app/routes/+layout.svelte"), "utf8");
  assert.match(patched, /<Providers>\n\t\{@render children\(\)\}\n<\/Providers>/);
  assert.equal(patched.indexOf("import { Providers }") < patched.indexOf("</script>"), true);
  assert.equal(
    patched.indexOf("import favicon") < patched.indexOf("import { Providers }"),
    true,
    "after the imports already there, not before them"
  );
  assert.equal(patchLayoutProviders(dir, "src/app/routes/+layout.svelte", "@"), "already");
});

test("patchLayoutProviders puts its import after a wrapped import, not inside it", () => {
  const dir = fixture({
    "src/app/routes/+layout.svelte":
      "<script lang=\"ts\">\n\timport {\n\t\tonMount\n\t} from 'svelte';\n\n\tlet { children } = $props();\n</script>\n\n{@render children()}\n",
  });
  assert.equal(patchLayoutProviders(dir, "src/app/routes/+layout.svelte", "@"), "patched");
  const patched = fs.readFileSync(path.join(dir, "src/app/routes/+layout.svelte"), "utf8");
  assert.match(patched, /\t\} from 'svelte';\n\timport \{ Providers \} from '@\/app\/providers';\n/);
});

test("patchLayoutProviders reports rather than mangling a layout with no render tag", () => {
  const dir = fixture({ "src/app/routes/+layout.svelte": "<script>\n\tlet { children } = $props();\n</script>\n<slot />\n" });
  assert.equal(patchLayoutProviders(dir, "src/app/routes/+layout.svelte", "@"), "manual");
});

test("detectStylesheetImport reads the live stylesheet out of the layout", () => {
  // Read, not guessed from a filename: `sv add tailwindcss` has written
  // src/app.css and src/routes/layout.css in different versions.
  const dir = fixture({
    "a/+layout.svelte": "<script>\n\timport './layout.css';\n</script>\n",
    "b/+layout.svelte": "<script>\n\timport '../app.css';\n</script>\n",
    "c/+layout.svelte": "<script>\n\timport { thing } from './thing';\n</script>\n",
  });
  assert.equal(detectStylesheetImport(dir, "a/+layout.svelte"), "./layout.css");
  assert.equal(detectStylesheetImport(dir, "b/+layout.svelte"), "../app.css");
  assert.equal(detectStylesheetImport(dir, "c/+layout.svelte"), undefined);
});

test("patchLayoutStyleImport repoints the import it was given, and nothing else", () => {
  const dir = fixture({
    "src/app/routes/+layout.svelte":
      "<script lang=\"ts\">\n\timport './layout.css';\n\timport other from './layout.css.js';\n</script>\n",
  });
  assert.equal(patchLayoutStyleImport(dir, "src/app/routes/+layout.svelte", "./layout.css", "@/app/styles/app.css"), true);
  const patched = fs.readFileSync(path.join(dir, "src/app/routes/+layout.svelte"), "utf8");
  assert.match(patched, /import '@\/app\/styles\/app\.css';/);
  assert.match(patched, /import other from '\.\/layout\.css\.js';/, "a longer specifier that starts the same is untouched");
  assert.equal(patchLayoutStyleImport(dir, "src/app/routes/+layout.svelte", "./layout.css", "@/app/styles/app.css"), false);
});

test("stylesheetSpecifier goes through @, and is relative on the # spelling", () => {
  // The # map ends every specifier in /index.ts, so #/app/styles/app.css would
  // resolve to app.css/index.ts. Both files are in the app layer anyway.
  assert.equal(stylesheetSpecifier("src/app/routes", "src/app/styles/app.css", "@", "src"), "@/app/styles/app.css");
  assert.equal(stylesheetSpecifier("src/app/routes", "src/app/styles/app.css", "#", "src"), "../styles/app.css");

  const dir = fixture({ "src/app/routes/+layout.svelte": "<script lang=\"ts\">\n\timport './layout.css';\n</script>\n" });
  assert.equal(patchLayoutStyleImport(dir, "src/app/routes/+layout.svelte", "./layout.css", "../styles/app.css"), true);
  assert.match(fs.readFileSync(path.join(dir, "src/app/routes/+layout.svelte"), "utf8"), /import '\.\.\/styles\/app\.css';/);
  assert.equal(patchLayoutStyleImport(dir, "src/app/routes/+layout.svelte", "./layout.css", "../styles/app.css"), false, "and a second run is a no-op");
});

test("patchPrettierTailwindStylesheet repoints the plugin at the moved stylesheet", () => {
  // A stale pointer does not error — Tailwind v4 has no config file to fall back
  // on, so the plugin simply stops sorting classes. Silent, until a diff drifts.
  const dir = fixture({
    "prettier.config.js": "export default {\n\tuseTabs: true,\n\ttailwindStylesheet: './src/routes/layout.css'\n};\n",
  });
  assert.equal(patchPrettierTailwindStylesheet(dir, "src/app/styles/app.css"), "prettier.config.js");
  assert.match(fs.readFileSync(path.join(dir, "prettier.config.js"), "utf8"), /'\.\/src\/app\/styles\/app\.css'/);
  assert.equal(patchPrettierTailwindStylesheet(fixture({ ".prettierrc": "{}" }), "x.css"), undefined);
  assert.equal(patchPrettierTailwindStylesheet(fixture({}), "x.css"), undefined);
});

test("addLayoutImport gives a script-less layout a script block", () => {
  const dir = fixture({ "src/app/routes/+layout.svelte": "{@render children()}\n" });
  assert.equal(addLayoutImport(dir, "src/app/routes/+layout.svelte", "import '@/app/styles/app.css';"), true);
  const patched = fs.readFileSync(path.join(dir, "src/app/routes/+layout.svelte"), "utf8");
  assert.match(patched, /^<script lang="ts">\n\timport '@\/app\/styles\/app\.css';\n<\/script>/);
  assert.equal(addLayoutImport(dir, "src/app/routes/+layout.svelte", "import '@/app/styles/app.css';"), false);
});

test("appendExport recognises a line prettier has already rewritten", () => {
  // The line is written with double quotes; `sv add prettier` sets singleQuote,
  // and a long line comes back wrapped with a trailing comma. Appending it again
  // would be a duplicate export — a syntax error.
  const line = 'export { sessionKey, useLogin, type Session } from "./session";';
  const dir = fixture({
    "a.ts": "export { sessionKey, useLogin, type Session } from './session';\n",
    "b.ts": "export {\n\tsessionKey,\n\tuseLogin,\n\ttype Session,\n} from './session';\n",
  });
  assert.equal(appendExport(dir, "a.ts", line), false);
  assert.equal(appendExport(dir, "b.ts", line), false);
  assert.equal(appendExport(dir, "a.ts", 'export { useLogout } from "./session";'), true, "a different export still goes in");
});

test("validateRoute accepts SvelteKit's own segment forms and rejects the rest", () => {
  for (const route of ["dashboard", "(admin)/dashboard", "loans/[id]", "docs/[...slug]", "[[lang]]/home", "loans/[id=integer]", ""]) {
    assert.equal(validateRoute(route), true, route);
  }
  for (const route of ["Dashboard", "a b", "loans/[id", "(admin"]) {
    assert.notEqual(validateRoute(route), true, route);
  }
  assert.equal(normalizeRoute("/dashboard/"), "dashboard");
});
