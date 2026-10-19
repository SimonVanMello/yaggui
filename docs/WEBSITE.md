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
| Hosting | GitHub Pages, deployed by GitHub Actions; custom domain through `website/public/CNAME` |

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
- `website/versions.json` lists the published versions and the git ref of each one (`{ "version": "0.4.0", "ref": "<sha or tag>" }`). The release workflow appends the new version when a release is published. The first entry points at the commit that merges the first complete docs, labelled with the app version current at that time.
- At build time a script extracts the docs of each listed ref into the build, so that `/docs/` serves the latest version, `/docs/<version>/` the older ones, with the same layout for `/fr/docs/`.
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

`/demo/` serves a production build of the app's frontend in mock mode (`VITE_MOCK=1`), built by the website workflow from the same commit. A thin banner says it is a demo on sample data, with a link back to the download. No backend, no network calls beyond the site itself. Heavy perf fixtures (100k-commit graphs, 10k refs) stay out of the demo bundle.

## Keeping the docs current

- `CLAUDE.md` gets a "Documentation" section and a Definition of done item: a user-visible change updates the matching docs pages (EN and FR) in the same PR, or the PR description says `Docs: not needed (<reason>)`.
- A `docs-impact` CI job lists the docs pages whose `sources` were touched by the PR without the page being updated. It is a **warning** (job summary and annotation), never a failure.
- The keyboard shortcut reference is generated from the app's action registry, so it cannot drift.
- A pull request template (`.github/pull_request_template.md`) carries a Docs section.

## CI and deployment

- `ci.yml`: the existing `changes` job also decides whether the app changed. A PR that only touches `website/**` (or `docs/WEBSITE.md`, `docs/ui/website.html`) skips the app jobs; skipped jobs count as passed for required checks. Do not use `paths-ignore` on the whole workflow (required checks would stay pending).
- `website.yml`: on pull requests touching the site or the docs sources, type-check, build (all versions, both locales, demo) and check internal links. On push to `master` and when a release is published, build and deploy to GitHub Pages. `workflow_dispatch` for manual redeploys.
- Release links and the version shown on the landing page are read at build time from the GitHub API (latest release) with a fallback to `package.json`.
- M6-3 (apt and dnf repositories) also plans to use this repository's GitHub Pages. The deploy job must keep that possible: the site is the root of the Pages artifact and leaves `/apt/` and `/rpm/` free for M6-3 to add.

## Tasks

| ID | Owns | Depends on |
|---|---|---|
| W-1 | `website/` scaffold (Astro, Starlight, theme adapter, i18n routing, versioning machinery, lightbox component, placeholder pages), `ci.yml` changes, `website.yml`, Pages deploy, ESLint / Prettier / check-case integration, `website/README.md` | — |
| W-2 | Landing page in both locales (`website/src/pages/`, its components and strings) | W-1 |
| W-3 | App analysis, docs information architecture and the English docs content (`website/src/content/docs/en/` or the root locale), docs screenshots | — (rebases on W-1) |
| W-4 | `CLAUDE.md` docs rules, PR template, `docs-impact` job, generated shortcut reference | W-1 |
| W-5 | Live demo build and integration under `/demo/` | W-1 |
| W-6 | French docs (`website/src/content/docs/fr/`) | W-3 |
