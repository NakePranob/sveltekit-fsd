# Agent Guidance: sveltekit-fsd

This repo is a CLI that shapes *other people's* SvelteKit projects. Every change
here is a change to code you will never see run — a template that renders wrong
produces a project that fails to build for someone else, hours later. That
asymmetry is what the rules below are about.

Sibling to [nextjs-fsd](https://github.com/NakePranob/nextjs-fsd); the structure,
the command surface and most of `src/utils/` are deliberately the same, so a fix
in one is usually worth porting to the other. What is *not* the same is
everything downstream of the framework — see "What SvelteKit changes" below.

## Source of truth

- `templates/**/*.hbs` — the code this CLI emits. Editing generated output in a
  test project fixes nothing; fix the template.
- `templates/init/fsd-skill/**` — the FSD v2.1 methodology skill, copied into
  every project verbatim. Not Handlebars, on purpose: see below.
- `src/commands/*.ts` — which templates run, in what order, with what context.
- `src/utils/project.ts` — the patchers that edit files this CLI did not write.
  The riskiest code in the repo.
- `README.md` — the user-facing contract. Update it in the same change.
- Generated docs live in `templates/init/{fsd.md,agents-section.md,skill.md}.hbs`.
  A convention change touches all three plus `README.md`, or the four drift.

## Verification

```bash
npm run verify   # tsc + unit tests + smoke test
```

`tests/patch.test.mjs` covers the file patchers in isolation, where the fiddly
cases live. `scripts/smoke-test.mjs` drives the real binary through
init → add → generate → extend against a hand-built fixture and inspects the
output; it needs no network and no package install.

The smoke test also **runs steiger over its output**, by symlinking this repo's
`node_modules` into the fixture — which is why `steiger` and its FSD plugin are
devDependencies here. They are never shipped (`files` carries `dist`,
`templates`, `bin`, `LICENSE`).

Running the linter matters more than it sounds. Reading a generated
`steiger.config.ts` and asserting on its text cannot tell a working config from
an inert one — a rule name the plugin does not have, or a severity that is
wrong, both read fine. steiger also prints its findings to **stderr** and exits
0 for a warning, so that check reads both streams; a version of it that only
read stdout would pass against a linter that said nothing at all.

```bash
npm run test:integration   # slow, networked: real sv create + install + check + lint + build
```

The `version` CI job runs on pull requests into `main`. It requires the root
package version to increase from the pull request base and requires
`package-lock.json` to carry that same version; `npm version patch
--no-git-tag-version` updates both package files.

The generated project has four checks, four different failures, none subsuming
another:

| | catches | misses |
|---|---|---|
| assertions on generated text | a template that stopped emitting something | anything that only fails at compile time |
| `steiger` on the fixture | a generated lint config that is inert, or a severity that fails `lint` on brand-new code | a rule that only misfires against a shape the fixture does not have |
| `test:integration` — `svelte-check` | a template emitting Svelte that does not compile, or calling a TanStack Query API that moved | speed; it needs minutes and a network |
| `test:integration` — the boundary probe | an ESLint config that loads and matches nothing | a layer the probe does not exercise |

That last row exists because a flat config with a glob that matches no file
loads cleanly, lints nothing, and reads exactly like one that works. The probe
writes a deliberate upward import and fails the run if ESLint stays quiet.

The integration job runs on Node 24, and the `verify` job on 22. That is not
drift: npm 10 — which Node 22 ships — cannot install the dependency graph a
current `sv create` produces with its add-ons, and fails with
`Cannot read properties of null (reading 'edgesOut')` on an untouched scaffold.
It is `sv`'s graph, not ours; the CLI's own `engines` are still what `verify`
tests on 22.

The integration test re-runs `prettier --write .` after installing. That is not
papering over a bug: `init` formats what it writes with the *project's* prettier,
and on a tree that has never been installed there is none to resolve. The normal
order — create, install, init — does not hit it.

## What SvelteKit changes

Ported code from nextjs-fsd is wrong by default in these places:

- **Routing lives inside the app layer.** `kit.files.routes` points at
  `src/app/routes`, so the FSD layers keep their real names (`app`, `pages`) —
  no `_app`/`_pages` prefixes, and no `fsd/typo-in-layer-name` override.
- **The SvelteKit config is in one of two files, and only one is read.**
  `@sveltejs/kit` loads from the Vite config first and falls back to
  `svelte.config.js`. `detectKitConfig` picks the live one. Writing to the other
  is a silent failure: correct values, nothing reads them, routes have moved.
- **No `tsconfig.json` patching.** SvelteKit generates the alias half itself.
- **There is no `metadata` to re-export.** A page owns its `<svelte:head>`.
- **There is no `"use client"`.** The `--client` flag from nextjs-fsd has no
  analogue and is not replaced by one.
- **A module using runes must be named `*.svelte.ts`** and imported without the
  `.ts`. A rune in a plain `.ts` is not a compile error; it is an undefined
  function at runtime.
- **TanStack Query's Svelte adapter takes options as a function** —
  `createQuery(() => ({ ... }))` — and its result is a rune, read as
  `query.data`, not `$query.data`. The v5 store API is a different major.
  `createQuery` / `createMutation` / `useQueryClient` only work during component
  initialisation.
- **Anything that resolves the `@/` alias needs `svelte-kit sync` first.** The
  project's `tsconfig.json` does nothing but extend the generated
  `.svelte-kit/tsconfig.json`, which is gitignored — so on a fresh clone steiger
  does not degrade, it dies with a `MODULE_NOT_FOUND` stack trace out of
  tsconfck. The generated `lint` script syncs before steiger for that reason,
  the same way SvelteKit's own `check` script does.
- **A segment with one file and no `index.ts` is a steiger error.** It is why
  `add error-handling` appends to `shared/auth/index.ts` for the access token it
  writes there, months before `add auth` may run. Any new `add` that drops a
  file into a segment another command owns has the same obligation.
- **`goto()` goes through `resolve()`** from `$app/paths`, or takes a value
  typed `ResolvedPathname`. `svelte/no-navigation-without-resolve` is an *error*
  in a stock `sv create` ESLint config, so a bare string means generated code
  that fails the project's own lint on day one.

## Patching someone else's files

`patchKitConfig`, `patchEslintConfig`, `patchLayoutProviders`,
`patchLayoutStyleImport`, `patchPrettierTailwindStylesheet` and `addLayoutImport`
edit files the user owns. Rules learned the hard way, each pinned by a test:

- **`match.index === 0` is a real position.** `if (!match.index)` treats the
  first line of a file as "not found".
- **Anchor on the narrowest thing that is unambiguous.** `sveltekit(` and the
  single character after it; `{@render children()}`, which appears exactly once.
- **Compute both offsets from the original source, then edit the later one
  first.** Re-finding text with `indexOf` after an edit is how you patch the
  wrong occurrence.
- **Every miss returns a status, never a wrong edit.** `"manual"` plus printed
  instructions beats a mangled file. A command that reports success over a
  broken file is the worst outcome available.
- **A path that becomes a glob stays posix.** `routesDir` is interpolated into
  ESLint `files` globs and steiger `ignores`, and a glob containing a backslash
  matches nothing. The filesystem hides the bug — Windows accepts both
  separators — so it surfaces as a lint rule that quietly stopped applying.
  Windows CI is the only thing that catches this class.
- **`init` moves no code the user wrote.** It moves SvelteKit's own files
  (`routes/`, `app.html`, the stylesheet the layout imports) and nothing else.
  That is why `kit.files.lib` is left alone even though the FSD guide sets it —
  see README.

## Ordering inside `init`

The stylesheet move happens **before** anything is rendered, and that is
load-bearing rather than tidy. Moving it invalidates the `tailwindStylesheet`
pointer in the project's prettier config, and `prettier-plugin-tailwindcss`
throws on a stylesheet that is not there — which `formatFiles` swallows, quietly
leaving every file written before that point unformatted for `prettier --check`
to find. `formatFiles` also clears prettier's config cache for the same reason.

Everything `init` writes or patches has to come out matching the project's own
formatter, including the ~3,300 lines of methodology skill: `add prettier` puts
`prettier --check .` on `lint`, and a project whose `.prettierignore` does not
exclude markdown would otherwise fail on files nobody typed.

## Templates

- The templates are the output, so `.gitattributes` pins the repo to LF in the
  working tree. Git on Windows would otherwise check them out as CRLF and the
  CLI would emit CRLF there and LF everywhere else — a generator whose output
  depends on the host OS gives two developers on one project diffs that are
  nothing but line endings. The smoke test asserts no generated file contains
  `\r\n`; on a Unix host that passes trivially, so it is really a guard for
  Windows CI.
- No literal `{{` outside a Handlebars expression. The smoke test asserts no
  `{{` survives into any generated file. **This is why the FSD skill under
  `templates/init/fsd-skill/` is copied, never rendered** — one of its reference
  files contains a Vue example with `{{ comment.text }}` in it, which Handlebars
  would render to nothing. `readTemplateTree` exists for that; the smoke test
  asserts that line survives.
- Svelte's `{#if}` is a single brace and passes through Handlebars untouched, so
  a template can hold both. Read carefully: `{{#if}}` is ours, `{#if}` is theirs.
- `*/` inside a JSDoc comment closes it. Reword rather than reaching for an
  invisible character.
- Generated user-facing copy comes from `src/utils/copy.ts`, keyed by locale —
  not from `{{#if}}` branches in the template. One place to forget a language
  instead of six.
- Comments in generated code explain *why*, in the voice of the project that
  will own them. They are read far more often than this repo is.

## Scope discipline

This CLI has no `create` — SvelteKit owns that — and no `undo`. It writes no
empty layer directories, because "add a layer when a second consumer appears" is
FSD's own advice, not a shortcut. Adding a command means arguing that the
alternative (a `mkdir`, an `rm -rf`, a linter that already reports it) is
genuinely worse.

## Git

Conventional Commit subjects, English, and **no emoji** —
`type(optional-scope): what changed`. That last rule is the opposite of
loan-management's, the repo this CLI's sibling was extracted from and where the
same author writes emoji subjects daily, which is exactly why
`.githooks/commit-msg` checks for one rather than trusting anybody to remember.
It also refuses a Thai subject, and lets a bare version through.

- The body carries *why*, in paragraphs: what the diff cannot say for itself,
  what was checked, what is still a TODO.
- A release commit is the bare version — `0.1.0` — with a body arguing why it is
  major, minor or patch.
- Branch `type/<summary>`; PR base is `main`, title in the shape of a commit
  subject, description in English.
- Nothing publishes without a `v*.*.*` tag pointing at a matching
  `package.json` — `scripts/check-release.mjs` refuses anything else (annotated
  tag, at HEAD, clean tree, `files` carrying dist/templates/bin), and
  `release.yml` triggers on nothing but that tag. Pushing a branch is safe.

## The first release is the awkward one

npm will not let you configure a trusted publisher for a package that does not
exist — the settings page it lives on is the package's. So the bootstrap runs in
the other order, once:

```bash
npm login
git tag -a v0.1.0 -m 0.1.0        # annotated; check-release refuses lightweight
npm publish --access public        # prepublishOnly runs release:check + verify
```

Then, on npmjs.com, add a trusted publisher for the package —
`NakePranob/sveltekit-fsd`, workflow `release.yml`, environment `npm-release` —
and every release after that is `git push origin vX.Y.Z` and nothing else. The
publish step skips a version that is already on the registry, so pushing the
v0.1.0 tag after that manual publish is harmless rather than a red run.

No token is stored anywhere. `id-token: write` plus the trusted publisher is the
whole credential, which is why `registry-url` must stay out of `setup-node` — it
writes an `.npmrc` with a placeholder token that npm then tries to authenticate
with instead of exchanging the OIDC one.

Hooks are per-clone, so a fresh checkout needs one line before any of that is
enforced:

```bash
git config core.hooksPath .githooks
```

## Before handing off

Run `npm run verify`, then `git diff --check`, `git diff` and `git status -sb`.
Report the exact output and say which limitations are still there. If a template
changed, say which generated file changed with it.
