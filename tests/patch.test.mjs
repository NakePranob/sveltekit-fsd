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
  detectKitConfig,
  detectStylesheetImport,
  eslintRestrictsImports,
  patchEslintConfig,
  patchKitConfig,
  patchLayoutProviders,
  patchLayoutStyleImport,
  patchPrettierTailwindStylesheet,
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
  assert.deepEqual(detectKitConfig(dir), { file: "vite.config.ts", style: "vite" });
});

test("detectKitConfig falls back to svelte.config.js, and ignores a vite config with no sveltekit() in it", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "export default { plugins: [] };\n",
    "svelte.config.js": "export default { kit: {} };\n",
  });
  assert.deepEqual(detectKitConfig(dir), { file: "svelte.config.js", style: "svelte" });
});

test("detectKitConfig refuses a project that is not SvelteKit", () => {
  const dir = fixture({ "package.json": JSON.stringify({ name: "x" }), "vite.config.ts": "" });
  assert.throws(() => detectKitConfig(dir), /@sveltejs\/kit/);
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

test("patchKitConfig is idempotent", () => {
  const dir = fixture({
    "package.json": KIT_PKG,
    "vite.config.ts": "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({})] };\n",
  });
  patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS);
  assert.equal(patchKitConfig(dir, { file: "vite.config.ts", style: "vite" }, KIT_OPTIONS), "already");
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
  assert.equal(patchLayoutStyleImport(dir, "src/app/routes/+layout.svelte", "./layout.css", "@", "app/styles/app.css"), true);
  const patched = fs.readFileSync(path.join(dir, "src/app/routes/+layout.svelte"), "utf8");
  assert.match(patched, /import '@\/app\/styles\/app\.css';/);
  assert.match(patched, /import other from '\.\/layout\.css\.js';/, "a longer specifier that starts the same is untouched");
  assert.equal(patchLayoutStyleImport(dir, "src/app/routes/+layout.svelte", "./layout.css", "@", "app/styles/app.css"), false);
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

test("validateRoute accepts SvelteKit's own segment forms and rejects the rest", () => {
  for (const route of ["dashboard", "(admin)/dashboard", "loans/[id]", "docs/[...slug]", "[[lang]]/home", "loans/[id=integer]", ""]) {
    assert.equal(validateRoute(route), true, route);
  }
  for (const route of ["Dashboard", "a b", "loans/[id", "(admin"]) {
    assert.notEqual(validateRoute(route), true, route);
  }
  assert.equal(normalizeRoute("/dashboard/"), "dashboard");
});
