# yaggui website

The public site at <https://yaggui.tropico.dev>: landing page (`/`), documentation (`/docs/`) and live demo (`/demo/`, the app's frontend on a mocked backend), in English (root) and French (`/fr/`). Brief: [`docs/WEBSITE.md`](../docs/WEBSITE.md); mockup: [`docs/ui/website.html`](../docs/ui/website.html).

[Astro](https://astro.build) with [Starlight](https://starlight.astro.build) for the docs. A standalone package, not a workspace member of the app: its own `package.json`, lockfile and checks.

```bash
cd website
pnpm install
pnpm dev       # http://localhost:4321
pnpm build     # dist/: every docs version, both locales, then the internal link check
pnpm preview   # serves dist/
pnpm check     # astro check (strict TypeScript, content schema) + Prettier
```

`.github/workflows/website.yml` runs `pnpm check` and `pnpm build` on pull requests that touch the site, and deploys `dist/` to Cloudflare Pages: a preview per pull request, production from `master`.

## Layout

| Path                                           | What                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/content/docs/en/`, `src/content/docs/fr/` | Docs pages (MDX), same relative path in both locales                                                                    |
| `src/content/docs/sidebar.json`                | Docs sidebar, versioned with the pages                                                                                  |
| `src/assets/screens/`                          | Docs screenshots, `<name>-dark.png` (Graphite) and `<name>-light.png` (Paper)                                           |
| `src/pages/`                                   | Landing (`index.astro`, `fr/index.astro`)                                                                               |
| `src/components/`                              | `Screenshot`, `DownloadButton`, site navigation and footer; `starlight/`: Starlight overrides (title, version switcher) |
| `src/styles/theme.css`                         | Theme adapter: every color of the site comes from the app's `src/theme/graphite.css` and `paper.css` through it         |
| `src/i18n/ui.ts`                               | Strings of the site outside the docs content, EN and FR                                                                 |
| `src/lib/`                                     | Docs versions, latest release lookup                                                                                    |
| `public/demo/`                                 | Built by `pnpm build:demo` (git-ignored): the live demo, see `docs/WEBSITE.md`                                          |
| `versions.json`                                | Optional overrides of the docs versions found in git tags                                                               |
| `scripts/`                                     | Version extraction, link check                                                                                          |
| `public/_headers`                              | Cloudflare Pages headers (cache of `/_astro/`)                                                                          |

## Docs pages

A page is `src/content/docs/<locale>/<path>.mdx`; its URL is the path without extension (`index` is the folder's home): `en/guides/staging.mdx` → `/docs/guides/staging/`, `fr/guides/staging.mdx` → `/fr/docs/guides/staging/`. A page missing in French falls back to the English one with Starlight's notice. The `slug` frontmatter is not supported (the versioning owns the ids). Files starting with `_` are ignored.

Frontmatter: Starlight's fields, plus two required ones:

```yaml
---
title: Staging and committing
description: Stage files, hunks or lines, then commit.
sources: # repository-relative globs of the code the page documents ([] if none)
  - src/features/staging/**
  - src-tauri/src/repo/write.rs
requirements: [F-060, F-061] # docs/SPEC.md ids ([] if none)
---
```

The sidebar is `src/content/docs/sidebar.json`, in Starlight's sidebar format with slugs relative to the docs root and group labels translated through `translations`:

```json
[
  {
    "label": "Everyday Git",
    "translations": { "fr": "Git au quotidien" },
    "items": ["guides/staging", "guides/branches"]
  }
]
```

`autogenerate` is not supported: Starlight generates from file paths, which differ between versions.

### Screenshots

```mdx
import Screenshot from '~/components/Screenshot.astro';
import stagingDark from '../../../assets/screens/staging-dark.png';
import stagingLight from '../../../assets/screens/staging-light.png';

<Screenshot dark={stagingDark} light={stagingLight} alt="Line staging in the unified diff" />
```

The component shows the image of the current theme and opens it in a lightbox on click, `Enter` or `Space` (`Esc`, a click or the close button closes it). Props: `dark`, `light`, `alt` (also the lightbox caption), optional `caption`, `width`, `frame` (default `true`), `eager`. Import the images relatively: each docs version is extracted with its own images. Import the component through `~/`: old versions then use the current component, so keep its props backward compatible.

## Versioned docs

The visitor picks the version in the docs header; the latest release is the default.

- Versions come from git tags: every `vX.Y.Z` tag whose tree has `website/src/content/docs/` is a docs version, read from the tag (`src/lib/docs-versions.ts`). Releasing needs nothing else.
- `versions.json` holds optional overrides, empty by default: `{ "version": "0.5.0", "ref": "<sha or vX.Y.Z>" }` serves a version from another ref (or adds an untagged one), `{ "version": "0.5.0", "hidden": true }` hides one, e.g. a tag cut while the docs were still placeholders.
- At config time (`astro dev`, `build`, `check`), `scripts/versions.ts` extracts `website/src/content/docs/`, `website/src/assets/` and `docs/assets/` of each version's ref with `git archive` into `.cache/versions/<version>/` (gitignored, re-extracted when the ref points to another commit). This needs the tags and the full history: `fetch-depth: 0` in CI; a shallow clone or one without tags builds `master` only.
- One content collection holds every version, under ids that encode locale and version (`src/content.config.ts`). URLs: latest release at `/docs/…`, `master` at `/docs/next/…` (labelled "Next (unreleased)"), older releases at `/docs/<version>/…`; the same under `/fr/docs/`.
- `src/route-middleware.ts` gives each page the sidebar and previous / next links of its own version, keeps the search index to the default version, and points "Edit page" at the file on `master` when it still exists there.
- The switcher (`src/components/starlight/VersionSelect.astro`) links each version to the same page when it exists there, otherwise to that version's docs home.
- **Bootstrap**: until a tag has the docs, `master` is served at `/docs/` and the switcher shows only it.
- **Search** covers the default version only (known limitation): results never send a visitor to another version, and older versions and `next` are not searchable.

### Why not `starlight-versions`

The [`starlight-versions`](https://github.com/HiDeoo/starlight-versions) plugin was evaluated and not used:

- It treats the working tree as the current version, served at the root, and archives older versions as copies committed under `src/content/docs/<version>/`. Here git is the source of truth (no copies of old docs in the tree), the default is the latest release, and `master` must sit at `/docs/next/`, never as the default.
- Feeding it from git would mean generating its archive format (rewritten links, per-version sidebar JSON) from an extraction script, coupled to the internals of a plugin its author describes as early development.
- One Starlight build per version behind a shared switcher was also ruled out: Starlight puts locales under the base path (`/docs/0.3.0/fr/…`, not `/fr/docs/0.3.0/…`), each build repeats the whole site, and the outputs would need merging.

The custom approach is about 400 lines, comments included (`src/lib/docs-versions.ts`, `scripts/versions.ts`, the middleware and the switcher) on public Starlight APIs: a content loader, route data middleware and a component override.

## Theme

`src/styles/theme.css` imports the app's `tokens.css`, `graphite.css` and `paper.css`; a PostCSS rule in `astro.config.ts` rewrites their selectors (`:root[data-theme='graphite']` → `:root`, `paper` → `[data-theme='light']`) to match Starlight's. The adapter maps the app variables onto the site's (`--bg`, `--fg2`, `--line`…) and Starlight's (`--sl-color-*`). Never write a color value in `website/`: map an app variable. The site follows the OS theme; the toggle (landing) and Starlight's theme select (docs) share the `starlight-theme` key of `localStorage`.

## Download button

`DownloadButton` reads the latest release from the GitHub API at build time (`src/lib/release.ts`, `GITHUB_TOKEN` raises the rate limit), with a fallback to the version of the app's `package.json` and the asset names of `docs/RELEASING.md`. In the browser, it picks the asset for the visitor's OS (macOS: Apple Silicon `.dmg`, Windows: `-setup.exe`, Linux: AppImage); unknown systems and phones get the release page.

## Deployment

Cloudflare Pages, project `yaggui`, uploaded by `website.yml` with `cloudflare/wrangler-action` and the `wrangler` of this package (`pages deploy dist --project-name=yaggui --branch=<branch>`). Cloudflare's Git integration is not used: the build needs the full git history for the versioned docs.

- Pull requests: a preview deployment on the branch alias (`<branch>.yaggui.pages.dev`), its URLs in the job summary and in a comment on the pull request (edited on each push). Skipped, with the build still run, when the secrets are missing (pull requests from forks).
- Production (`--branch=master`): on push to `master`, on `workflow_dispatch`, and when a release is published (built from `master`, so the download links follow the release).
- Headers in `public/_headers`; redirects, if ever needed, in `public/_redirects`.

One-time setup: create the Cloudflare Pages project `yaggui` (Direct Upload, production branch `master`); add the repository secrets `CLOUDFLARE_API_TOKEN` (permission: Cloudflare Pages, Edit) and `CLOUDFLARE_ACCOUNT_ID`; attach the custom domain `yaggui.tropico.dev` to the project in the Cloudflare dashboard.

## Dependencies

| Package                                                             | Why                                                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `astro`, `@astrojs/starlight`                                       | Site generator and docs theme, chosen in the brief (Starlight brings MDX, Pagefind search, Expressive Code)                      |
| `sharp`                                                             | Image optimization of `astro:assets` (screenshots to WebP)                                                                       |
| `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` | Self-hosted fonts, same as the app                                                                                               |
| `@astrojs/check`, `typescript`                                      | `astro check`                                                                                                                    |
| `prettier`, `prettier-plugin-astro`                                 | Formatting, `.astro` included                                                                                                    |
| `@types/node`                                                       | Types of the build scripts                                                                                                       |
| `wrangler`                                                          | Upload to Cloudflare Pages from CI (`cloudflare/wrangler-action` uses it); only its CLI is used, its build scripts stay disabled |

No ESLint: `astro check` in strict mode covers the TypeScript, and the site has little logic.
