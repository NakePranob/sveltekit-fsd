<div align="center">
  <img src=".github/assets/readme/hero.png" alt="sveltekit-fsd: SvelteKit structure that survives growth" width="100%">
  <h1>sveltekit-fsd</h1>
  <p><strong>SvelteKit structure that survives growth.</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/@nakedev/sveltekit-fsd"><img src="https://img.shields.io/npm/v/@nakedev/sveltekit-fsd.svg" alt="npm version"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@nakedev/sveltekit-fsd.svg" alt="Node.js version"></a>
    <a href="https://github.com/NakePranob/sveltekit-fsd/actions/workflows/ci.yml"><img src="https://github.com/NakePranob/sveltekit-fsd/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/npm/l/@nakedev/sveltekit-fsd.svg" alt="license"></a>
  </p>
</div>

`sveltekit-fsd` is an npm CLI for keeping a **SvelteKit** project on
**Feature-Sliced Design**. It moves routing into the FSD app layer once, wires
two linters around the import boundary, and then generates pages, slices, and
layouts with the same shape. Auth, API error handling, and formatting are
commands too.

SvelteKit already creates projects, so this CLI has no `create`. The workflow is
`sv create`, one `sveltekit-fsd init`, then the same CLI from the project
whenever the frontend grows.

## Why sveltekit-fsd

- **Routing is part of the architecture, not beside it.** `init` moves
  `src/routes` into the FSD app layer (`src/app/routes`) instead of leaving two
  structures to drift apart.
- **Every slice has the same shape.** Pages, slices, and layouts are generated
  with the same segments and public APIs.
- **The cross-cutting wiring is already done.** Auth, API error normalization,
  session handling, and formatting arrive as commands, not as a checklist.

## Quick start

```bash
npm install --global @nakedev/sveltekit-fsd
npx sv create my-app --template minimal --types ts --add prettier eslint tailwindcss

cd my-app
sveltekit-fsd init                 # once: move routing, add linters and docs
sveltekit-fsd add auth             # shared/auth + a login page
sveltekit-fsd generate page dashboard --auth
```

Then:

```bash
npm run dev
npm run check                      # svelte-check
npm run lint                       # eslint (import boundary) + steiger (whole tree)
```

`features/` and `entities/` are not created empty; they appear when a slice
actually needs them.

### Requirements

- **Node.js >=20.9** for the CLI.
- A **SvelteKit 2 or 3** project in TypeScript, created by `sv create`.
- **Svelte 5** and runes mode. The generated components use `$props`, `$state`,
  `$derived`, and `$effect`; `sv create` turns runes on for you.
- A SvelteKit 3 app itself needs **Node.js 22.17+**.

## What you get

| Area | What `sveltekit-fsd` gives you |
| --- | --- |
| **App layer** | Routing moved to `src/app/routes`, with layouts, providers, styles, and `app.html` in one FSD app layer. |
| **Layers** | `pages`, `widgets`, `features`, `entities`, and `shared` in the FSD shape. |
| **Boundaries** | ESLint import rules plus Steiger for the whole tree. |
| **Generators** | Pages, slices, and layouts with consistent segments and public APIs. |
| **Auth** | A login page, session store, access token handling, route guard, and the API client it needs. |
| **Error handling** | One API error type, error catalogs, and the client boundary that normalises failures. |
| **Formatting** | Prettier with Tailwind class sorting. |
| **Agent guidance** | Repository-level `AGENTS.md`, `CLAUDE.md`, and a generated skill that knows the project's paths. |

## How it fits together

```mermaid
flowchart TB
  ROUTE[src/app/routes] --> PAGE[pages]
  APPF[src/app: layouts, providers, styles] --> ROUTE
  PAGE --> WIDGET[widgets]
  WIDGET --> FEATURE[features]
  FEATURE --> ENTITY[entities]
  ENTITY --> SHARED[shared]
```

SvelteKit still owns routing, but the route tree lives inside the FSD app layer.
Pages compose widgets, widgets compose features, features use entities, and
everything may use shared. The linters enforce that direction.

## Generated project

```text
src/
├─ app/                      # FSD app layer
│  ├─ routes/                # SvelteKit routes, moved from src/routes
│  ├─ layouts/               # generated layout components
│  ├─ providers/             # query client and other providers
│  ├─ styles/                # app.css
│  └─ index.html             # moved from src/app.html
├─ pages/                    # one folder per route screen
├─ widgets/                  # composed UI blocks
├─ features/                 # user actions
├─ entities/                 # business entities
└─ shared/                   # api, auth, config, ui, lib
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Move routing into the FSD app layer, add linters and docs. |
| `generate page [name]` | Add a route page with its slice and wiring. |
| `generate slice [layer] [name]` | Add a `features` or `entities` slice. |
| `generate layout [name]` | Add shared chrome for a route group. |
| `add auth` | Add password login, session handling, and a login page. |
| `add error-handling` | Add the API error boundary and error catalogs. |
| `add prettier` | Add formatting with Tailwind class sorting. |
| `config` | Inspect and change project settings. |

Run any command with `--help` for its current options. The full command
reference — wizard behavior, every option, generated output, and limitations —
lives in [`REFERENCE.md`](REFERENCE.md).

## Learn more

- [Full command reference](REFERENCE.md)
- [Design notes](docs/design-notes.md)
- [Source, template, and test workflow](AGENTS.md)
- Sibling projects: [`go-scaffold`](https://www.npmjs.com/package/@nakedev/go-scaffold) and [`nextjs-fsd`](https://www.npmjs.com/package/@nakedev/nextjs-fsd)

## Development

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
```

See [`AGENTS.md`](AGENTS.md) for the source/template/test workflow and the
release contract.

## License

MIT — see [LICENSE](LICENSE).
