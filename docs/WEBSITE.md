# Website and documentation — brief

Decisions taken with the PO for milestone **W** of [`PLAN.md`](PLAN.md). Every W task reads this file first. When this brief and `CLAUDE.md` disagree, `CLAUDE.md` wins for conventions and this brief wins for the website.

## Goal

A public site at **`https://yaggui.tropico.dev`** with two parts, built and deployed together:

- **Landing page** (`/`): presents yaggui and gets people to download it.
- **Documentation** (`/docs/`): explains how to use yaggui, versioned per release, in English and French.
- **Live demo** (`/demo/`): the real frontend running on the mocked backend, in the browser.

## Stack

| Concern | Choice |
|---|---|
| Site generator | [Astro](https://astro.build) with [Starlight](https://starlight.astro.build) for the docs, in `website/` |
| Packaging | `website/` is a standalone package: its own `package.json` and `pnpm-lock.yaml`, not a pnpm workspace member. The app's dependency list in `CLAUDE.md` does not apply to it; justify website dependencies in the PR like any other |
| Language | TypeScript (strict) for scripts and components; Astro components for pages; MDX for docs |
| Fonts | Inter and JetBrains Mono, self-hosted through `@fontsource-variable/*` like the app. No Google Fonts or other third-party requests: the site has no trackers and no analytics, like the app |
| Colors | Imported from the app: `src/theme/graphite.css` (dark) and `src/theme/paper.css` (light), mapped onto the site's and Starlight's variables by one adapter stylesheet. Never copy hex values into `website/` |
| Search | Starlight's built-in Pagefind |
| Hosting | Cloudflare Pages, project `yaggui`. GitHub Actions builds the site and uploads it with `wrangler pages deploy` (Cloudflare's own Git integration is not used: the build needs the full git history for the versioned docs and the app's toolchain for the demo). Custom domain set in the Cloudflare dashboard. Not GitHub Pages |

## Look

The validated mockup is [`docs/ui/website.html`](ui/website.html) (open it in a browser; Graphite / Paper toggle at the top). The landing page reproduces it; the docs use the same skin (see the docs preview at the bottom of the mockup).

- Clean and quiet, in the spirit of t3.codes and rush.be: centered hero, one primary button, large product screenshot, hairline-bordered cards, generous spacing, a single fade on load. No gradients in text, no version badge in the hero, no decorative animation.
- Both themes everywhere; the site follows the OS theme and offers a toggle.
- Screenshots open in a lightbox on click (keyboard accessible, `Esc` closes), wherever enlarging helps: the hero screenshot, feature visuals, docs screenshots.
- The download button detects the visitor's OS and links to the matching asset of the latest release; other platforms are one click away.
- Mobile: no horizontal scroll down to 360px.

## Internationalization

English is the default locale at the root (`/`, `/docs/…`); French lives under `/fr/` (`/fr/`, `/fr/docs/…`). Landing page and docs are both translated. Starlight's i18n handles the docs; the landing page uses the same locale routing and a small string table. Every page exists in both languages; a missing French page falls back to English with Starlight's notice, never a 404.

## Versioned docs

The visitor picks the app version in the docs header; **latest released version** is the default.

- Source of truth: git. The docs of version `X.Y.Z` are the content of `website/src/content/docs/` at the commit that version was released from. No hand-maintained copies of old versions.
- Versions come from git tags: every `vX.Y.Z` tag whose tree contains `website/src/content/docs/` is a docs version, read from that tag. Nothing to do at release time beyond tagging. Before the first tag with docs, `master` is served at `/docs/` and the switcher shows only it.
- `website/versions.json` is an optional override list, empty by default: `{ "version": "0.4.0", "ref": "<sha or tag>" }` serves a version from another ref (or adds one that has no tag), `{ "version": "0.4.0", "hidden": true }` hides one (e.g. a tag cut while the docs were placeholders).
- At build time a script extracts the docs of each version's ref into the build, so that `/docs/` serves the latest version, `/docs/<version>/` the older ones, with the same layout for `/fr/docs/`.
- The docs on `master` (changes not released yet) are published under `/docs/next/`, labelled "Next (unreleased)", never as the default.
- Changing version keeps the visitor on the same page when it exists in the target version, otherwise sends them to that version's docs home.
- W-1 picks the implementation (e.g. the `starlight-versions` plugin fed by the extraction script, or one Starlight build per version behind a shared switcher) and documents the choice in its PR and in `website/README.md`.

## Docs content

The docs explain **yaggui**, not Git. A page about rebasing explains how rebasing works *in yaggui* (where it starts, what the dialog shows, how conflicts and abort behave, what can be undone), and links to the Git documentation for the concept itself.

The content comes from a real analysis of the app, not from the spec alone:

- Features and flows: `src/features/*`, `src/app/*`, the action registry and palette actions, context menus, dialogs, preferences.
- Exact UI wording: `src/i18n/en.json` and `fr.json`. Use the labels the user sees, in both languages.
- Behavior and edge cases: the Rust services (`src-tauri/src/repo`, `git/ops`), the error catalog (`git/errors.rs`), the confirmations, what is and is not undoable.
- Requirements: `docs/SPEC.md` (`F-xxx`) and the validation checklists in `docs/validation/`.

Every docs page carries in its frontmatter:

```yaml
sources:        # code paths this page documents; drives the docs-impact check
  - src/features/staging/**
  - src-tauri/src/repo/write.rs
requirements: [F-060, F-061, F-062]
```

Screenshots come from the mocked frontend through Playwright (extend `pnpm screenshots`), in both themes, committed under `website/src/assets/screens/` like the README ones in `docs/assets/`.

## Live demo

`/demo/` serves a production build of the app's frontend in mock mode, built from the same commit as the site: `pnpm build:demo` (`vite build --mode demo --base /demo/`, flags in `.env.demo`) writes into `website/public/demo/` (git-ignored), and `website`'s `pnpm build` runs it first, so Astro copies it into `dist/`. The placeholder pages are gone; `/fr/demo/` redirects to `/demo/?lang=fr`, which sets the demo's language.

Demo-only behavior lives under `src/demo/` behind `isDemo` (`VITE_DEMO=1`), a build-time constant, so the desktop app is unaffected:

- A thin dismissible banner ("Demo on sample data — nothing leaves your browser", link to download).
- The sample repository opens at startup instead of the welcome screen.
- Network features are off (avatars, update checks): no request leaves the site.
- Commands that need the OS (external editor and terminal, folder picker, clone, reveal, diff tool, updates) answer "Available in the desktop app".
- No heavy perf fixtures: the 100k-commit `linux` repo shrinks to 2k commits, the `many-refs` and `huge-history` paths are inert (and tree-shaken).

`pnpm test:demo` (Playwright, `e2e/demo.spec.ts`) checks the built site: banner, graph, no console error, no external request.

## Keeping the docs current

- `CLAUDE.md` gets a "Documentation" section and a Definition of done item: a user-visible change updates the matching docs pages (EN and FR) in the same PR, or the PR description says `Docs: not needed (<reason>)`.
- A `docs-impact` CI job lists the docs pages whose `sources` were touched by the PR without the page being updated. It is a **warning** (job summary and annotation), never a failure.
- The keyboard shortcut reference is generated from the app's action registry, so it cannot drift.
- A pull request template (`.github/pull_request_template.md`) carries a Docs section.

## CI and deployment

- `ci.yml`: the existing `changes` job also decides whether the app changed. A PR that only touches `website/**` (or `docs/WEBSITE.md`, `docs/ui/website.html`) skips the app jobs; skipped jobs count as passed for required checks. Do not use `paths-ignore` on the whole workflow (required checks would stay pending).
- `website.yml`: on pull requests touching the site or the docs sources, type-check, build (all versions, both locales, demo) and check internal links, then deploy a preview to Cloudflare Pages (`--branch=<pr branch>`) and print its URLs in the job summary and in a comment on the pull request, edited on each push; skipped when the secrets are missing (pull requests from forks). On push to `master`, when a release is published and on `workflow_dispatch`, build and deploy to production (`--branch=master`).
- Deployment uses `cloudflare/wrangler-action` (pinned by SHA) with the repository secrets `CLOUDFLARE_API_TOKEN` (scope: Cloudflare Pages edit) and `CLOUDFLARE_ACCOUNT_ID`. Redirects and headers go in `website/public/_redirects` and `_headers`.
- Release links and the version shown on the landing page are read at build time from the GitHub API (latest release) with a fallback to `package.json`.

## Tasks

| ID | Owns | Depends on |
|---|---|---|
| W-1 | `website/` scaffold (Astro, Starlight, theme adapter, i18n routing, versioning machinery, lightbox component, placeholder pages), `ci.yml` changes, `website.yml`, Cloudflare Pages deploy, ESLint / Prettier / check-case integration, `website/README.md` | — |
| W-2 | Landing page in both locales (`website/src/pages/`, its components and strings) | W-1 |
| W-3 | App analysis, docs information architecture and the English docs content (`website/src/content/docs/en/` or the root locale), docs screenshots | — (rebases on W-1) |
| W-4 | `CLAUDE.md` docs rules, PR template, `docs-impact` job, generated shortcut reference | W-1 |
| W-5 | Live demo build and integration under `/demo/` | W-1 |
| W-6 | French docs (`website/src/content/docs/fr/`) | W-3 |
