import path from "path";
import fs from "fs-extra";
import pc from "picocolors";

import { SLICE_LAYERS, SEGMENTS, Segment, SliceLayer } from "../types";
import { checkbox, confirm, input, select } from "../prompts";
import { readConfig } from "../utils/config";
import { copyFor } from "../utils/copy";
import { normalizeRoute, resolveNaming, validateRoute, validateSliceName } from "../utils/naming";
import { applyTemplates, renderTemplate, TemplateEntry, formatFiles } from "../utils/render";
import { appendExport } from "../utils/project";
import { report } from "./init";

export interface PageOptions {
  title?: string;
  route?: string;
  /** false when --no-route was passed; commander leaves it undefined otherwise. */
  routeFile?: boolean;
  auth?: boolean;
  model?: boolean;
  errors?: boolean;
  defaults?: boolean;
}

export async function generatePage(rawName: string | undefined, opts: PageOptions): Promise<void> {
  const config = readConfig(process.cwd());
  assertInputs("page", rawName);

  const name =
    rawName ??
    (await input({
      message: `Page name (kebab-case, becomes ${config.srcDir}/pages/<name>/):`,
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);

  let { auth, errors, model } = opts;
  let title = opts.title?.trim() || undefined;
  if (!opts.defaults) {
    if (auth === undefined) {
      auth = await confirm({
        message: "Put this page behind the session (requireSession)?",
        default: false,
      });
    }
    // Asked for `th`, not for `en`: the derived Title Case of a kebab name is
    // already the right answer in English, while a Thai project would otherwise
    // get an English heading and an English <title> on every page — two hand
    // edits per page, every page.
    if (opts.title === undefined && config.locale !== "en") {
      title = (
        await input({
          message: "Page title (shown as the heading and the browser title):",
          default: toTitleCase(naming.name),
        })
      ).trim();
    }
    if (model === undefined && config.features.errorHandling) {
      model = await confirm({
        message: `Add this page's query hooks (model/${naming.name}.ts)?`,
        default: false,
      });
    }
    if (errors === undefined && config.features.errorHandling) {
      errors = await confirm({
        message: `Add an error catalog (model/${naming.name}-errors.ts)?`,
        default: false,
      });
    }
  }

  if (auth && !config.features.auth) {
    throw new Error("--auth needs the auth feature — run `sveltekit-fsd add auth` first");
  }
  if (errors && !config.features.errorHandling) {
    throw new Error("--errors needs the error-handling feature — run `sveltekit-fsd add error-handling` first");
  }
  if (model && !config.features.errorHandling) {
    throw new Error(
      "--model needs the error-handling feature — run `sveltekit-fsd add error-handling` first.\n" +
        "A bare fetch skips the bearer token, the single-flight 401 refresh, and the conversion into ApiError."
    );
  }

  const route = opts.route === undefined ? naming.name : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const slice = `${config.srcDir}/pages/${naming.name}`;
  // A page that already exists is being extended, not recreated — `--errors` or
  // `--model` on a slice generated bare earlier is the normal way those get
  // added, so the existing files are not an error.
  const extending = fs.existsSync(path.join(process.cwd(), slice));

  // A page being extended may already be routed from somewhere else —
  // `--route "(admin)/dashboard"` the first time round. Writing the default
  // route file now would give one page two URLs, from a command that printed
  // success.
  const existingRoute = extending
    ? findRouteFor(process.cwd(), config.routesDir, config.alias, naming.name)
    : undefined;

  const context = {
    ...naming,
    ...config,
    copy: copyFor(config.locale),
    title: title || toTitleCase(naming.name),
    auth: Boolean(auth),
  };

  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/page/index.ts.hbs", output: `${slice}/index.ts` },
      { template: "generate/page/page.svelte.hbs", output: `${slice}/ui/${naming.name}-page.svelte` },
      {
        // The same template a slice's api segment gets: a page is a slice too,
        // and its requests have no reason to be shaped differently. It lands in
        // model/ rather than api/, because a page keeps what it knows about its
        // own data in one segment.
        template: "generate/slice/api.ts.hbs",
        output: `${slice}/model/${naming.name}.ts`,
        when: () => Boolean(model),
      },
      {
        template: "generate/page/errors.ts.hbs",
        output: `${slice}/model/${naming.name}-errors.ts`,
        when: () => Boolean(errors),
      },
      {
        template: "generate/page/route.svelte.hbs",
        output: path.posix.join(config.routesDir, route, "+page.svelte"),
        when: () => opts.routeFile !== false && existingRoute === undefined,
      },
    ],
    context,
    { skipExisting: extending }
  );

  if (extending && written.length === 0) {
    throw new Error(
      `${slice} already has everything this would write.\n` +
        "Pass --model or --errors to add the query hooks or an error catalog to it."
    );
  }
  report(written);
  if (extending) {
    console.log(pc.dim(`\nextended the existing ${naming.name} page; untouched files were left alone.`));
    // The page component is one of those untouched files, so hooks added now are
    // not called by anything yet. Say the one line that wires them.
    if (written.some((file) => file.endsWith(`${naming.name}.ts`))) {
      console.log(
        pc.yellow(`ui/${naming.name}-page.svelte does not use them yet — add to its <script>:`) +
          `\n  import { use${naming.pascal}Query } from "../model/${naming.name}";`
      );
    }
  }
  if (auth) {
    const layoutGuard = findLayoutGuard(process.cwd(), config.srcDir);
    if (layoutGuard !== undefined) {
      console.log(
        pc.yellow(`\n${layoutGuard} already guards the routes under it.`) +
          "\nIf this page routes under that layout, drop the requireSession call from" +
          ` ui/${naming.name}-page.svelte and use useSession() — two components redirecting on the same failed session race each other.`
      );
    }
  }
  if (existingRoute !== undefined) {
    console.log(
      pc.dim(`\nalready routed from ${existingRoute} — left alone rather than giving one page a second URL.`)
    );
  } else if (opts.routeFile === false) {
    console.log(pc.yellow("\nno route file — add one that renders the page when you want it routable."));
  } else {
    // Route groups are directories SvelteKit reads and strips from the URL, so
    // printing the path verbatim would name a URL that never exists.
    const url = route
      .split("/")
      .filter((segment) => !segment.startsWith("("))
      .join("/");
    console.log(`\n${pc.bold("Route:")} /${url}`);
  }
}

export interface SliceOptions {
  segments?: string;
  errors?: boolean;
  defaults?: boolean;
}

export async function generateSlice(
  rawLayer: string | undefined,
  rawName: string | undefined,
  opts: SliceOptions
): Promise<void> {
  const config = readConfig(process.cwd());
  assertSliceInputs(rawLayer, rawName, opts);

  const layer =
    parseLayer(rawLayer) ??
    ((await select({
      message: "Which layer?",
      choices: [
        { name: "features — a whole user action, reused by two or more pages", value: "features" },
        { name: "entities — a business object, reused by two or more features", value: "entities" },
        { name: "widgets — a composite UI block (prefer features; see docs/fsd.md)", value: "widgets" },
      ],
    })) as SliceLayer);

  const name =
    rawName ??
    (await input({
      message: `Slice name (kebab-case, becomes ${config.srcDir}/${layer}/<name>/):`,
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);

  const chosen = opts.segments
    ? parseSegments(opts.segments)
    : opts.defaults
      ? (["ui"] as Segment[])
      : ((await checkbox({
          message: "Which segments? (a slice gets only the ones it has code for)",
          choices: [
            { name: "ui — components", value: "ui", checked: true },
            { name: "model — state, in a .svelte.ts module", value: "model" },
            {
              name: "api — TanStack Query hooks",
              value: "api",
              disabled: config.features.errorHandling ? false : "— needs `add error-handling` first",
            },
            { name: "lib — pure helpers", value: "lib" },
          ],
        })) as Segment[]);

  if (chosen.length === 0) {
    throw new Error("pick at least one segment — a slice with no segments is an empty directory");
  }
  if (chosen.includes("api") && !config.features.errorHandling) {
    throw new Error(
      "the api segment needs the error-handling feature — run `sveltekit-fsd add error-handling` first.\n" +
        "A bare fetch skips the bearer token, the single-flight 401 refresh, and the conversion into ApiError."
    );
  }

  let errors = opts.errors;
  if (errors === undefined) {
    errors = opts.defaults
      ? false
      : config.features.errorHandling &&
        (await confirm({ message: `Add an error catalog (model/${naming.name}-errors.ts)?`, default: false }));
  }
  if (errors && !config.features.errorHandling) {
    throw new Error("--errors needs the error-handling feature — run `sveltekit-fsd add error-handling` first");
  }

  const segments = Object.fromEntries(
    [...SEGMENTS, "errors" as const].map((segment) => [
      segment,
      segment === "errors" ? Boolean(errors) : chosen.includes(segment as Segment),
    ])
  );

  // Only the segments that are not on disk yet. Drives both what gets written
  // and which export lines join an existing index.ts, so extending a slice never
  // re-announces a segment it already had.
  const onDisk = existingSegments(process.cwd(), slicePath(config.srcDir, layer, naming.name), naming.name);
  const added = Object.fromEntries(
    Object.entries(segments).map(([segment, wanted]) => [segment, wanted && !onDisk.includes(segment)])
  );

  const context = { ...naming, ...config, copy: copyFor(config.locale), layer, segments };

  const slice = slicePath(config.srcDir, layer, naming.name);
  const extending = fs.existsSync(path.join(process.cwd(), slice));
  const entries: TemplateEntry[] = [
    // index.ts is handled separately when extending: it has to gain the new
    // segments' exports without losing whatever is already in it (including
    // lines someone edited by hand).
    { template: "generate/slice/index.ts.hbs", output: `${slice}/index.ts`, when: () => !extending },
    { template: "generate/slice/ui.svelte.hbs", output: `${slice}/ui/${naming.name}.svelte`, when: () => segments.ui },
    {
      // `.svelte.ts`, not `.ts`: `$state` is compiled, not imported, and the
      // compiler only looks inside components and modules named this way.
      template: "generate/slice/model.svelte.ts.hbs",
      output: `${slice}/model/${naming.name}.svelte.ts`,
      when: () => segments.model,
    },
    { template: "generate/slice/api.ts.hbs", output: `${slice}/api/${naming.name}.ts`, when: () => segments.api },
    { template: "generate/slice/lib.ts.hbs", output: `${slice}/lib/${naming.name}.ts`, when: () => segments.lib },
    {
      template: "generate/slice/errors.ts.hbs",
      output: `${slice}/model/${naming.name}-errors.ts`,
      when: () => segments.errors,
    },
  ];

  const written = await applyTemplates(process.cwd(), entries, context, { skipExisting: extending });

  if (extending) {
    if (written.length === 0) {
      throw new Error(
        `${slice} already has every segment this would write.\n` +
          `It currently has: ${onDisk.join(", ") || "nothing"}.`
      );
    }
    // Rendered from the same template as a fresh index.ts, with only the new
    // segments switched on, so the export lines cannot drift from the files they
    // point at.
    for (const line of renderTemplate("generate/slice/index.ts.hbs", { ...context, segments: added }).split("\n")) {
      if (line.trim() !== "" && appendExport(process.cwd(), `${slice}/index.ts`, line)) {
        if (!written.includes(`${slice}/index.ts`)) written.push(`${slice}/index.ts`);
      }
    }
    // Appended as text rather than rendered, so applyTemplates never formatted
    // it — and `add prettier` puts a --check on lint.
    await formatFiles(process.cwd(), [`${slice}/index.ts`]);
  }

  report(written);
  if (extending) console.log(pc.dim(`\nextended the existing ${naming.name} slice; untouched files were left alone.`));
  console.log(
    `\n${pc.dim("imported as")} import { ${naming.pascal} } from "${config.alias}/${layer}/${naming.name}";` +
      `\n${pc.dim("only through that index.ts — reaching into ui/ is the boundary violation steiger reports.")}` +
      `\n${pc.dim("until something imports it, steiger reports fsd/insignificant-slice — that is the linter working, not a mistake.")}`
  );
}

/**
 * The route file that already renders this page slice, if any.
 *
 * Found by reading the routes directory rather than by guessing the path: a page
 * generated with `--route "(admin)/dashboard"` lives nowhere the slice name
 * would predict, and the whole point is to notice a route that is not where the
 * default would have put it.
 */
function findRouteFor(projectDir: string, routesDir: string, alias: string, name: string): string | undefined {
  const root = path.join(projectDir, routesDir);
  if (!fs.existsSync(root)) return undefined;
  const marker = `${alias}/pages/${name}"`;
  for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (path.basename(entry) !== "+page.svelte") continue;
    const file = path.join(root, entry);
    // Both quote styles: the template writes double quotes, and a project whose
    // prettier prefers single ones rewrites them on the next format.
    const source = fs.readFileSync(file, "utf8");
    if (source.includes(marker) || source.includes(marker.replace(/"$/, "'"))) {
      return path.posix.join(routesDir, entry.split(path.sep).join("/"));
    }
  }
  return undefined;
}

/**
 * The layout guard that already calls requireSession, if there is one.
 *
 * Read from the file rather than the config, because what matters is whether a
 * shell guards its routes — not whether this CLI is what wrote it.
 */
function findLayoutGuard(projectDir: string, srcDir: string): string | undefined {
  const dir = path.join(projectDir, srcDir, "app", "layouts");
  if (!fs.existsSync(dir)) return undefined;
  const file = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".svelte"))
    .find((entry) => fs.readFileSync(path.join(dir, entry), "utf8").includes("requireSession"));
  return file === undefined ? undefined : `${srcDir}/app/layouts/${file}`;
}

function slicePath(srcDir: string, layer: string, name: string): string {
  return `${srcDir}/${layer}/${name}`;
}

/** Where each segment's generated file lands, relative to the slice. */
function segmentFile(segment: string, name: string): string {
  if (segment === "errors") return `model/${name}-errors.ts`;
  if (segment === "ui") return `ui/${name}.svelte`;
  if (segment === "model") return `model/${name}.svelte.ts`;
  return `${segment}/${name}.ts`;
}

/** Which segments a slice already has on disk. */
function existingSegments(projectDir: string, slice: string, name: string): string[] {
  return [...SEGMENTS, "errors"].filter((segment) =>
    fs.existsSync(path.join(projectDir, slice, segmentFile(segment, name)))
  );
}

function parseLayer(value: string | undefined): SliceLayer | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!SLICE_LAYERS.includes(normalized as SliceLayer)) {
    throw new Error(
      `unknown layer "${value}" — use ${SLICE_LAYERS.join(", ")}.\n` +
        "`pages` slices come from `generate page`, and `app`/`shared` are written by `init` and `add`."
    );
  }
  return normalized as SliceLayer;
}

function parseSegments(value: string): Segment[] {
  const parsed = value
    .split(",")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  const unknown = parsed.filter((segment) => !SEGMENTS.includes(segment as Segment));
  if (unknown.length > 0) {
    throw new Error(`unknown segment${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} — use ${SEGMENTS.join(", ")}`);
  }
  return [...new Set(parsed)] as Segment[];
}

/**
 * Whether the routes under a new layout should sit behind the session.
 *
 * Not asked without auth installed (there is nothing to guard with), and not
 * asked off a TTY — `generate layout <name>` has to keep working in CI, where a
 * prompt would turn a working command into an error.
 */
async function askGuard(hasAuth: boolean, defaults: boolean | undefined): Promise<boolean> {
  if (defaults || !hasAuth || !process.stdin.isTTY) return false;
  return confirm({
    message: "Put every route under this layout behind the session (requireSession)?",
    default: false,
  });
}

function toTitleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The no-TTY case reaches here only for values a prompt would have asked for.
// Listing all of them at once beats failing on the first one, then the second.
function assertInputs(what: string, name: string | undefined): void {
  if (process.stdin.isTTY || name !== undefined) return;
  throw new Error(
    `no interactive terminal to prompt on — \`generate ${what}\` needs <name> as an argument (flags cover the rest; see --help)`
  );
}

function assertSliceInputs(
  layer: string | undefined,
  name: string | undefined,
  opts: { segments?: string; defaults?: boolean }
): void {
  if (process.stdin.isTTY) return;
  const missing: string[] = [];
  if (layer === undefined) missing.push("<layer>");
  if (name === undefined) missing.push("<name>");
  if (opts.segments === undefined && !opts.defaults) missing.push("--segments (or --defaults for ui only)");
  if (missing.length > 0) {
    throw new Error(
      `no interactive terminal to prompt on — \`generate slice\` is missing: ${missing.join(", ")}. ` +
        "Pass them as arguments/flags, or add --defaults."
    );
  }
}

export interface LayoutOptions {
  route?: string;
  routeFile?: boolean;
  guard?: boolean;
  defaults?: boolean;
}

/**
 * A shared shell for a group of routes: the component in `app/layouts` plus the
 * `+layout.svelte` that renders it.
 *
 * `app`, not `pages`: a layout is not one route's content, it is what several
 * routes have in common, and the app layer is where cross-page composition
 * lives. The route file defaults to a route group — `(admin)` — because that is
 * a layout's usual reason to exist: shared chrome for a set of pages,
 * contributing nothing to the URL.
 *
 * `--guard` puts every route under it behind the session, in one component. That
 * is where a guard belongs: a page that checks for itself is fine alone and
 * races the shell as soon as both check, and "every signed-in screen" is a
 * property of the shell, not something each page should re-declare.
 */
export async function generateLayout(rawName: string | undefined, opts: LayoutOptions): Promise<void> {
  const config = readConfig(process.cwd());
  assertInputs("layout", rawName);

  const name =
    rawName ??
    (await input({
      message: `Layout name (kebab-case, becomes ${config.srcDir}/app/layouts/<name>-layout.svelte):`,
      validate: validateSliceName,
    }));
  const naming = resolveNaming(name);

  const guard = opts.guard ?? (await askGuard(config.features.auth, opts.defaults));
  if (guard && !config.features.auth) {
    throw new Error("--guard needs the auth feature — run `sveltekit-fsd add auth` first");
  }

  // "(admin)" rather than "admin": a layout's default home is a route group,
  // which shares chrome without adding a URL segment.
  const route = opts.route === undefined ? `(${naming.name})` : normalizeRoute(opts.route);
  const routeCheck = validateRoute(route);
  if (routeCheck !== true) throw new Error(routeCheck);

  const context = { ...naming, ...config, copy: copyFor(config.locale), guard };
  const layouts = `${config.srcDir}/app/layouts`;
  // Same rule as page and slice: an existing layout is being extended (given a
  // route file it did not have), not recreated.
  const extending = fs.existsSync(path.join(process.cwd(), `${layouts}/${naming.name}-layout.svelte`));
  const written = await applyTemplates(
    process.cwd(),
    [
      { template: "generate/layout/layout.svelte.hbs", output: `${layouts}/${naming.name}-layout.svelte` },
      {
        template: "generate/layout/guard.svelte.hbs",
        output: `${layouts}/${naming.name}-guard.svelte`,
        when: () => guard,
      },
      {
        template: "generate/layout/route.svelte.hbs",
        output: path.posix.join(config.routesDir, route, "+layout.svelte"),
        when: () => opts.routeFile !== false,
      },
    ],
    context,
    { skipExisting: extending }
  );

  if (extending && written.length === 0) {
    throw new Error(
      `${layouts}/${naming.name}-layout.svelte already exists and is already applied at ${config.routesDir}/${route}/+layout.svelte.\n` +
        "Pass --route <path> to apply it somewhere else as well."
    );
  }

  // The layout itself was left alone when extending, so a guard added now is not
  // rendering anything yet. Say the two lines that wire it.
  if (extending && written.some((file) => file.endsWith(`${naming.name}-guard.svelte`))) {
    console.log(
      pc.yellow(`${layouts}/${naming.name}-layout.svelte does not render it yet — add:`) +
        `\n  import ${naming.pascal}Guard from "./${naming.name}-guard.svelte";` +
        `\n  <${naming.pascal}Guard>{@render children()}</${naming.pascal}Guard>`
    );
  }

  if (
    appendExport(
      process.cwd(),
      `${layouts}/index.ts`,
      `export { default as ${naming.pascal}Layout } from "./${naming.name}-layout.svelte";`
    )
  ) {
    written.push(`${layouts}/index.ts`);
  }
  await formatFiles(process.cwd(), [`${layouts}/index.ts`]);

  report(written);
  if (guard) {
    console.log(
      pc.dim(
        `\nevery route under this layout is behind ${naming.pascal}Guard — the pages below call useSession() and trust it.` +
          "\nDo not also generate one with `generate page --auth`: two components redirecting on the same failed session race each other."
      )
    );
  }
  if (opts.routeFile === false) {
    console.log(pc.yellow("\nno route file — add a +layout.svelte that renders it when you want it applied."));
  } else {
    console.log(
      `\n${pc.bold("Applies to:")} every route under ${config.routesDir}/${route}/` +
        (route.startsWith("(") ? pc.dim(" (a route group — it adds nothing to the URL)") : "")
    );
  }
}
