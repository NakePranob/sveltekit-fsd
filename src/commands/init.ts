import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { ProjectConfig } from "../types";
import { confirm, select } from "../prompts";
import { CONFIG_SCHEMA_VERSION, detectFeatures, isProjectDir, writeConfig } from "../utils/config";
import { Locale, copyFor } from "../utils/copy";
import { applyTemplates, formatFiles, readTemplateTree, renderTemplate } from "../utils/render";
import {
  addDependencies,
  addLayoutImport,
  addTailwindSource,
  appendScript,
  detectKitConfig,
  detectPackageManager,
  detectStylesheetImport,
  eslintRestrictsImports,
  findRepoRoot,
  hasDependency,
  installCommitHook,
  installDependencies,
  kitConfigPatch,
  kitConfigSnippet,
  patchEslintConfig,
  patchLayoutStyleImport,
  patchPrettierTailwindStylesheet,
  rootLayoutPath,
  toPosix,
  writeAgentSkill,
} from "../utils/project";
import { cliVersion } from "../utils/version";

const STEIGER_DEV_DEPS = {
  "@feature-sliced/steiger-plugin": "^0.7.0",
  steiger: "^0.6.0",
};

const ESLINT_FSD_FILE = "eslint.fsd.js";

export interface InitOptions {
  locale?: Locale;
  install?: boolean;
  /** false when --no-hooks was passed: write no commit-msg hook. */
  hooks?: boolean;
  defaults?: boolean;
  yes?: boolean;
}

export async function initProject(projectDir: string, opts: InitOptions): Promise<void> {
  if (isProjectDir(projectDir)) {
    throw new Error(
      "already a sveltekit-fsd project (sveltekit-fsd.config.json exists) — use `generate` / `add` from here, or delete the config file to re-init"
    );
  }

  // Fails before anything is written if this is not a SvelteKit project, or if
  // its config is somewhere this CLI cannot find: every move below depends on
  // `kit.files` being repointed, and a half-initialised tree whose routes moved
  // while the config did not is a project that no longer builds.
  const kitConfig = detectKitConfig(projectDir);
  const srcDir = "src";
  const alias = "@";
  const routesDir = `${srcDir}/app/routes`;
  const appTemplate = `${srcDir}/app/index.html`;
  const stylesheet = `${srcDir}/app/styles/app.css`;
  // The same file as the alias spells it. `@/*` maps to `src/*`, so the `src/`
  // prefix is exactly what the alias replaces — writing `@/src/app/...` into an
  // import resolves to `src/src/app/...`, which is nothing.
  const aliasStylesheet = stylesheet.slice(srcDir.length + 1);
  const packageManager = detectPackageManager(projectDir);

  // Worked out now and written after the moves. A config this cannot patch has
  // to stop init here, while nothing has moved: routes relocated with no
  // `kit.files` pointing at them is an app with no pages.
  const kitOptions = { routesDir, appTemplate, alias, srcDir };
  const kitSource = kitConfigPatch(projectDir, kitConfig, kitOptions);
  if (kitSource === "manual") {
    throw new Error(
      `could not patch ${kitConfig.file} safely — it already sets \`files\` or \`alias\` (a second key would silently override one of them), ` +
        `or has no ${kitConfig.style === "vite" ? "`sveltekit({ ... })` options object" : "`kit: { ... }` block"} to add to. Nothing was moved.\n` +
        `Add this ${kitConfig.style === "vite" ? "inside the `sveltekit({ ... })` options" : "inside `kit: { ... }`"}, merged with what is there, then re-run \`sveltekit-fsd init\`:\n` +
        kitConfigSnippet(kitOptions)
    );
  }

  const currentRoutes = existingRoutesDir(projectDir, srcDir);
  if (currentRoutes === undefined) {
    throw new Error(
      `no routes directory found at ${srcDir}/routes or ${routesDir} — run \`sveltekit-fsd init\` inside a SvelteKit project`
    );
  }
  const currentAppHtml = [`${srcDir}/app.html`, appTemplate].find((candidate) =>
    fs.existsSync(path.join(projectDir, candidate))
  );

  const locale =
    opts.locale ??
    (opts.defaults
      ? "th"
      : ((await select({
          message: "Language for the generated user-facing copy?",
          choices: [
            { name: "Thai", value: "th" },
          { name: "English", value: "en" },
        ],
      })) as Locale));

  const install =
    opts.install ??
    (opts.defaults
      ? true
      : await confirm({
          message: `Install the generated dependencies with ${packageManager}?`,
          default: true,
        }));
  const hooks =
    opts.hooks ??
    (opts.defaults
      ? true
      : await confirm({
          message: "Install the Conventional Commit git hook?",
          default: true,
        }));

  // Read from the layout that is about to move, not from a guessed filename:
  // `sv add tailwindcss` has written src/app.css and src/routes/layout.css in
  // different versions, and the import is the only thing that names the live one.
  const layoutBefore = rootLayoutPath(currentRoutes);
  const styleImport = detectStylesheetImport(projectDir, layoutBefore);
  const styleBefore = styleImport === undefined ? undefined : resolveImport(currentRoutes, styleImport);
  const movesStylesheet = styleBefore !== undefined && fs.existsSync(path.join(projectDir, styleBefore));
  // Where that file ends up once the routes move. `sv add tailwindcss` writes it
  // *inside* the route tree these days, so it travels with it — and the path the
  // import resolved to before the move is not the path to read from after.
  const styleAfterRoutesMove =
    styleBefore !== undefined && styleBefore.startsWith(`${currentRoutes}/`)
      ? routesDir + styleBefore.slice(currentRoutes.length)
      : styleBefore;
  const hasTailwind = hasDependency(projectDir, "tailwindcss");

  // Files this would write that the project already has, and why they were left
  // that way. `init` is the one command that runs on somebody else's work —
  // refusing the batch over a steiger.config.ts they wrote last week leaves them
  // with nothing rather than with the parts they were missing.
  const left: string[] = [];
  const absent = (file: string, why: string): boolean => {
    if (!fs.existsSync(path.join(projectDir, file))) return true;
    left.push(`${file} ${pc.dim(`— ${why}`)}`);
    return false;
  };
  // Asked before anything is written, so the summary below can say it.
  const ownsImportRules = eslintRestrictsImports(projectDir);
  if (ownsImportRules) {
    left.push(`${ESLINT_FSD_FILE} ${pc.dim("— your eslint config already restricts imports")}`);
  }

  if (!(opts.yes || opts.defaults)) {
    console.log(pc.bold("\nThis will:"));
    for (const line of [
      `move ${pc.cyan(currentRoutes + "/")} to ${pc.cyan(routesDir + "/")} and ${pc.cyan(currentAppHtml ?? `${srcDir}/app.html`)} to ${pc.cyan(appTemplate)} — routing becomes part of the FSD app layer`,
      `point ${pc.cyan(kitConfig.file)} at both, and alias ${pc.cyan(`${alias}/*`)} to ./${srcDir}/* ${pc.dim("(tsconfig.json is left alone — SvelteKit generates that half)")}`,
      `leave ${pc.cyan(`${srcDir}/lib/`)} and ${pc.cyan("$lib")} exactly as they are — ${pc.dim("this CLI moves none of your code; shared/ is where the layers' shared code goes")}`,
      movesStylesheet
        ? `move ${pc.cyan(styleBefore!)} to ${pc.cyan(stylesheet)} and repoint the import in ${rootLayoutPath(routesDir)}`
        : hasTailwind
          ? `create ${pc.cyan(stylesheet)} and import it from ${pc.cyan(rootLayoutPath(routesDir))}`
          : pc.dim("write no stylesheet — this project has no Tailwind, and the generated markup is Tailwind utility classes"),
      ownsImportRules
        ? pc.yellow("leave your ESLint config alone — it already restricts imports, so the FSD boundary rules are not added")
        : `add ${pc.cyan(ESLINT_FSD_FILE)} — the import boundary as ESLint rules, so a wrong-way import is flagged in your editor (no new dependencies)`,
      `add steiger + the FSD plugin and a steiger.config.ts for the whole-tree checks ESLint cannot make, then chain both into the lint script`,
      `add ${pc.cyan("components.json")} so \`shadcn-svelte add\` writes into ${srcDir}/shared/ui`,
      `write ${pc.cyan("docs/fsd.md")}, a ${pc.cyan(".agents/skills/sveltekit-fsd")} and a ${pc.cyan(".agents/skills/feature-sliced-design")} skill at the repository root (symlinked from ${pc.cyan(".claude/skills/")}), and point AGENTS.md at them`,
      hooks === false
        ? pc.dim("write no git hook (--no-hooks)")
        : `write a ${pc.cyan("commit-msg")} hook that checks the subject is a Conventional Commit — shape only, your language and emoji rules stay yours — and point ${pc.cyan("core.hooksPath")} at it`,
    ]) {
      console.log(`  ${pc.dim("•")} ${line}`);
    }
    console.log();
    if (!(await confirm({ message: "Proceed?", default: true }))) {
      throw new Error("cancelled — nothing was written");
    }
  }

  const written: string[] = [];

  // The moves come first, and the config patch comes with them: between the two,
  // the project does not build. Everything that can fail — the config not being
  // patchable, a destination that already exists — has been checked above.
  if (currentRoutes !== routesDir) {
    await fs.move(path.join(projectDir, currentRoutes), path.join(projectDir, routesDir));
    written.push(`${routesDir}/ ${pc.dim(`(moved from ${currentRoutes}/)`)}`);
  }
  if (currentAppHtml !== undefined && currentAppHtml !== appTemplate) {
    await fs.move(path.join(projectDir, currentAppHtml), path.join(projectDir, appTemplate));
    written.push(`${appTemplate} ${pc.dim(`(moved from ${currentAppHtml})`)}`);
  }

  if (kitSource !== "already") {
    fs.writeFileSync(path.join(projectDir, kitConfig.file), kitSource);
    written.push(`${kitConfig.file} (kit.files + kit.alias)`);
  }

  const context = {
    srcDir,
    routesDir,
    alias,
    locale,
    stylesheet,
    copy: copyFor(locale),
    lintCommand: `${packageManager} run lint`,
    packageManager,
    // From the stylesheet up to src/ — the whole FSD tree, named for Tailwind
    // rather than left to wherever automatic detection decides the root is.
    cssSource: toPosix(path.relative(path.dirname(stylesheet), srcDir)),
    // The skills live at the repository root and docs/fsd.md lives in the
    // project — the same directory only in a single-package repo. In a monorepo
    // the link has to cross back into the workspace.
    docsFromSkill: toPosix(
      path.relative(
        path.join(findRepoRoot(projectDir), ".agents", "skills", "sveltekit-fsd"),
        path.join(path.resolve(projectDir), "docs", "fsd.md")
      )
    ),
  };

  // Before anything else is rendered, and that ordering is load-bearing. Moving
  // the stylesheet invalidates the `tailwindStylesheet` pointer in the project's
  // prettier config, and prettier-plugin-tailwindcss throws on a stylesheet that
  // is not there — which `formatFiles` swallows, quietly leaving every file
  // rendered before this point unformatted for `prettier --check` to find.
  if (movesStylesheet) {
    // Moved rather than copied: the import in +layout.svelte is its only
    // reference, and it is *relative* — leaving it behind while the layout moves
    // is not a stale import, it is one that resolves somewhere else.
    await fs.move(path.join(projectDir, styleAfterRoutesMove!), path.join(projectDir, stylesheet));
    written.push(`${stylesheet} ${pc.dim(`(moved from ${styleBefore})`)}`);
    if (hasTailwind) addTailwindSource(path.join(projectDir, stylesheet), context.cssSource);
    if (patchLayoutStyleImport(projectDir, rootLayoutPath(routesDir), styleImport!, alias, aliasStylesheet)) {
      written.push(`${rootLayoutPath(routesDir)} (stylesheet import)`);
    } else {
      console.log(
        pc.yellow(
          `\ncould not repoint the stylesheet import in ${rootLayoutPath(routesDir)} — change it to \`import '${alias}/${aliasStylesheet}';\` by hand.`
        )
      );
    }
    // prettier-plugin-tailwindcss has no Tailwind config file to fall back on in
    // v4, so a stale `tailwindStylesheet` does not error — it stops sorting.
    const prettierConfig = patchPrettierTailwindStylesheet(projectDir, stylesheet);
    if (prettierConfig) written.push(`${prettierConfig} (tailwindStylesheet)`);
  }


  written.push(
    ...(await applyTemplates(
      projectDir,
      [
        {
          template: "init/steiger.config.ts.hbs",
          output: "steiger.config.ts",
          when: () => absent("steiger.config.ts", "already there"),
        },
        {
          template: "init/eslint.fsd.js.hbs",
          output: ESLINT_FSD_FILE,
          when: () => !ownsImportRules && absent(ESLINT_FSD_FILE, "already there"),
        },
        { template: "init/fsd.md.hbs", output: "docs/fsd.md", when: () => absent("docs/fsd.md", "already there") },
        // Only where it would be loaded and would mean something. Writing a
        // stylesheet nothing imports, in a project with no Tailwind, is a file
        // that looks like the theme and changes nothing when edited.
        { template: "init/app.css.hbs", output: stylesheet, when: () => !movesStylesheet && hasTailwind },
        // Written before anyone runs `shadcn-svelte init`, because its own
        // defaults put components under $lib — outside the layers entirely. The
        // aliases here send them into shared/ui and shared/lib instead. Skipped
        // if the project already has one; that file is the user's decision.
        {
          template: "init/components.json.hbs",
          output: "components.json",
          when: () => absent("components.json", "your shadcn-svelte aliases, not ours"),
        },
      ],
      context
    ))
  );

  if (!movesStylesheet && hasTailwind && addLayoutImport(projectDir, rootLayoutPath(routesDir), `import '${alias}/${aliasStylesheet}';`)) {
    written.push(`${rootLayoutPath(routesDir)} (stylesheet import)`);
  }

  // "already" rather than "missing": nothing is wrong, there is simply no
  // boundary file of ours to spread in.
  const eslintPatch = ownsImportRules ? "already" : patchEslintConfig(projectDir, ESLINT_FSD_FILE);
  if (eslintPatch === "patched") written.push("eslint.config.js (spreads the FSD boundary rules)");
  // `svelte-kit sync` first, and not for tidiness: steiger resolves the `@/`
  // alias through the project's tsconfig, which does nothing but extend the
  // generated `.svelte-kit/tsconfig.json`. That directory is gitignored, so on a
  // fresh clone — or after anyone cleans build output — it is not there, and
  // steiger does not degrade, it dies with a MODULE_NOT_FOUND stack trace. The
  // project's own `check` script syncs for the same reason.
  if (appendScript(projectDir, "lint", `svelte-kit sync && steiger ./${srcDir}`)) {
    written.push("package.json (lint script)");
  }

  const hook =
    hooks === false ? undefined : installCommitHook(projectDir, renderTemplate("init/commit-msg.hbs", context));
  const agentDocs = writeAgentDocs(projectDir, { ...context, huskyOwnsHooks: hook?.huskyOwnsHooks ?? false }, hook);
  written.push(...agentDocs.written);
  if (hook?.status === "installed") written.push(`${hook.file} (+ core.hooksPath)`);

  const added = addDependencies(projectDir, STEIGER_DEV_DEPS, "devDependencies");

  const config: ProjectConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    locale,
    srcDir,
    routesDir,
    alias,
    packageManager,
    features: detectFeatures(projectDir, srcDir),
    scaffoldVersion: cliVersion(),
  };
  writeConfig(projectDir, config);
  written.push("sveltekit-fsd.config.json");

  // Everything init wrote or edited as text, run through the project's own
  // prettier if it has one. `applyTemplates` already did this for what it
  // rendered; these are the leftovers — the two configs that were patched, the
  // JSON this CLI wrote with its own indentation, and the docs and skills, which
  // matter most: they are markdown, and a project whose `.prettierignore` does
  // not exclude markdown would otherwise fail `prettier --check` on thousands of
  // lines nobody typed. Best-effort, so a project with no prettier is unaffected.
  await formatFiles(projectDir, [
    kitConfig.file,
    "eslint.config.js",
    "components.json",
    "steiger.config.ts",
    ESLINT_FSD_FILE,
    "docs/fsd.md",
    stylesheet,
    "sveltekit-fsd.config.json",
    ...agentDocs.formatted,
  ]);

  report(written, added);

  if (eslintPatch !== "patched" && eslintPatch !== "already") {
    console.log(
      pc.yellow(
        eslintPatch === "missing"
          ? `\nno flat ESLint config found — add one (\`npx sv add eslint\`), then spread the generated rules into it:`
          : "\ncould not patch your ESLint config automatically — spread the generated rules into it by hand:"
      ) +
        `\n  import fsdBoundary from "./${ESLINT_FSD_FILE}";` +
        "\n  export default [...yourConfig, ...fsdBoundary];"
    );
  }
  if (hook?.status === "exists") left.push(`${hook.file} ${pc.dim("— already there")}`);
  if (hook?.status === "foreign-hooks-path") {
    console.log(
      pc.yellow(`\nwrote ${hook.file}, but core.hooksPath points somewhere else — move it there, or repoint it.`)
    );
  }
  if (hook?.status === "no-repo") {
    console.log(
      pc.dim(
        "\nno git repository here, so no commit-msg hook. Run `sveltekit-fsd init` again after `git init`, or copy one in."
      )
    );
  }
  if (fs.existsSync(path.join(projectDir, srcDir, "lib"))) {
    left.push(
      `${srcDir}/lib/ ${pc.dim("— SvelteKit's own $lib directory. steiger ignores it; shared/ is where the layers' shared code goes, so do not grow this one.")}`
    );
  }
  if (left.length > 0) {
    console.log();
    for (const file of left) console.log(`  ${pc.dim("·")} left alone: ${file}`);
  }
  if (ownsImportRules) {
    console.log(
      pc.dim(
        "\nThe import boundary is documented in docs/fsd.md — compare it with the rules you have, " +
          "rather than running two sets that disagree."
      )
    );
  }

  if (added.length > 0 && install) {
    installDependencies(projectDir, packageManager);
  } else if (added.length > 0) {
    console.log(pc.yellow(`\nrun \`${packageManager} install\` to install: ${added.join(", ")}`));
  }

  if (!hasTailwind) {
    console.log(
      pc.yellow("\nthis project has no Tailwind, and everything this CLI generates is styled with Tailwind utility classes.") +
        pc.dim("\n  `npx sv add tailwindcss` is the one command; re-run `init` after it if you want the app-layer stylesheet too.")
    );
  }

  if (locale === "th") {
    console.log(
      pc.yellow("\nThai copy was generated. Load a Thai face before anyone reads it.") +
        `\n  ${pc.dim("A latin-only font stack has no Thai glyph, so the browser falls back per glyph and the UI renders in a face nobody chose.")}` +
        `\n  ${pc.dim("Thai also stacks two marks above a consonant plus a vowel below, which latin-tuned line heights clip — loosen --text-*--line-height per size in")} ${stylesheet}.`
    );
  }

  console.log(
    `\n${pc.bold("Next:")} ${pc.cyan(`${packageManager} run check`)} ${pc.dim("(it syncs SvelteKit, which is what makes the alias resolve)")}, then ` +
      `${pc.cyan("sveltekit-fsd generate page <name>")}, ${pc.cyan("sveltekit-fsd add error-handling")}, ` +
      `${pc.cyan("sveltekit-fsd add auth")}`
  );
}

/** Where SvelteKit's routes are right now — before init, or after a previous
 *  one that was interrupted. */
function existingRoutesDir(projectDir: string, srcDir: string): string | undefined {
  return [`${srcDir}/app/routes`, `${srcDir}/routes`].find((candidate) =>
    fs.existsSync(path.join(projectDir, candidate))
  );
}

/** A relative import in the root layout, as a path from the project root. */
function resolveImport(routesDir: string, specifier: string): string {
  return toPosix(path.posix.normalize(path.posix.join(routesDir, specifier)));
}

/**
 * Writes both skills, adds an FSD section to AGENTS.md (creating it if absent),
 * and a CLAUDE.md that includes it.
 *
 * AGENTS.md is appended to, never rewritten: it is usually already the project's
 * own instructions file, and the FSD conventions are one section of it. The
 * skills go to the repository root instead — see writeAgentSkill.
 */
function writeAgentDocs(
  projectDir: string,
  context: object,
  hook?: { status: string }
): { written: string[]; formatted: string[] } {
  const written: string[] = [];
  const formatted: string[] = [];

  const add = (name: string, skill: { files: string[]; note?: string }) => {
    formatted.push(...skill.files);
    const count = skill.files.length;
    written.push(`.agents/skills/${name}/ ${pc.dim(`(${count} file${count > 1 ? "s" : ""})`)}`);
    if (skill.note) written.push(skill.note);
  };

  // Same content as the AGENTS.md section, aimed at the tool that loads skills —
  // an agent's instinct on "add a settings screen" is to hand-write the files,
  // which is exactly what the two linters then report.
  add("sveltekit-fsd", writeAgentSkill(projectDir, "sveltekit-fsd", {
    "SKILL.md": renderTemplate("init/skill.md.hbs", context),
  }));
  // The methodology itself, shipped rather than linked: "should this be an
  // entity" is the question that decides whether the generator is being used
  // well, and an agent that cannot answer it generates a plausible wrong shape.
  add("feature-sliced-design", writeAgentSkill(projectDir, "feature-sliced-design", readTemplateTree("init/fsd-skill")));

  const section = renderTemplate("init/agents-section.md.hbs", context);
  const agents = path.join(projectDir, "AGENTS.md");

  if (!fs.existsSync(agents)) {
    fs.writeFileSync(agents, `# AGENTS.md\n${section}`);
    written.push("AGENTS.md");
  } else if (!fs.readFileSync(agents, "utf8").includes("Feature-Sliced Design")) {
    fs.appendFileSync(agents, section);
    written.push("AGENTS.md (FSD section appended)");
  }

  // Only when a hook exists to enforce it — a convention nothing checks is a
  // convention this CLI has no standing to write into someone's AGENTS.md.
  if (hook && hook.status !== "no-repo" && !fs.readFileSync(agents, "utf8").includes("Conventional Commit")) {
    fs.appendFileSync(agents, renderTemplate("init/git-section.md.hbs", context));
    written.push("AGENTS.md (commit convention appended)");
  }
  formatted.push("AGENTS.md");

  const claude = path.join(projectDir, "CLAUDE.md");
  if (!fs.existsSync(claude)) {
    fs.writeFileSync(claude, renderTemplate("init/claude.md.hbs", context));
    written.push("CLAUDE.md");
    formatted.push("CLAUDE.md");
  }
  return { written, formatted };
}

export function report(written: string[], added: string[] = []): void {
  console.log();
  for (const file of written) console.log(`  ${pc.green("+")} ${file}`);
  for (const dep of added) console.log(`  ${pc.green("+")} ${pc.dim("package.json:")} ${dep}`);
}
