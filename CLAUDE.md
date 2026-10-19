# yaggui

Local, cross-platform (Windows, macOS, Linux) graphical Git client in the spirit of GitKraken: ergonomics and performance first.

Sources of truth, to read before touching the code:

- `docs/SPEC.md`: requirements (IDs `F-xxx`, `P-xx`), architecture, UX principles.
- `docs/PLAN.md`: breakdown into tasks, dependencies, acceptance criteria. Each task maps to one PR.
- `docs/ui/styles.html`: reference mockups. Chosen styles: **A · Graphite** (dark) and **B · Paper** (light). The CSS tokens of this file are the base of the app's themes.

When this file and the spec disagree, this file wins for conventions and the spec wins for functional behavior.

## Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Frontend | React 19, strict TypeScript, Vite, pnpm |
| State | Zustand (UI state), TanStack Query (repo data) |
| UI | CSS Modules + CSS variables (tokens), Radix UI for primitives |
| Diff / merge | CodeMirror 6 (`@codemirror/merge`) |
| Lists | TanStack Virtual; graph drawn on a 2D canvas |
| Backend | Stable Rust (2024 edition), `gix` for reads, `git` binary for writes |
| Bindings | `tauri-specta`: TS types and commands **generated** from Rust, never written by hand |
| Persistence | SQLite (`rusqlite`) in the OS config folder |
| Tests | Vitest + Testing Library, Playwright (front on a mocked backend), `cargo test` |

Do not add a dependency outside this list without justifying it in the PR description (size, maintenance, alternative ruled out).

## Layout

```
src/                      Frontend
  app/                    Shell: window, tabs, layout, view routing
  features/<feature>/     One feature = components + hooks + styles + tests (graph, staging, diff, sidebar, palette, toolbar, welcome…)
  ipc/                    Backend access: generated bindings + Tauri client + mock client
  ui/                     Reusable primitives (Button, Menu, Dialog, Toast…)
  theme/                  tokens.css, graphite.css, paper.css
  i18n/                   fr.json, en.json
src-tauri/
  src/
    commands/             Tauri handlers: thin, no logic (validation → service call → error mapping)
    git/                  cli.rs (spawns git), read/ (gix), ops/ (writes), errors.rs (catalog)
    repo/                 RepoManager, RepoSession, OpQueue, Watcher
    graph/                Lane layout, pagination
    store/                SQLite: repos, tabs, preferences
    system/               OS integration outside Git (terminal)
  tests/                  Integration tests + fixture repo generation scripts
docs/
```

## Commands

These scripts were created by task M0-1; keep them up to date if you change them.

```bash
mise install        # Node, pnpm and Rust at the versions of mise.toml (optional)
pnpm dev            # Frontend alone in the browser, mocked backend (VITE_MOCK=1), port 1430
pnpm tauri dev      # Full app (Vite on port 1420)
pnpm check          # file name casing + lint (ESLint) + format (Prettier) + typecheck + Vitest — must pass before any PR
pnpm test:ui        # Playwright on `pnpm dev` (mocked backend), captures in test-results/; primitives page at /#primitives
pnpm screenshots    # README screenshots (docs/assets/*.png) on the mocked backend
pnpm bindings       # Regenerates src/ipc/bindings.ts from Rust
pnpm release:version <x.y.z>  # Sets the app version in package.json, tauri.conf.json, Cargo.toml and Cargo.lock (see docs/RELEASING.md)
pnpm perf:tabs      # P-07 on a production build of the front (mock), CPU ×1 and ×4, + JS memory with 5 tabs
pnpm perf:graph     # P-04: scrolling the linux 100k graph (mock, production build), CPU ×1 and ×4
pnpm perf:diff      # P-06 on a production build of the front (mock); backend: cd src-tauri && cargo test --release --test diff p06 -- --ignored --nocapture
pnpm perf:palette   # P-08: palette over 10k refs (many-refs mock, production build), CPU ×1 and ×4
pnpm perf:blame     # M4-4: blame of a 20k-line file (mock, production build), opening and scrolling, CPU ×1 and ×4
YAGGUI_BENCH_REPO=<worktree> YAGGUI_BENCH_FILES=a.c,b.c cargo test --release --test inspect inspect_bench -- --ignored --nocapture  # M4-4: blame and file history through yaggui (from src-tauri/)
pnpm perf:status    # P-05, front part: status-changed → changes panel repainted (mock, production build)
cd src-tauri && cargo test --release --test status p05 -- --ignored --nocapture  # P-05, backend part: disk change → status-changed → status read again, on the `wide` fixture (50k files); YAGGUI_BENCH_REPO=<worktree> for another repo
scripts/bench-graph.sh <folder>  # P-02/P-03: graph on git/git and a synthetic 1.3M-commit repo, with and without commit-graph
YAGGUI_BENCH_REPO=<repo> cargo test --release --test watcher watch_bench -- --ignored --nocapture  # watcher: number of watches and opening time (from src-tauri/)
pnpm perf:startup   # P-01 on the release binary (`pnpm tauri build --no-bundle` first; on headless Linux: xvfb-run -a)
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
xvfb-run pnpm tauri dev   # Run the real app in a headless container
pnpm tauri build --debug --no-bundle   # Built front + CSP with nonces (absent under `tauri dev`): check every new screen with this binary. A lib that injects <style> must receive the page nonce.
```

## Architecture rules (non-negotiable)

1. **Every Git write goes through `git/cli.rs`** via `OpQueue` (serialized per repo). Never `git2`/`gix` for writes, never `Command::new("git")` anywhere else.
2. **Separate arguments, never a shell.** `Command` with `.arg()`; `--` before paths; ref names validated with `git check-ref-format`.
3. **Controlled Git environment**: `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` when parsing output, `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` never interactive.
4. **Every Git command that runs is recorded** in the log (command, duration, exit code, stdout/stderr).
5. **Typed errors**: Rust errors are a serialized enum (`code`, FR/EN `message`, suggested `action`), never a raw `String` sent to the front. Known Git errors go through the catalog in `git/errors.rs`.
6. **The UI never blocks**: any potentially long command is asynchronous, with progress through Tauri events and cancellation when it makes sense.
7. **Compact payloads**: the graph and long lists are paginated (pages of 500), as flat structures.
8. **The front only talks to the backend through `src/ipc`**. No direct `invoke` in components. The mock client must implement every command, so that `pnpm dev` and `pnpm test:ui` work without Tauri.
9. **Destructive operations**: a confirmation showing the concrete effect, `--force-with-lease` only, and an undo entry as soon as undo exists.

## Code conventions

- **Language**: code, identifiers, comments, commit messages and docs in English. UI text always goes through i18n, with FR and EN provided together.
- **TypeScript**: `strict`, no `any` (nor `as any`), no unjustified `!`. Function components, one component per file, `PascalCase.tsx` naming, hooks as `useXxx.ts`.
- **File names**: never two files in the same folder that differ only by case (e.g. `Avatar.tsx` and `avatar.ts`). macOS and Windows do not tell them apart, and `./Avatar` resolves to the wrong module there. `pnpm check` enforces it (`scripts/check-case.mjs`).
- **Styles**: no hard-coded color, size or radius in a component; only the tokens of `src/theme/tokens.css`. Both themes must stay correct in every PR.
- **Rust**: `thiserror` for errors, no `unwrap()`/`expect()` outside tests and documented invariants, `tracing` for logs. Clippy without warnings.
- **Comments**: only for the non-obvious *why*.
- **Performance**: virtualize any list that can exceed ~200 items; no global re-render on a watcher event (targeted TanStack Query invalidation); measure before optimizing, and give the measurements in the PR when the task touches a `P-xx` target.

## Tests

- Every Git write operation has a Rust integration test on a temporary fixture repo that checks the resulting Git state.
- Fixtures are generated by script (`src-tauri/tests/fixtures/`), never committed as a binary `.git`.
- Non-trivial front logic (stores, layout, parsing): Vitest tests. Screens: at least one Playwright capture per new screen or visual state, in both themes.

## Documentation

The user documentation is the site's `/docs/`: `website/src/content/docs/en/` and `fr/` (same relative paths), navigation in `website/src/content/docs/sidebar.json`, brief in `docs/WEBSITE.md`. The docs of a version are the content of that folder at the commit the version was released from, so a PR that changes behavior must change the docs in the same PR.

A change needs docs when it alters something a user sees or does: behavior of a feature or flow, UI wording (`src/i18n`), shortcuts, preferences, error messages and their suggested actions, confirmations and what is undoable, the install or update flow. Pure refactors, tests, perf work without visible effect and internal tooling do not.

- **EN and FR together.** Update both pages in the same PR, with the labels the user sees in each language (copy them from `src/i18n/en.json` / `fr.json`). Never leave one language behind.
- **Find the pages concerned.** Every page lists the code it documents in its frontmatter `sources` (globs) and the `requirements` it covers (`F-xxx`). `pnpm docs:impact [--base origin/master]` matches your diff against them and lists the pages whose sources changed without the page, pages updated in one language only, and user-facing files no page covers. The `Docs impact` workflow runs the same report on every PR as a warning (never a failure); `Docs: not needed (<reason>)` in the PR description silences it.
- **Add a page.** Create it in `en/` and `fr/` with the same path; frontmatter `title`, `description`, `sources` (every code path it documents, so the check keeps it fresh) and `requirements`; add it to `sidebar.json` (with the FR label in `translations`); screenshots from the mocked frontend through Playwright (`pnpm screenshots`), in both themes, with the `Screenshot` component, under `website/src/assets/screens/`.
- **Describe what the code does**, not what the spec intended: read the code, the i18n labels and the error catalog; if they disagree with the docs, the docs change. Explain yaggui, not Git.
- **Keyboard shortcuts are generated.** `website/src/content/docs/_data/shortcuts.json` comes from the action registry and the default keybindings. After adding or changing an action, a default shortcut or its label, run `pnpm docs:shortcuts` and commit the file; `pnpm check` fails when it is stale. Never edit it by hand.
- Check the docs with `cd website && pnpm check && pnpm build`.

## Agent workflow

- One task of `docs/PLAN.md` = one branch = one PR to `master`. Branch: `yaggui/<task-id>-<slug>` (e.g. `yaggui/m0-1-scaffold`), unless a branch is imposed.
- Commits follow Conventional Commits (`feat(graph): …`, `fix(ipc): …`).
- **Do not merge yourself** and never push to `master`.
- Stay within the task's scope. If something else is needed, note it in the PR ("Out of scope / follow-ups" section) instead of doing it.
- If a decision is covered neither by this file nor by the spec, take the simplest option that respects the rules above and document it in the PR.
- Screenshots go to `test-results/` and are attached to the PR; they are not committed. Pause notes go in the PR description or in an uncommitted `docs/progress/`.

### Definition of done

1. The task's acceptance criteria are met.
2. `pnpm check`, `cargo clippy -- -D warnings` and `cargo test` pass. The `CI` workflow (`.github/workflows/ci.yml`) runs them, plus `pnpm test:ui` and `cargo fmt --check`, on every PR, with the Rust part on Linux, macOS and Windows.
3. The app starts (`xvfb-run pnpm tauri dev`, or at least `cargo build` + `pnpm build`) and new screens are checked with Playwright captures in both themes.
4. PR opened with: summary, covered requirements (`F-xxx`), how to test, captures, points to check manually on macOS/Windows, docs, out of scope. `.github/pull_request_template.md` has the sections.
5. Docs updated in the same PR (EN and FR), or the PR description contains `Docs: not needed (<reason>)`.
6. `docs/PLAN.md` updated (task status).
