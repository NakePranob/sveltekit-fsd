# @nakedev/sveltekit-fsd

@nakedev/sveltekit-fsd is an npm CLI for keeping a SvelteKit project on
[Feature-Sliced Design](https://feature-sliced.design): it shapes the layer
structure once — including moving routing *into* the FSD app layer, which is
what the methodology's own SvelteKit guide asks for — then generates pages,
slices and layouts that all have the same shape, plus the two pieces of wiring
every project ends up rewriting by hand: API error handling and authentication.

SvelteKit already creates projects, so this CLI has no `create`. The normal
workflow is: `sv create`, then `sveltekit-fsd init` once, then run the same CLI
from the project whenever the frontend grows.

Sibling to [@nakedev/nextjs-fsd](https://www.npmjs.com/package/@nakedev/nextjs-fsd)
and [@nakedev/go-scaffold](https://www.npmjs.com/package/@nakedev/go-scaffold),
which generate the same architecture for Next.js and the Go backend these
templates are written against.

## Install

~~~bash
npm install --global @nakedev/sveltekit-fsd

sveltekit-fsd --version
sveltekit-fsd --help
~~~

npx and bunx work too, if you would rather not install anything:

~~~bash
npx @nakedev/sveltekit-fsd init
bunx @nakedev/sveltekit-fsd generate page dashboard
~~~

### Requirements

- Node.js >=20.9 to run the CLI.
- A **SvelteKit 2** project in TypeScript, created by `sv create`. Svelte 5 and
  runes mode — the generated components use `$props`, `$state`, `$derived` and
  `$effect`, and `sv create` turns runes on for you.
- The project's package manager — npm, pnpm, yarn or bun. It is detected from
  the lockfile, and the CLI installs the dependencies its templates need.
- Tailwind CSS, if you want the generated markup to look like anything:
  everything this CLI emits is styled with utility classes. `npx sv add
  tailwindcss`. Without it, `init` writes no stylesheet and says so.
- An HTTP API for `add auth` and `add error-handling` to talk to. Both are
  written against the shape go-scaffold produces; see their sections below for
  what to change if yours differs.

## Quick start

~~~bash
npm install --global @nakedev/sveltekit-fsd
npx sv create my-app --template minimal --types ts --add prettier eslint tailwindcss

cd my-app
sveltekit-fsd init                 # once: move routing into the app layer, add both linters, docs, skills
sveltekit-fsd add auth             # shared/auth + a login page (pulls in error handling)
sveltekit-fsd generate page dashboard --auth
~~~

That gives a project with `/login` and `/dashboard`, a session guard, and an API
client that normalises every failure into one error type. Then:

~~~bash
npm run dev
npm run check                      # svelte-check — this is the typecheck
npm run lint                       # eslint (import boundary) + steiger (whole tree)
~~~

`init` creates no empty layer directories. `features/` and `entities/` appear
when a slice actually needs them, which is FSD's own advice rather than a
shortcut.

## What `init` does, and why

This is the one command that rearranges a project you already have, so it is
worth knowing what moves.

| | before | after |
|---|---|---|
| routing | `src/routes/` | `src/app/routes/` |
| page template | `src/app.html` | `src/app/index.html` |
| stylesheet | `src/routes/layout.css` (wherever the layout imports it from) | `src/app/styles/app.css` |

and it points SvelteKit at all three:

~~~js
// vite.config.ts, inside sveltekit({ ... })
files: {
  routes: 'src/app/routes',
  appTemplate: 'src/app/index.html'
},
alias: {
  '@/*': 'src/*'
}
~~~

**Which file that goes in is not a matter of taste.** SvelteKit loads its config
from the Vite config *first* and only falls back to `svelte.config.js`. Recent
`sv create` writes no `svelte.config.js` at all; projects made before that have
the opposite shape. `init` detects which one is live and patches that one —
writing to the other would leave a file with correct values that nothing reads,
and routes that moved with nothing pointing at them.

If that config already sets `files` or `alias`, `init` stops before moving
anything and prints the block to merge in by hand. A second key of the same
name is not an error in JavaScript — the later one wins — so adding ours next
to yours would silently drop one of them. Merge it, then run `init` again.

`tsconfig.json` is **not** touched. SvelteKit writes `kit.alias` into the
generated `.svelte-kit/tsconfig.json` that yours extends, so Vite,
`svelte-check`, your editor and steiger all resolve `@/` from one place.

### Two deliberate departures from the FSD SvelteKit guide

The [official guide](https://feature-sliced.design/docs/guides/tech/with-sveltekit)
sets two more options. This CLI does not, and says so here rather than leaving
you to notice:

- **`files.lib: 'src'`** would point `$lib` at the same tree as `@`. It is the
  tidier end state — one name per module — but getting there means moving
  everything in `src/lib/` and rewriting the `$lib/` imports that named it,
  including the favicon import in the layout `sv create` just wrote. `init`
  moves no code you wrote. `$lib` keeps meaning `src/lib`, steiger ignores that
  directory, and `docs/fsd.md` says plainly that `shared/` is where the layers'
  shared code goes so the two do not both grow.
- **`assets: 'public'`** renames `static/`. That is a rename with no FSD content
  in it, so `static/` is left alone.

### And what it adds

- `eslint.fsd.js` — the import boundary as ESLint rules, spread into your flat
  config. No new dependencies: it is the core `no-restricted-imports` rule and
  the layer order.
- `steiger.config.ts` + `steiger` and the FSD plugin, chained onto `lint`.
- `components.json` so `shadcn-svelte add` writes into `src/shared/ui`.
- `docs/fsd.md` — the convention, in this project's own words.
- Two agent skills at the repository root, symlinked from `.claude/skills/`:
  `sveltekit-fsd` (driving this CLI) and `feature-sliced-design` (the FSD v2.1
  methodology itself, so "should this be an entity at all" has an answer that
  does not depend on what the model remembers).
- A `commit-msg` hook that checks the subject is a Conventional Commit — shape
  only; your language and emoji rules stay yours.

Everything it would write that you already have is left alone and listed at the
end, rather than the whole command refusing over one file.

## Commands

~~~bash
sveltekit-fsd                                  # menu: generate / add / show config
sveltekit-fsd init [--locale th|en] [--no-install] [--no-hooks] [--defaults]

sveltekit-fsd generate page <name> [--title <t>] [--route <path>] [--no-route] [--auth] [--model] [--errors]
sveltekit-fsd generate slice <features|entities|widgets> <name> [--segments ui,model,api,lib] [--errors]
sveltekit-fsd generate layout <name> [--route <path>] [--no-route] [--guard]

sveltekit-fsd add error-handling [-y] [--no-install]
sveltekit-fsd add auth [-y] [--no-install]
sveltekit-fsd add prettier [-y] [--no-install]

sveltekit-fsd config show
sveltekit-fsd config set locale th|en
~~~

Every command prompts for what you leave out and takes what you pass as final.
`--defaults` answers everything, which is what CI and agents need — a prompt in
a non-interactive shell exits 1 without writing anything.

Prompts also disappear when they cannot apply: `--auth` is refused until `add
auth` has run, and the error-catalog question is not asked at all without `add
error-handling`.

### `generate page`

Writes `src/pages/<name>/` — the component, its `index.ts` public API — and the
route file that renders it:

~~~svelte
<!-- src/app/routes/dashboard/+page.svelte -->
<script lang="ts">
	import { DashboardPage } from '@/pages/dashboard';
</script>

<DashboardPage />
~~~

There is nothing else to forward. A Svelte page carries its own
`<svelte:head>`, so the title travels with the component — unlike a Next.js
route file, which has to re-export `metadata` or silently lose it.

`--route` takes SvelteKit's own segment forms: `(admin)/dashboard`,
`loans/[id]`, `docs/[...slug]`, `[[lang]]/home`, `loans/[id=integer]`.

`--auth` puts the page behind `requireSession()`. `--model` adds TanStack Query
hooks, `--errors` an error catalog for the codes its endpoints answer with.

### `generate slice`

Layers are `features`, `entities` and `widgets`. `pages` slices come from
`generate page`; `app` and `shared` are written by `init` and `add`.

`init` writes a `docs/fsd.md` that leaves `widgets/` closed and says so as a
project choice. FSD v2.1 itself has it as an ordinary layer — the spec's only
caution is that a UI block which is most of a page's content and is never reused
should not be one. The generator offers `widgets` because the methodology has
it; prefer `features/` unless you have decided otherwise, and record that
decision in `docs/fsd.md`.

`ui/` alone is the common case. `model/`, `api/` and `lib/` appear when the
slice actually has that code — an empty segment folder is noise.

A `model/` segment is written as `<name>.svelte.ts`, and that is not a style
choice: `$state` is compiled, not imported, and the Svelte compiler only
processes runes in `.svelte` components and in modules named that way. Rename
one to a plain `.ts` and `$state` becomes an undefined function at runtime, with
nothing failing at build time to tell you.

### `generate layout`

A shared shell for a group of routes: the component in `src/app/layouts/` plus
the `+layout.svelte` that renders it. Defaults to a route group — `(admin)` —
because that is a layout's usual reason to exist: shared chrome that contributes
nothing to the URL.

`--guard` puts every route under it behind the session, in one component. That
is where a guard belongs; a page that also checks for itself races the shell.

### `add error-handling`

`src/shared/api/`: an `ApiError` every failure is normalised into, per-domain
catalogs that map the API's machine codes to sentences, an axios client with a
**single-flight** 401 refresh, and a QueryClient that ends the session when a
refresh can no longer save it.

Two rules in there fail silently in a browser rather than loudly, which is why
they get the only generated test: a refresh storm logs the user out mid-session
on any backend that rotates refresh tokens, and refreshing a 401 that came from
`/auth/*` spends the cookie of whoever is already signed in.

The test is written where it can run with no setup — vitest if the project has
it, `bun test` under bun. Otherwise it is skipped and the command says so.

### `add auth`

`src/shared/auth/` and a login page. Assumes the API answers `POST /auth/login`
with an access token, keeps the refresh token in an httpOnly cookie, and serves
`GET /users/me`. Adjust the paths and the `Session` type if yours differ — they
are in one file each.

The access token lives in a module variable and nowhere else. A reload starts
with no token and the first 401 spends the cookie on a new one; `localStorage`
would only make it readable by any injected script.

`?next=` is validated with the WHATWG URL parser rather than a
`startsWith("/")` check, because that check is the one that gets bypassed —
browsers strip tab, CR and LF out of a URL *before* parsing it, so
`/<TAB>/evil.com` starts with a single slash right up until it becomes
`//evil.com`. That is the second generated test.

Every `goto()` goes through `resolve()` from `$app/paths`, so the app keeps
working under a non-empty `base` — and so the generated code passes
`svelte/no-navigation-without-resolve`, which is an error in a stock SvelteKit
ESLint config.

### `add prettier`

Only worth a command because of two pointers everyone has to rediscover: a
`.svelte` file needs `prettier-plugin-svelte` and a parser override to be
formatted at all, and Tailwind v4 has no config file for the class-sorting
plugin to find, so it needs `tailwindStylesheet` — pointed at the stylesheet
`init` moved. Prettier's own defaults are left alone; indent and print width are
taste.

Most SvelteKit projects already have prettier from `sv add prettier`, in which
case this refuses and prints what to add to the config you have. `init` repoints
that config's `tailwindStylesheet` either way — a stale one does not error, it
just stops sorting.

## Two linters, on purpose

`npm run lint` runs both, and they are not redundant:

| | catches | when |
|---|---|---|
| **ESLint** (`eslint.fsd.js`) | this import points the wrong way, or reaches past a slice's `index.ts` | as you type, per file |
| **steiger** (`steiger.config.ts`) | the same imports, plus a slice with no references, a layer sliced too finely, a segment named after its type | on demand, whole tree |

The overlap on imports is deliberate. steiger does check the boundary — ESLint is
not covering a gap in the plugin, it is covering a gap in *timing*. A rule you
only meet in CI is a rule you have already built ten files on top of.

`src/app/routes/` is in steiger's `ignores`, and that is not it being excused: it
is a SvelteKit segment whose every file is called `+page.svelte`, so steiger
would read that tree as slices and report on names SvelteKit chose. Its import
boundary is still enforced, by the half that can see an import at all.

`fsd/insignificant-slice` is configured as a **warning**. Every slice has exactly
one consumer on the day it is created, and failing the build for that teaches
people to delete the rule instead of the slice.

## Re-running a command extends, it does not rewrite

~~~bash
sveltekit-fsd generate slice features checkout --segments ui        # ui/ only
sveltekit-fsd generate slice features checkout --segments ui,model  # adds model/
sveltekit-fsd generate page dashboard --errors --defaults           # adds the catalog
~~~

Only the missing files are written, new exports are appended to the slice's
`index.ts`, and every existing file is left byte-for-byte alone. If there is
nothing to add, the command says so and writes nothing. A page that is already
routed from somewhere else does not get a second route file.

## Generated copy, and i18n

`--locale` decides what language the first draft of the generated user-facing
strings is written in — Thai (the default) or English. That is all it decides:
there is no runtime i18n here, and a project that adds one does not need a
different shape from this CLI. A catalog is a plain object, so build it from the
translator where it is rendered:

~~~svelte
<FormError error={save.error} catalogs={[{ CONFLICT: t('conflict') }]} fallback={t('saveFailed')} />
~~~

The codes stay the keys. They are the API's contract, not copy.

## Development

~~~bash
npm run verify             # tsc + the patcher unit tests + the smoke test
npm run test:integration   # slow, networked: a real sv create, install, check, lint, build
~~~

See [AGENTS.md](AGENTS.md) for what each check catches and what it misses.

## License

MIT
