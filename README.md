# @nakedev/sveltekit-fsd

[![npm](https://img.shields.io/npm/v/@nakedev/sveltekit-fsd)](https://www.npmjs.com/package/@nakedev/sveltekit-fsd)
[![node](https://img.shields.io/node/v/@nakedev/sveltekit-fsd)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@nakedev/sveltekit-fsd)](LICENSE)

Keep a SvelteKit project on [Feature-Sliced Design](https://feature-sliced.design).

- **`init`** shapes the layers once — including moving routing *into* the FSD app
  layer, which is what the methodology's own SvelteKit guide asks for — and wires
  up two linters that enforce the import boundary.
- **`generate`** writes pages, slices and layouts that all have the same shape.
- **`add`** installs the two pieces every project ends up rewriting by hand: API
  error handling and authentication.

SvelteKit already creates projects, so this CLI has no `create`. The workflow is
`sv create`, then `sveltekit-fsd init` once, then the same CLI from the project
whenever the frontend grows.

Sibling to [@nakedev/nextjs-fsd](https://www.npmjs.com/package/@nakedev/nextjs-fsd)
and [@nakedev/go-scaffold](https://www.npmjs.com/package/@nakedev/go-scaffold),
which generate the same architecture for Next.js and the Go backend these
templates are written against.

## Install

```bash
npm install --global @nakedev/sveltekit-fsd
sveltekit-fsd --help
```

npx and bunx work too, if you would rather not install anything:

```bash
npx @nakedev/sveltekit-fsd init
bunx @nakedev/sveltekit-fsd generate page dashboard
```

## Quick start

```bash
npx sv create my-app --template minimal --types ts --add prettier eslint tailwindcss
cd my-app

sveltekit-fsd init                 # once: move routing into the app layer, add linters, docs, skills
sveltekit-fsd add auth             # shared/auth + a login page (pulls in error handling)
sveltekit-fsd generate page dashboard --auth
```

What you end up with:

```
src/
├─ app/                              # the FSD app layer — SvelteKit's own files live here
│  ├─ routes/                        # moved from src/routes
│  │  ├─ +layout.svelte              # wrapped in <Providers>
│  │  ├─ login/+page.svelte
│  │  └─ dashboard/+page.svelte
│  ├─ layouts/                       # generate layout writes here
│  ├─ providers/                     # QueryClientProvider
│  ├─ styles/app.css                 # moved from src/routes
│  └─ index.html                     # moved from src/app.html
├─ pages/
│  ├─ login/          { ui/, index.ts }
│  └─ dashboard/      { ui/, index.ts }
└─ shared/
   ├─ api/                           # ApiError, error catalogs, axios client, QueryClient
   ├─ auth/                          # session, requireSession, in-memory access token
   ├─ config/env.ts
   └─ ui/form-error.svelte
```

`features/` and `entities/` are not created empty — they appear when a slice
actually needs them. Then:

```bash
npm run dev
npm run check                      # svelte-check — this is the typecheck
npm run lint                       # eslint (import boundary) + steiger (whole tree)
```

## Requirements

- **Node.js >=20.9** to run the CLI.
- A **SvelteKit 2** project in TypeScript, created by `sv create`. Svelte 5 and
  runes mode — the generated components use `$props`, `$state`, `$derived` and
  `$effect`, and `sv create` turns runes on for you.
- The project's **package manager** — npm, pnpm, yarn or bun. Detected from the
  lockfile; the CLI installs the dependencies its templates need.
- **Tailwind CSS**, if you want the generated markup to look like anything —
  everything this CLI emits is styled with utility classes (`npx sv add
  tailwindcss`). Without it, `init` writes no stylesheet and says so.
- An **HTTP API** for `add auth` and `add error-handling` to talk to. Both are
  written against the shape go-scaffold produces; see their sections for what to
  change if yours differs.

## Commands

```bash
sveltekit-fsd                                  # interactive menu
sveltekit-fsd wizard                            # same menu, explicit form
sveltekit-fsd init [--locale th|en] [--no-install] [--no-hooks] [--defaults]

sveltekit-fsd generate page <name...> [--title <t>] [--route <path>] [--no-route] [--auth] [--api] [--errors] [-r <root>]
sveltekit-fsd generate slice <features|entities|widgets> <name...> [-s <segments...>] [-r <root>] [--errors]
sveltekit-fsd generate layout <name> [--route <path>] [--no-route] [--guard]

sveltekit-fsd add error-handling [-y] [--no-install]
sveltekit-fsd add auth [-y] [--no-install]
sveltekit-fsd add prettier [-y] [--no-install]

sveltekit-fsd config show
sveltekit-fsd config set locale th|en
```

Run `sveltekit-fsd` or `sveltekit-fsd wizard` if you do not know which command to
use. The menu guides you to `init`, `generate`, `add`, or project config, and the
next questions ask for names, layers, segments, routes, auth, API hooks, and
error catalogs. You can also run a subcommand with only the values you know; the
missing values open prompts in an interactive terminal.

`--defaults` answers every remaining question, which is what CI and agents need
— a prompt in a non-interactive shell exits 1 without writing anything.

Prompts also disappear when they cannot apply: `--auth` is refused until `add
auth` has run, and the error-catalog question is not asked at all without `add
error-handling`.

### `init`

The one command that rearranges a project you already have:

In an interactive terminal, `init` asks whether to install dependencies and
whether to add the Conventional Commit hook. `--no-install` and `--no-hooks`
remain available for scripts and CI.

| | before | after |
|---|---|---|
| routing | `src/routes/` | `src/app/routes/` |
| page template | `src/app.html` | `src/app/index.html` |
| stylesheet | `src/routes/layout.css` (wherever the layout imports it from) | `src/app/styles/app.css` |

and it points SvelteKit at all three, by patching whichever config file is
actually live — `vite.config.ts` or `svelte.config.js`, never both
([why](docs/design-notes.md#which-config-file-init-patches)):

```js
files: { routes: 'src/app/routes', appTemplate: 'src/app/index.html' },
alias: { '@/*': 'src/*' }
```

`tsconfig.json` is **not** touched — SvelteKit writes `kit.alias` into the
generated `.svelte-kit/tsconfig.json` that yours extends.

It also adds:

- `eslint.fsd.js` — the import boundary as ESLint rules, spread into your flat
  config. No new dependencies: core `no-restricted-imports` plus the layer order.
- `steiger.config.ts` + `steiger` and the FSD plugin, chained onto `lint`.
  [Why two linters](docs/design-notes.md#two-linters-on-purpose).
- `components.json` so `shadcn-svelte add` writes into `src/shared/ui`.
- `docs/fsd.md` — the convention, in this project's own words.
- `AGENTS.md` and two agent skills at the repository root. Codex can load the
  project guidance from `AGENTS.md`; Claude Code can use the skills through the
  `.claude/skills/` symlinks. The CLI does not install agent lifecycle hooks or
  modify agent settings.
- A `commit-msg` hook that checks the subject is a Conventional Commit — shape
  only; your language and emoji rules stay yours.

Anything it would write that you already have is left alone and listed at the
end, rather than the whole command refusing over one file.

### `generate page`

Writes one or more pages slices under the configured FSD root — the component
and its `index.ts` public API — plus the route files that render them:

```svelte
<!-- src/app/routes/dashboard/+page.svelte -->
<script lang="ts">
	import { DashboardPage } from '@/pages/dashboard';
</script>

<DashboardPage />
```

There is nothing else to forward: a Svelte page carries its own `<svelte:head>`,
so the title travels with the component.

`--route` takes SvelteKit's own segment forms: `(admin)/dashboard`, `loans/[id]`,
`docs/[...slug]`, `[[lang]]/home`, `loans/[id=integer]`.

Names may include a slice group, such as `admin/dashboard`, and `--root` may
choose another FSD root inside `src/` (for example `src/domain`). The SvelteKit
`src/lib/` directory remains reserved for `$lib`. Multiple page names use their
name as their route; pass `--route` only when generating one page.

`--auth` puts the page behind `requireSession()`. `--api` adds the page's
TanStack Query hooks under `api/<name>.ts`, while `--errors` adds an error
catalog for the codes its endpoints answer with. The old `--model` flag remains
as a compatibility alias for `--api`.

### `generate slice`

Layers are `features`, `entities` and `widgets`. `pages` slices come from
`generate page`; `app` and `shared` are written by `init` and `add`. Prefer
`features/` — [`widgets/` is closed by project
choice](docs/design-notes.md#why-widgets-is-closed-by-project-choice).

`ui/` alone is the common case. `model/`, `api/`, `lib/` and `config/` appear when
the slice actually has that code. A `model/` segment is written as `<name>.svelte.ts`, and
that [is not a style choice](docs/design-notes.md#why-a-model-segment-is-a-runes-module).
Page-specific requests stay in `pages/<name>/api/`; reusable domain requests
move to `entities/<name>/api/`, reusable actions to `features/<name>/api/`, and
generic CRUD primitives to `shared/api/`.

The command accepts multiple slice names, comma-separated or as separate
arguments, and supports slice groups such as `employee/employee-record`:

```bash
sveltekit-fsd generate slice entities user profile -s ui api
sveltekit-fsd generate slice features employee/employee-record -s ui -r src/domain
```

`-s` is the short form of `--segments`; both comma-separated and space-separated
segments work. `-r` is the short form of `--root`.

### `generate layout`

A shared shell for a group of routes: the component in `src/app/layouts/` plus
the `+layout.svelte` that renders it. Defaults to a route group — `(admin)` —
because that is a layout's usual reason to exist: shared chrome that contributes
nothing to the URL.

`--guard` puts every route under it behind the session, in one component. That is
where a guard belongs; a page that also checks for itself races the shell.

### `add error-handling`

Writes `src/shared/api/`: an `ApiError` every failure is normalised into,
per-domain catalogs mapping the API's machine codes to sentences, an axios client
with a single-flight 401 refresh, and a QueryClient that ends the session when a
refresh can no longer save it.

Two rules in there fail silently in a browser rather than loudly, which is why
they get the only generated test —
[details](docs/design-notes.md#the-two-rules-in-add-error-handling-that-get-the-only-generated-test).

### `add auth`

Writes `src/shared/auth/` and a login page. Assumes the API answers `POST
/auth/login` with an access token, keeps the refresh token in an httpOnly cookie,
and serves `GET /users/me`. Adjust the paths and the `Session` type if yours
differ — they are in one file each.

The access token lives in a module variable and nowhere else, and `?next=` is
parsed rather than prefix-checked. Both are
[deliberate](docs/design-notes.md#why-the-access-token-lives-in-a-module-variable).

### `add prettier`

Worth a command only because of two pointers everyone has to rediscover —
`prettier-plugin-svelte` with a parser override, and `tailwindStylesheet` for
Tailwind v4 ([details](docs/design-notes.md#what-add-prettier-is-actually-for)).
Most projects already have prettier from `sv add prettier`, in which case this
refuses and prints what to add to the config you have.

## Re-running a command extends, it does not rewrite

```bash
sveltekit-fsd generate slice features checkout --segments ui        # ui/ only
sveltekit-fsd generate slice features checkout --segments ui,model  # adds model/
sveltekit-fsd generate page dashboard --errors --defaults           # adds the catalog
```

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

```svelte
<FormError error={save.error} catalogs={[{ CONFLICT: t('conflict') }]} fallback={t('saveFailed')} />
```

The codes stay the keys. They are the API's contract, not copy.

## Development

```bash
npm run verify             # tsc + the patcher unit tests + the smoke test
npm run test:integration   # slow, networked: a real sv create, install, check, lint, build
```

See [AGENTS.md](AGENTS.md) for what each check catches and what it misses, and
[docs/design-notes.md](docs/design-notes.md) for why the generated code looks the
way it does.

## Releases

Every pull request into `main` must increase the root `package.json` version.
The CI version check compares it with the pull request base and also requires
`package-lock.json` to carry the same version. Use npm to update both files:

```bash
npm version patch --no-git-tag-version
npm run verify
```

After the version change is merged, create an annotated `vX.Y.Z` tag on that
`main` commit. The release workflow verifies that the tag matches
`package.json` before publishing.

## License

MIT
