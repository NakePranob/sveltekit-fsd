# Changelog

All notable changes to @nakedev/sveltekit-fsd are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **`init` refuses a SvelteKit config that already sets `files` or `alias`, and
  refuses before moving anything.** Its keys went in at the top of the options
  object, and JavaScript keeps the later of two equal keys — so the project's
  own `alias` silently replaced `@/*` (or its `files` the moved routes) while
  init reported the config as patched. It now prints the block to merge by hand
  and leaves the tree untouched; before, an unpatchable config was discovered
  only after the routes had moved.
- **The docs `init` writes no longer say `$lib` and `@/` are one tree.**
  `docs/fsd.md`, the AGENTS.md section, the `sveltekit-fsd` skill and the
  methodology skill's SvelteKit section all described `kit.files.lib: 'src'`,
  which init has never set. Re-copy those passages into a project initialised
  with 0.1.0: an agent following them writes `$lib/shared/...` imports that
  resolve nowhere.
- **Imports are no longer spliced into a wrapped import.** The layout and ESLint
  patchers inserted after the *first line* of the last import, so a last import
  prettier had wrapped came out unparseable, reported as `patched`.
- **Applying an existing layout to a second route no longer exports it twice.**
  The barrel check compared text exactly, and `sv add prettier`'s singleQuote
  had already rewritten the line — a duplicate export is a syntax error.
- **Installing dependencies works on Windows.** npm, npx, pnpm and yarn are
  `.cmd` shims there, which `execFile` cannot start.

## 0.1.0

First release. A SvelteKit sibling to
[@nakedev/nextjs-fsd](https://www.npmjs.com/package/@nakedev/nextjs-fsd), with
the same command surface and the same architecture, adapted to Svelte 5 and
SvelteKit 2.

### Added

- `init` — moves `src/routes` into `src/app/routes` and `src/app.html` into
  `src/app/index.html`, points SvelteKit at both plus an `@/*` alias, moves the
  stylesheet into the app layer, and adds the two linters, `components.json`,
  `docs/fsd.md`, a Conventional Commit hook, and two agent skills.
- `generate page | slice | layout`, each of which extends what already exists
  rather than refusing or rewriting.
- `add error-handling` — `ApiError`, per-domain catalogs, an axios client with a
  single-flight 401 refresh, and a QueryClient that ends the session when a
  refresh can no longer save it.
- `add auth` — an in-memory access token, session hooks, `requireSession` with a
  validated `?next=` round trip, and a login page.
- `add prettier` — the svelte parser and the Tailwind class-sorting plugin,
  pointed at the stylesheet `init` moved.
- `config show | set locale`.
- The FSD v2.1 methodology shipped into every project as a
  `feature-sliced-design` skill, including a SvelteKit section written against
  the layout this CLI produces.

### Fixed before release

- `add error-handling` leaves `shared/auth/` with a public API. It writes
  `access-token.ts` there, and `add auth` may not run for months — a segment
  holding one file and no `index.ts` is a steiger **error**, so the add reported
  success and left `lint` red. The export is appended rather than rendered, so a
  project that already has its own `shared/auth/index.ts` keeps it.
- The generated `lint` script runs `svelte-kit sync` before steiger. steiger
  resolves the `@/` alias through a `tsconfig.json` whose only job is to extend
  the generated `.svelte-kit/tsconfig.json`, and that directory is gitignored —
  so on a fresh clone steiger did not degrade, it died with a `MODULE_NOT_FOUND`
  stack trace.

### Notes

The generated `docs/fsd.md` leaves `widgets/` closed and says that is **this
project's** call, not the spec's. FSD v2.1 has `widgets` as an ordinary layer;
its only caution is that a UI block which is most of a page's content and is
never reused should not be one. Ported from nextjs-fsd, where attributing the
closed layer to the spec had made the decision unarguable in a downstream
project that copied the generated doc into its own AGENTS.md.

The same paragraph now says when "prefer `shared/<domain>/` over a new
`entities/` slice" stops applying — a business rule landing in the segment, or
two `pages` slices each keeping their own copy of one API resource. Neither
signal is a page count.


Two settings from the official FSD SvelteKit guide are deliberately not applied:
`files.lib: 'src'` (it would require moving code the user wrote) and
`assets: 'public'` (a rename with no FSD content). README says why.
