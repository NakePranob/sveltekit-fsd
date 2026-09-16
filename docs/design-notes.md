# Design notes

Why this CLI does what it does. The [README](../README.md) covers what it does;
this file is the reasoning behind the choices that look arbitrary until you hit
the thing they are avoiding.

## Which config file `init` patches

`init` writes `kit.files` and `kit.alias` into **either** `vite.config.ts` or
`svelte.config.js`, whichever one is live — never both, never a fixed one.

That is not a matter of taste. SvelteKit loads its config from the Vite config
*first* and only falls back to `svelte.config.js`. Recent `sv create` writes no
`svelte.config.js` at all; projects made before that have the opposite shape.
Writing to the wrong one leaves a file with correct values that nothing reads,
and routes that moved with nothing pointing at them.

If the live config already sets `files` or `alias`, `init` stops before moving
anything and prints the block to merge in by hand. A second key of the same name
is not an error in JavaScript — the later one wins — so adding ours next to
yours would silently drop one of them. Merge it, then run `init` again.

## `tsconfig.json` is not touched

SvelteKit writes `kit.alias` into the generated `.svelte-kit/tsconfig.json` that
yours extends, so Vite, `svelte-check`, your editor and steiger all resolve `@/`
from one place. Adding `paths` to your own `tsconfig.json` would make a second
source of truth for the same mapping.

## Two departures from the official FSD SvelteKit guide

The [official guide](https://feature-sliced.design/docs/guides/tech/with-sveltekit)
sets two more options. This CLI does not.

**`files.lib: 'src'`** would point `$lib` at the same tree as `@`. It is the
tidier end state — one name per module — but getting there means moving
everything in `src/lib/` and rewriting the `$lib/` imports that named it,
including the favicon import in the layout `sv create` just wrote. `init` moves
no code you wrote. `$lib` keeps meaning `src/lib`, steiger ignores that
directory, and the generated `docs/fsd.md` says plainly that `shared/` is where
the layers' shared code goes, so the two do not both grow.

**`assets: 'public'`** renames `static/`. That is a rename with no FSD content in
it, so `static/` is left alone.

## Why a model segment is a runes module

`$state` is compiled, not imported, and the Svelte compiler only processes runes
in `.svelte` components and in modules named `*.svelte.ts`. Rename one to a plain
`.ts` and `$state` becomes an undefined function at runtime, with nothing failing
at build time to tell you.

## Why `widgets/` is closed by project choice

The `docs/fsd.md` that `init` writes leaves `widgets/` closed and says so as a
project choice, not as a claim about the methodology. FSD v2.1 has it as an
ordinary layer — the spec's only caution is that a UI block which is most of a
page's content and is never reused should not be one.

`generate slice` offers `widgets` because the methodology has it. Prefer
`features/` unless you have decided otherwise, and record that decision in
`docs/fsd.md`.

## The two rules in `add error-handling` that get the only generated test

Both fail silently in a browser rather than loudly:

- A refresh storm logs the user out mid-session on any backend that rotates
  refresh tokens. Hence the **single-flight** 401 refresh: concurrent 401s wait
  on one refresh call rather than each spending the cookie.
- Refreshing a 401 that came from `/auth/*` spends the cookie of whoever is
  already signed in. So those paths are excluded from the retry.

The test is written where it can run with no setup — vitest if the project has
it, `bun test` under bun. Otherwise it is skipped and the command says so.

## Why the access token lives in a module variable

A reload starts with no token and the first 401 spends the httpOnly refresh
cookie on a new one. `localStorage` would only make it readable by any injected
script.

## Why `?next=` is parsed, not `startsWith("/")`-checked

`add auth` validates `?next=` with the WHATWG URL parser. The `startsWith("/")`
check is the one that gets bypassed: browsers strip tab, CR and LF out of a URL
*before* parsing it, so `/<TAB>/evil.com` starts with a single slash right up
until it becomes `//evil.com`. That is the second generated test.

Every `goto()` goes through `resolve()` from `$app/paths`, so the app keeps
working under a non-empty `base` — and so the generated code passes
`svelte/no-navigation-without-resolve`, which is an error in a stock SvelteKit
ESLint config.

## What `add prettier` is actually for

Two pointers everyone has to rediscover: a `.svelte` file needs
`prettier-plugin-svelte` and a parser override to be formatted at all, and
Tailwind v4 has no config file for the class-sorting plugin to find, so it needs
`tailwindStylesheet` pointed at the stylesheet `init` moved. Prettier's own
defaults are left alone; indent and print width are taste.

Most SvelteKit projects already have prettier from `sv add prettier`, in which
case the command refuses and prints what to add to the config you have. `init`
repoints that config's `tailwindStylesheet` either way — a stale one does not
error, it just stops sorting.

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

## Why `init` creates no empty layer directories

`features/` and `entities/` appear when a slice actually needs them. That is
FSD's own advice rather than a shortcut: an empty layer directory is a standing
invitation to put something in it for the symmetry.
