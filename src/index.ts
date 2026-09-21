#!/usr/bin/env node
import path from "path";
import { Command } from "commander";
import pc from "picocolors";

import { NO_TTY_MESSAGE, select } from "./prompts";
import { initProject } from "./commands/init";
import { generateLayout, generatePage, generatePages, generateSlice, generateSlices } from "./commands/generate";
import { addAuth, addErrorHandling, addPrettier } from "./commands/add";
import { setProjectLocale, showProjectConfig } from "./commands/config";
import { isProjectDir, readConfig, requireProjectDir, resolveProjectDir } from "./utils/config";
import { toPosix } from "./utils/project";
import { parseLocale } from "./utils/copy";
import { cliVersion } from "./utils/version";

// fail is every command's catch, in one place so the two non-obvious cases stay
// consistent. @inquirer/prompts throws ExitPromptError on Ctrl-C and its raw
// message ("User force closed the prompt with 0 null") tells a user nothing. The
// no-TTY case normally never reaches here — prompts.ts rejects before a prompt
// starts — but stdin can also close mid-prompt, which arrives as the same error
// and deserves the same advice rather than "aborted".
function fail(err: unknown): void {
  const message = (err as Error).message ?? String(err);
  if ((err as Error).name === "ExitPromptError") {
    console.error(pc.red(process.stdin.isTTY ? "aborted" : NO_TTY_MESSAGE));
  } else {
    console.error(pc.red(message));
  }
  process.exitCode = 1;
}

const program = new Command();
program
  .name("sveltekit-fsd")
  .description(
    "Keep a SvelteKit project on Feature-Sliced Design.\n\n" +
      "SvelteKit creates the app (`sv create`); this only shapes what is inside it: `init` once — which moves routing " +
      "into the FSD app layer — then `generate` for slices and `add` for the API error handling, auth wiring and formatting.\n\n" +
      "Run `sveltekit-fsd` or `sveltekit-fsd wizard` to pick what to do from a menu. Commands ask for whatever you omit; " +
      "`--defaults` answers every question for CI."
  )
  .version(cliVersion());

program
  .command("init")
  .description("shape an existing SvelteKit project into FSD layers (run this once, after `sv create`)")
  .option("--locale <locale>", 'language for the generated user-facing copy: "th" (default) or "en"')
  .option("--no-install", "write the files but do not run the package manager")
  .option("--no-hooks", "write no commit-msg hook and leave core.hooksPath alone")
  .option("--defaults", "skip every question; Thai copy, and no confirmation")
  .option("-y, --yes", "skip only the confirmation summary")
  .action(async (opts: {
    locale?: string;
    install?: boolean;
    hooks?: boolean;
    defaults?: boolean;
    yes?: boolean;
  }) => {
    try {
      await initProject(process.cwd(), {
        locale: parseLocale(opts.locale),
        install: opts.install,
        hooks: opts.hooks,
        defaults: opts.defaults,
        yes: opts.yes || opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

async function runGenerateWizard(): Promise<void> {
  const target = await select({
    message: "What do you want to generate?",
    choices: [
      { name: "Page (a pages slice plus its +page.svelte)", value: "page" },
      { name: "Slice (features / entities / widgets)", value: "slice" },
      { name: "Layout (shared chrome for a group of routes)", value: "layout" },
    ],
  });
  if (target === "page") await generatePage(undefined, {});
  else if (target === "slice") await generateSlice(undefined, undefined, {});
  else await generateLayout(undefined, {});
}

const generate = program
  .command("generate")
  .alias("g")
  .description("add a page, slice or layout; bare `generate` opens a target wizard")
  .action(async () => {
    try {
      await runGenerateWizard();
    } catch (err) {
      fail(err);
    }
  });

generate
  .command("page [name...]")
  .alias("p")
  .description("scaffold one or more pages slices and their thin route files")
  .option("--title <title>", "heading and browser title; defaults to the Title Case of the page name")
  .option(
    "--route <path>",
    'route path; defaults to the page name. Route groups and dynamic segments work: "(admin)/dashboard", "loans/[id]"'
  )
  .option("--no-route", "write the slice only, no route file")
  .option("--auth", "the page sits behind requireSession (needs `add auth`)")
  .option("--api", "add api/<name>.ts, this page's TanStack Query hooks (needs `add error-handling`)")
  .option("--model", "legacy alias for --api; add api/<name>.ts (needs `add error-handling`)")
  .option("--errors", "add model/<name>-errors.ts, this page's own error catalog (needs `add error-handling`)")
  .option("-r, --root <path>", "FSD root for the pages layer; defaults to the project's configured srcDir")
  .option("--defaults", "skip every question; no guard, route = the page name")
  .action(async (names, opts) => {
    try {
      // commander folds --no-route into the same `route` key: false when it was
      // passed, a string when --route was, undefined when neither.
      const noRoute = opts.route === false;
      await generatePages(names, {
        title: opts.title,
        route: noRoute ? undefined : opts.route,
        routeFile: noRoute ? false : undefined,
        auth: opts.auth,
        api: opts.api,
        model: opts.model,
        errors: opts.errors,
        root: opts.root,
        defaults: opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

generate
  .command("slice [layer] [name...]")
  .alias("s")
  .description("scaffold one or more features/entities/widgets slices with only the segments they need")
  .option("-s, --segments <list...>", "space- or comma-separated: ui,model,api,lib,config (default ui)")
  .option("-r, --root <path>", "FSD root for the layers; defaults to the project's configured srcDir")
  .option("--errors", "add model/<name>-errors.ts, this slice's own error catalog (needs `add error-handling`)")
  .option("--defaults", "skip every question; ui segment only")
  .action(async (layer, names, opts) => {
    try {
      await generateSlices(layer, names, {
        segments: opts.segments,
        errors: opts.errors,
        root: opts.root,
        defaults: opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

generate
  .command("layout [name]")
  .alias("l")
  .description("scaffold a shared route shell in app/layouts plus the +layout.svelte that renders it")
  .option("--route <path>", 'where it applies; defaults to the route group "(<name>)". A real segment works too: "admin"')
  .option("--no-route", "write the component only, no +layout.svelte")
  .option("--guard", "every route under it sits behind the session, in one component (needs `add auth`)")
  .option("--defaults", "skip every question; route = the (<name>) group, no guard")
  .action(async (name, opts) => {
    try {
      const noRoute = opts.route === false;
      await generateLayout(name, {
        route: noRoute ? undefined : opts.route,
        routeFile: noRoute ? false : undefined,
        guard: opts.guard,
        defaults: opts.defaults,
      });
    } catch (err) {
      fail(err);
    }
  });

async function runAddWizard(): Promise<void> {
  // Read once, up front: the menu should say what is already installed rather
  // than letting someone walk a confirmation to reach "already installed".
  const config = readConfig(requireProjectDir(process.cwd()));
  const target = await select({
    message: "What do you want to add?",
    choices: [
      {
        name: "Error handling (ApiError, per-domain catalogs, axios client with a 401 refresh, QueryClient)",
        value: "errors",
        disabled: config.features.errorHandling ? "— already installed" : false,
      },
      {
        name: "Auth (access token in memory, session hooks, route guard, login page)",
        value: "auth",
        disabled: config.features.auth ? "— already installed" : false,
      },
      {
        name: "Prettier (svelte parser, Tailwind class sorting, a format script, and a check on lint)",
        value: "prettier",
        disabled: config.features.prettier ? "— already installed" : false,
      },
    ],
  });
  if (target === "errors") await addErrorHandling({});
  else if (target === "prettier") await addPrettier({});
  else await addAuth({});
}

const add = program
  .command("add")
  .description("add shared infrastructure; bare `add` opens an error-handling/auth/prettier wizard")
  .action(async () => {
    try {
      await runAddWizard();
    } catch (err) {
      fail(err);
    }
  });

add
  .command("error-handling")
  .alias("errors")
  .description(
    "add shared/api: ApiError, per-domain error catalogs, a resolver, an axios client with a single-flight 401 refresh, and a QueryClient"
  )
  .option("--no-install", "write the files but do not run the package manager")
  .option("-y, --yes", "skip the confirmation summary")
  .action(async (opts: { install?: boolean; yes?: boolean }) => {
    try {
      await addErrorHandling({ install: opts.install, yes: opts.yes });
    } catch (err) {
      fail(err);
    }
  });

add
  .command("prettier")
  .description(
    "add prettier with the svelte parser and the Tailwind class-sorting plugin pointed at the moved stylesheet, a format script, and a --check on lint"
  )
  .option("--no-install", "write the files but do not run the package manager")
  .option("-y, --yes", "skip the confirmation summary")
  .action(async (opts: { install?: boolean; yes?: boolean }) => {
    try {
      await addPrettier({ install: opts.install, yes: opts.yes });
    } catch (err) {
      fail(err);
    }
  });

add
  .command("auth")
  .description(
    "add shared/auth and a login page: access token in memory, session hooks, requireSession (installs error handling first if missing)"
  )
  .option("--no-install", "write the files but do not run the package manager")
  .option("-y, --yes", "skip the confirmation summary")
  .action(async (opts: { install?: boolean; yes?: boolean }) => {
    try {
      await addAuth({ install: opts.install, yes: opts.yes });
    } catch (err) {
      fail(err);
    }
  });

const config = program
  .command("config")
  .description("inspect the project config")
  .action(() => {
    try {
      showProjectConfig();
    } catch (err) {
      fail(err);
    }
  });

config
  .command("set <key> <value>")
  .description("change a project setting; only `locale` (th|en) is settable, and it affects future generation only")
  .action((key: string, value: string) => {
    try {
      if (key !== "locale") {
        throw new Error(`unknown setting "${key}" — only \`locale\` can be set (th or en)`);
      }
      setProjectLocale(value);
    } catch (err) {
      fail(err);
    }
  });

config
  .command("show")
  .description("print the resolved project config and which features are installed")
  .action(() => {
    try {
      showProjectConfig();
    } catch (err) {
      fail(err);
    }
  });

// runTopMenu is bare `sveltekit-fsd` — the command name is the one thing people
// remember, so give the same "ask, then delegate" menu the subcommands give when
// run bare, instead of Commander's static help (which lists commands but never
// lets you act on one).
//
// Deliberately NOT a .action() on the root: giving the root an action makes it
// callable, which turns a mistyped subcommand into "too many arguments" instead
// of Commander's "unknown command 'ad' (Did you mean add?)".
async function runTopMenu(): Promise<void> {
  if (!isProjectDir(process.cwd())) {
    // A monorepo root is not a project, but one of its workspaces may be —
    // sending that to `init` would scaffold a second project in the wrong
    // place, so point at the workspace instead of starting anything.
    const resolved = resolveProjectDir(process.cwd());
    if (resolved.found) {
      console.log(
        pc.dim(`found a project at ${toPosix(path.relative(process.cwd(), resolved.projectDir))} — re-run from there.\n`)
      );
      return;
    }
    if (resolved.candidates.length > 0) {
      console.log(pc.dim("several workspaces hold a project — re-run from the one you mean:"));
      for (const candidate of resolved.candidates) {
        console.log(pc.dim(`  ${toPosix(path.relative(process.cwd(), candidate))}`));
      }
      console.log();
      return;
    }
    console.log(pc.dim(`${process.cwd()} isn't a sveltekit-fsd project yet — only "init" can run here.\n`));
    await initProject(process.cwd(), {});
    return;
  }

  const target = await select({
    message: "What do you want to do?",
    choices: [
      { name: "Generate (a page, a slice or a layout)", value: "generate" },
      { name: "Add (error handling / auth / prettier)", value: "add" },
      { name: "Show the project config", value: "config" },
    ],
  });
  if (target === "generate") await runGenerateWizard();
  else if (target === "add") await runAddWizard();
  else showProjectConfig();
}

program
  .command("wizard")
  .alias("menu")
  .description("open the interactive menu for init, generate, add and config")
  .action(async () => {
    try {
      await runTopMenu();
    } catch (err) {
      fail(err);
    }
  });

if (process.argv.length <= 2) {
  runTopMenu().catch(fail);
} else {
  program.parseAsync(process.argv);
}
