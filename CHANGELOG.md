# Changelog

All notable changes to @nakedev/sveltekit-fsd are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
