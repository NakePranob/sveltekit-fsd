import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { ProjectConfig } from "../types";
import { confirm } from "../prompts";
import { readConfig, requireProjectDir, setFeature } from "../utils/config";
import { asCatalogEntries, copyFor } from "../utils/copy";
import { applyTemplates, formatFiles, TemplateEntry } from "../utils/render";
import {
  addDependencies,
  appendEnvExample,
  appendExport,
  appendScript,
  hasDependency,
  installDependencies,
  patchLayoutProviders,
  rootLayoutPath,
  runCommand,
} from "../utils/project";
import { report } from "./init";

const API_DEPS = {
  "@tanstack/svelte-query": "^6.1.48",
  axios: "^1.20.0",
};

const PRETTIER_DEV_DEPS = {
  prettier: "^3.9.6",
  "prettier-plugin-svelte": "^4.1.1",
};

const TAILWIND_PRETTIER_DEV_DEPS = {
  "prettier-plugin-tailwindcss": "^0.8.1",
};

export interface AddOptions {
  install?: boolean;
  yes?: boolean;
}

// confirmAdd prints what an add is about to do and asks before it happens: it
// writes a dozen files and patches the root layout, and there is no `undo` to
// walk that back. Defaults to yes here (unlike a delete) because getting to this
// prompt already required typing the command.
async function confirmAdd(lines: string[], opts: AddOptions): Promise<void> {
  if (opts.yes) return;
  console.log(pc.bold("\nThis will:"));
  for (const line of lines) console.log(`  ${pc.dim("•")} ${line}`);
  console.log();
  if (!(await confirm({ message: "Proceed?", default: true }))) {
    throw new Error("cancelled — nothing was written");
  }
}

/**
 * Which test runner the generated tests are written against, if any.
 *
 * vitest first: `sv add vitest` is one command, it is what a SvelteKit project
 * reaches for, and it resolves the `@/` alias through the same Vite config the
 * app uses — so a test that imports across layers just works. `bun test` does
 * the same with no config of its own. Anything else would need a runner set up
 * first, and choosing one for somebody is not this CLI's call.
 */
function testRunner(projectDir: string, config: ProjectConfig): string | undefined {
  if (hasDependency(projectDir, "vitest")) return "vitest";
  if (config.packageManager === "bun") return "bun:test";
  return undefined;
}

/** Returns the dependencies added to package.json, so a caller that chains
 *  another add can install once at the end instead of twice. */
export async function addErrorHandling(opts: AddOptions): Promise<string[]> {
  const projectDir = requireProjectDir(process.cwd());
  const config = readConfig(projectDir);
  if (config.features.errorHandling) {
    throw new Error(
      `error handling is already installed (${config.srcDir}/shared/api/client.ts exists) — edit the catalogs there, or delete the directory to reinstall`
    );
  }

  const providersFile = `${config.srcDir}/app/providers/providers.svelte`;
  const ownsProviders = !fs.existsSync(path.join(projectDir, providersFile));
  const layoutFile = rootLayoutPath(config.routesDir);

  await confirmAdd(
    [
      `add ${pc.cyan(`${config.srcDir}/shared/api/`)} — ApiError, the error catalog + resolver, an axios client with a single-flight 401 refresh, and a QueryClient`,
      `add ${pc.cyan(`${config.srcDir}/shared/ui/form-error.svelte`)} and ${pc.cyan(`${config.srcDir}/shared/config/env.ts`)}`,
      `add ${pc.cyan(`${config.srcDir}/shared/auth/access-token.ts`)} — the in-memory token the request interceptor reads (\`add auth\` fills in the rest)`,
      ownsProviders
        ? `add ${pc.cyan(providersFile)} and wrap ${layoutFile} in <Providers>`
        : pc.yellow(`leave your existing ${providersFile} alone — you add <QueryClientProvider> to it yourself`),
      `add ${Object.keys(API_DEPS).join(" + ")} to package.json`,
    ],
    opts
  );

  // The refresh rules are the part that fails silently in a browser, so they get
  // the one test — but only where it runs with no extra setup.
  const runner = testRunner(projectDir, config);

  const context = { ...errorContext(config), testRunner: runner };
  const entries: TemplateEntry[] = [
    { template: "add/errors/api-error.ts.hbs", output: `${config.srcDir}/shared/api/api-error.ts` },
    { template: "add/errors/error-catalog.ts.hbs", output: `${config.srcDir}/shared/api/error-catalog.ts` },
    { template: "add/errors/error-resolver.ts.hbs", output: `${config.srcDir}/shared/api/error-resolver.ts` },
    { template: "add/errors/client.ts.hbs", output: `${config.srcDir}/shared/api/client.ts` },
    { template: "add/errors/query-client.ts.hbs", output: `${config.srcDir}/shared/api/query-client.ts` },
    { template: "add/errors/index.ts.hbs", output: `${config.srcDir}/shared/api/index.ts` },
    { template: "add/errors/access-token.ts.hbs", output: `${config.srcDir}/shared/auth/access-token.ts` },
    { template: "add/errors/env.ts.hbs", output: `${config.srcDir}/shared/config/env.ts` },
    { template: "add/errors/config-index.ts.hbs", output: `${config.srcDir}/shared/config/index.ts` },
    { template: "add/errors/form-error.svelte.hbs", output: `${config.srcDir}/shared/ui/form-error.svelte` },
    { template: "add/errors/providers.svelte.hbs", output: providersFile, when: () => ownsProviders },
    {
      template: "add/errors/providers-index.ts.hbs",
      output: `${config.srcDir}/app/providers/index.ts`,
      when: () => ownsProviders,
    },
    {
      template: "add/errors/client.test.ts.hbs",
      output: `${config.srcDir}/shared/api/client.test.ts`,
      when: () => runner !== undefined,
    },
  ];

  const written = await applyTemplates(projectDir, entries, context);

  if (
    appendExport(
      projectDir,
      `${config.srcDir}/shared/ui/index.ts`,
      'export { default as FormError } from "./form-error.svelte";'
    )
  ) {
    written.push(`${config.srcDir}/shared/ui/index.ts`);
  }
  // shared/auth gets a public API here rather than waiting for `add auth`, which
  // may never be run: a segment holding one file and no index.ts is an error to
  // steiger, so an add that installed cleanly would otherwise leave `lint` red.
  //
  // Appended, not rendered: this is the one place error handling reaches into a
  // directory another command owns, and a project that already has a
  // shared/auth/index.ts of its own should keep it rather than have the whole
  // batch refuse over it.
  if (
    appendExport(
      projectDir,
      `${config.srcDir}/shared/auth/index.ts`,
      'export { getAccessToken, setAccessToken } from "./access-token";'
    )
  ) {
    written.push(`${config.srcDir}/shared/auth/index.ts`);
  }
  if (
    appendEnvExample(
      projectDir,
      "PUBLIC_API_URL",
      "# Base URL of the API, including whatever prefix it mounts its routes under.\n" +
        "# The PUBLIC_ prefix is what lets SvelteKit expose it to the browser; anything\n" +
        "# without it stays server-only, which is the rule that keeps a secret out of a\n" +
        "# bundle. Whatever origin this app runs on must also be allowed by the API's\n" +
        "# CORS config, or the browser drops the refresh cookie.\n" +
        "PUBLIC_API_URL=http://localhost:8080/api\n"
    )
  ) {
    written.push(".env.example");
  }

  const layoutPatch = ownsProviders ? patchLayoutProviders(projectDir, layoutFile, config.alias) : "already";
  if (layoutPatch === "patched") written.push(`${layoutFile} (<Providers>)`);

  // The two files above were edited as text, not rendered from a template, so
  // applyTemplates never saw them. Missing ones are skipped.
  await formatFiles(projectDir, [
    layoutFile,
    `${config.srcDir}/shared/ui/index.ts`,
    `${config.srcDir}/shared/auth/index.ts`,
  ]);

  const added = addDependencies(projectDir, API_DEPS);
  setFeature(projectDir, "errorHandling", true);
  report(written, added);

  if (!ownsProviders) {
    console.log(
      pc.yellow(`\n${providersFile} already exists — wrap its children yourself:`) +
        `\n  import { QueryClientProvider } from "@tanstack/svelte-query";` +
        `\n  import { makeQueryClient } from "${config.alias}/shared/api";` +
        `\n  const queryClient = makeQueryClient();   // inside the component, not at module level` +
        `\n  <QueryClientProvider client={queryClient}>{@render children()}</QueryClientProvider>`
    );
  } else if (layoutPatch === "manual") {
    console.log(
      pc.yellow(`\ncould not find {@render children()} in ${layoutFile} — wrap it in <Providers> by hand:`) +
        `\n  import { Providers } from "${config.alias}/app/providers";`
    );
  }

  if (runner === undefined) {
    console.log(
      pc.dim(
        `\nno client.test.ts written: this project has no test runner that resolves the ${config.alias}/ alias on its own. ` +
          "Add one (`npx sv add vitest`) and re-run — the single-flight refresh is the part worth pinning down."
      )
    );
  }

  finish(projectDir, config, added, opts);
  console.log(
    `\n${pc.bold("Next:")} render a failure with ${pc.cyan("<FormError error={mutation.error} />")}, ` +
      `and give each domain its own catalog with ${pc.cyan("sveltekit-fsd generate page <name> --errors")}`
  );
  return added;
}

export async function addAuth(opts: AddOptions): Promise<void> {
  const projectDir = requireProjectDir(process.cwd());
  let config = readConfig(projectDir);
  if (config.features.auth) {
    throw new Error(
      `auth is already installed (${config.srcDir}/shared/auth/session.ts exists) — edit it there, or delete the directory to reinstall`
    );
  }

  // Not an error like "run add error-handling first": auth cannot work without
  // the client at all — every hook below goes through it — so there is no choice
  // to offer, only a step to take first.
  let added: string[] = [];
  if (!config.features.errorHandling) {
    console.log(pc.dim("auth needs the API client, which `add error-handling` installs — doing that first.\n"));
    // install: false so the two adds share one install run at the end.
    added = await addErrorHandling({ ...opts, install: false });
    config = readConfig(projectDir);
    console.log();
  }

  await confirmAdd(
    [
      `add ${pc.cyan(`${config.srcDir}/shared/auth/`)} — session hooks (useSession/useLogin/useLogout), requireSession with a ?next= round trip, and an auth error catalog`,
      `add ${pc.cyan(`${config.srcDir}/pages/login/`)} and ${pc.cyan(`${config.routesDir}/login/+page.svelte`)}`,
      pc.yellow(
        "assumes the API answers POST /auth/login with an access token, keeps the refresh token in an httpOnly cookie, and serves GET /users/me — adjust the paths and the Session type if yours differ"
      ),
      pc.dim("password login only: MFA, OAuth providers and RBAC are not scaffolded"),
    ],
    opts
  );

  const runner = testRunner(projectDir, config);
  const context = {
    ...errorContext(config),
    testRunner: runner,
    name: "login",
    directory: "login",
    pageAlias: config.alias,
    pascal: "Login",
  };
  const auth = `${config.srcDir}/shared/auth`;
  const slice = `${config.srcDir}/pages/login`;
  const written = await applyTemplates(
    projectDir,
    [
      { template: "add/auth/session.ts.hbs", output: `${auth}/session.ts` },
      // `.svelte.ts`, and not as a matter of taste: this module calls `$effect`,
      // and runes are compiled, not imported. The Svelte compiler only looks
      // inside `.svelte` components and modules named this way — in a plain
      // `.ts` the call survives into the output as a bare identifier, so the
      // page renders `ReferenceError: $effect is not defined` on the server and
      // dies in the browser. Nothing catches it earlier: `$effect` is a declared
      // global, so svelte-check is happy and the build emits it unchanged.
      { template: "add/auth/require-session.ts.hbs", output: `${auth}/require-session.svelte.ts` },
      { template: "add/auth/safe-next.ts.hbs", output: `${auth}/safe-next.ts` },
      {
        // What it covers is the open-redirect guard on ?next=, which is the one
        // thing here that fails as a security bug rather than a visible one.
        template: "add/auth/require-session.test.ts.hbs",
        // Deliberately NOT `require-session.svelte.test.ts`, even though that is
        // the module it covers: `sv add vitest` excludes `*.svelte.{test,spec}`
        // from the node project, reserving it for browser-environment component
        // tests. Named that way the open-redirect test would be collected by
        // nothing and silently never run.
        output: `${auth}/require-session.test.ts`,
        when: () => runner !== undefined,
      },
      { template: "add/auth/auth-errors.ts.hbs", output: `${auth}/auth-errors.ts` },
      { template: "add/auth/login-index.ts.hbs", output: `${slice}/index.ts` },
      { template: "add/auth/login-page.svelte.hbs", output: `${slice}/ui/login-page.svelte` },
      { template: "add/auth/login-form.svelte.hbs", output: `${slice}/ui/login-form.svelte` },
      {
        template: "generate/page/route.svelte.hbs",
        output: path.posix.join(config.routesDir, "login", "+page.svelte"),
      },
    ],
    context
  );

  // Appended, not rendered over the top: `add error-handling` already wrote this
  // file, and the two commands can be months apart — long enough for the project
  // to have put its own exports in it. appendExport skips a line already there,
  // so re-running adds nothing twice.
  for (const line of [
    'export { authErrorCatalog, authErrorCatalogs, resolveAuthError } from "./auth-errors";',
    'export { sessionKey, useLogin, useLogout, useSession, type LoginInput, type Session } from "./session";',
    'export { requireSession } from "./require-session.svelte";',
    'export { safeNext } from "./safe-next";',
  ]) {
    if (appendExport(projectDir, `${auth}/index.ts`, line) && !written.includes(`${auth}/index.ts`)) {
      written.push(`${auth}/index.ts`);
    }
  }
  // Appended as text, so applyTemplates never formatted it — and `add prettier`
  // puts a --check on lint.
  await formatFiles(projectDir, [`${auth}/index.ts`]);

  setFeature(projectDir, "auth", true);
  report(written);
  finish(projectDir, config, added, opts);
  console.log(
    `\n${pc.bold("Next:")} put a page behind the session guard with ` +
      pc.cyan("sveltekit-fsd generate page dashboard --auth")
  );
}

/**
 * Adds prettier, with the svelte parser and — when the project has Tailwind —
 * the class-sorting plugin pointed at the stylesheet `init` moved.
 *
 * Worth a command rather than a line in the README because of those two
 * pointers: a `.svelte` file needs `prettier-plugin-svelte` and an override to
 * be parsed at all, and Tailwind v4 has no config file for the sorting plugin to
 * find, so it needs `tailwindStylesheet`. Everyone who adds prettier by hand
 * afterwards has to rediscover both.
 *
 * Prettier's own defaults are left alone. Indent width and print width are
 * taste, they are the first thing anyone changes, and a generator picking them
 * would only be picking a fight.
 */
export async function addPrettier(opts: AddOptions): Promise<void> {
  const projectDir = requireProjectDir(process.cwd());
  const config = readConfig(projectDir);
  const stylesheet = `${config.srcDir}/app/styles/app.css`;
  const tailwind = hasDependency(projectDir, "tailwindcss");

  if (config.features.prettier) {
    throw new Error(
      "a prettier config already exists in this project — a second one would not merge with it, it would be ignored. Add what is missing to the config you have:\n" +
        '  "plugins": ["prettier-plugin-svelte"' +
        (tailwind ? ', "prettier-plugin-tailwindcss"' : "") +
        "],\n" +
        '  "overrides": [{ "files": "*.svelte", "options": { "parser": "svelte" } }]' +
        (tailwind ? `,\n  "tailwindStylesheet": "./${stylesheet}",\n  "tailwindFunctions": ["cn", "cva"]` : "")
    );
  }

  await confirmAdd(
    [
      `add ${pc.cyan(".prettierrc")} — prettier defaults plus prettier-plugin-svelte and the ${pc.cyan("*.svelte")} parser override` +
        (tailwind
          ? `, and prettier-plugin-tailwindcss pointed at ${pc.cyan(stylesheet)} (Tailwind v4 has no config file to find) and taught about ${pc.cyan("cn()")} / ${pc.cyan("cva()")}`
          : ""),
      `add ${pc.cyan(".prettierignore")} — markdown and lockfiles; prettier already reads .gitignore`,
      `add a ${pc.cyan("format")} script, and ${pc.cyan("prettier --check .")} to ${pc.cyan("lint")} so whatever runs lint enforces it`,
      `add ${Object.keys({ ...PRETTIER_DEV_DEPS, ...(tailwind ? TAILWIND_PRETTIER_DEV_DEPS : {}) }).join(" + ")} to devDependencies`,
      pc.yellow(
        "then format the project once — every file, in one pass. Adding the check without the pass would leave `lint` failing on files nobody touched. Commit it on its own."
      ),
    ],
    opts
  );

  const written = await applyTemplates(
    projectDir,
    [
      { template: "add/prettier/prettierrc.hbs", output: ".prettierrc" },
      { template: "add/prettier/prettierignore.hbs", output: ".prettierignore" },
    ],
    { ...config, tailwind, stylesheet }
  );

  if (appendScript(projectDir, "format", "prettier --write .")) written.push("package.json (format script)");
  // On lint rather than a pre-commit hook: the project may not have one, and
  // whatever already runs lint — CI, a hook, an editor task — picks this up with
  // no further wiring.
  if (appendScript(projectDir, "lint", "prettier --check .")) written.push("package.json (lint script)");

  const added = addDependencies(
    projectDir,
    { ...PRETTIER_DEV_DEPS, ...(tailwind ? TAILWIND_PRETTIER_DEV_DEPS : {}) },
    "devDependencies"
  );
  setFeature(projectDir, "prettier", true);
  report(written, added);
  finish(projectDir, config, added, opts);

  // The pass has to happen, and it has to happen here. `prettier --check .` on
  // lint against an unformatted tree fails on every file in the project — an add
  // that hands back a red lint is worse than one that never touched lint. Needs
  // the install, so `--no-install` gets the instruction instead.
  if (opts.install === false) {
    console.log(
      pc.yellow(
        `\n\`lint\` will fail until the project is formatted. Run \`${config.packageManager} install\`, ` +
          `then \`${config.packageManager} run format\`.`
      )
    );
    return;
  }

  console.log(pc.dim("\nformatting the project once, so `lint` passes:"));
  try {
    runCommand(projectDir, config.packageManager, ["prettier", "--write", "."]);
  } catch {
    // Everything above already landed. Failing the whole command now would
    // suggest none of it did, and the fix is one command the user can run.
    console.log(
      pc.yellow(
        `\ncould not run prettier — everything else is written. Run \`${config.packageManager} run format\` ` +
          "once the install finishes; `lint` fails until you do."
      )
    );
    return;
  }
  console.log(
    `\n${pc.bold("Next:")} commit that pass on its own — it touches every file, ` +
      "and nobody can review it mixed into a change."
  );
}

function errorContext(config: ProjectConfig) {
  const copy = copyFor(config.locale);
  return {
    ...config,
    copy,
    commonCatalogEntries: asCatalogEntries(copy.common),
    authCatalogEntries: asCatalogEntries(copy.auth),
  };
}

function finish(projectDir: string, config: ProjectConfig, added: string[], opts: AddOptions): void {
  if (added.length === 0) return;
  if (opts.install === false) {
    console.log(pc.yellow(`\nrun \`${config.packageManager} install\` to install: ${added.join(", ")}`));
    return;
  }
  installDependencies(projectDir, config.packageManager);
}
