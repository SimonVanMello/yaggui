# yaggui — Implementation plan

Each task = one PR to `master`. Statuses: ⬜ to do · 🟦 in progress · 🟨 PR open · ✅ merged.
A milestone ends with a **manual validation** by the product owner (PO) on macOS and Windows before the next one starts.

Milestones M2 to M4 will be broken down in detail at the end of the previous milestone, once the base code is known.

---

## M0 — Foundations

Exit: the app opens on all 3 OSes, repos open in tabs, the current branch and the command log are visible. The Graphite and Paper themes are in place.

### M0-1 · Project skeleton ✅
Depends on: —
- Tauri 2 + React 19 + Vite + strict TS + pnpm. App identifier `dev.tropico.yaggui`, display name "yaggui".
- ESLint, Prettier, Vitest, Playwright; scripts `dev`, `build`, `check`, `test:ui`, `bindings` (see `CLAUDE.md`).
- `tauri-specta` wired, with a sample command (`app_info`: app version + detected `git` version) and its TS generation.
- `src/ipc`: Tauri client + mock client selected by `VITE_MOCK=1`.
- Themes: `tokens.css`, `graphite.css`, `paper.css` taken from `docs/ui/styles.html`; light/dark/system toggle; Inter and JetBrains Mono fonts bundled (no Google Fonts at runtime).
- Minimal FR/EN i18n (light library or in-house, to be justified).
- Base `ui/` primitives: Button, IconButton, Kbd, Tooltip, Menu, Dialog, Toast.
- Folder structure as in `CLAUDE.md`, even if empty.

Acceptance: `pnpm check`, `cargo clippy`, `cargo test` pass; `xvfb-run pnpm tauri dev` shows a window; `pnpm test:ui` captures a demo page of the primitives in both themes.

### M0-2 · Backend core ✅
Depends on: M0-1
- `git/cli.rs`: binary and version detection (warning below 2.30), execution with a controlled env, capture, cancellation, parsing of `--progress` output.
- Command log (in memory, bounded) + `command-logged` event.
- `repo/`: `RepoManager`, `RepoSession` (opening through `gix`, detection of invalid repos / `safe.directory`), `OpQueue` serialized per repo, `op-progress` / `op-finished` events.
- `Watcher` (`notify`, 150 ms debounce) on the worktree and `.git/{HEAD,refs,index,*_HEAD}` → `status-changed` / `refs-changed` events, ignoring the internal noise of `.git`.
- Base reads: current branch / detached HEAD, upstream + ahead/behind, dirty state (number of files), operation in progress (merge/rebase/cherry-pick/revert).
- `git/errors.rs`: typed error enum + first catalog entries (repo not found, not a repo, `safe.directory`, `index.lock`, git missing).
- `store/`: SQLite (recent repos, favorites, open tabs and their order, preferences), versioned migrations.

Acceptance: integration tests on fixture repos (clean, dirty, detached HEAD, rebase in progress, orphan lock); every command exposed in the bindings and implemented in the mock.

### M0-3 · UI shell ✅
Depends on: M0-1 (IPC contract; can be built on the mock in parallel with M0-2)
- Title bar with tabs (F-004): reorderable by drag, closing, `⌘T`/`⌘W`/`⌘1…9`/`⌃Tab`, indicators (dirty, operation in progress), restored on restart. Native window buttons per OS.
- Welcome screen / new tab (F-005): recents, favorites, fuzzy search, Open (picker + folder drag & drop); Clone and Init as disabled "coming soon" buttons.
- Repo layout: sidebar / center / right panel, resizable and collapsible, sizes remembered per tab. Empty contents with placeholder states.
- Toolbar (buttons disabled except Terminal) + read-only branch selector showing branch, upstream, ahead/behind.
- Status bar + command log panel (F-300).
- Toasts (F-301) and display of typed errors with a suggested action.
- CLI argument `yaggui <path>` (F-001).

Acceptance: Playwright captures (welcome, open repo, 3 tabs, log open) in both themes; a real repo opened under `xvfb-run`.

### M0-4 · Milestone integration and verification ✅
Depends on: M0-2, M0-3
- Connect the shell to the real backend, fix mock / real gaps.
- Check P-01 (startup) and P-07 (tab switch); document the measurements.
- Write `docs/validation/M0.md`: manual validation checklist for macOS/Windows.

---

## M1 — Reading

Exit: the history of a very large repo can be browsed smoothly, refs, details and the diff of any commit are visible, and the ⌘K palette works.

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| M1-1 ✅ | Graph backend: paginated history read through `gix` (commit-graph), incremental lane computation, stable colors per branch, refs per commit, stashes | M0 | F-020, F-023, F-031, P-02, P-03 |
| M1-2 ✅ | Graph front: virtualized canvas + DOM columns, WIP node, ref labels, selection, context menu (actions disabled until M2), search/filter | M1-1 (mock first) | F-021, F-022, F-024 (UI), F-027, P-04 |
| M1-3 ✅ | Refs sidebar: local / remote / tags / stashes / submodules / worktrees, tree by prefix, ahead/behind, filter, click → graph scroll | M1-1 | F-040 to F-045 (read) |
| M1-4 ✅ | Commit detail + diff: diff backend (renames, binary, size guards), unified / side-by-side CodeMirror view, intra-line highlighting, hunk/file navigation | M0 | F-080 to F-084, F-088, P-06 |
| M1-5 ✅ | ⌘K palette: action registry with stable IDs, fuzzy search over actions / branches / commits / files / tabs | M1-1, M1-3 | F-280, P-08 |
| M1-6 ✅ | Integration, perf measurements on `git/git` and `torvalds/linux`, checklist `docs/validation/M1.md` | all of M1 | P-02 to P-04 |

M1-1 and M1-4 can start in parallel; M1-2 and M1-3 start on the mock as soon as the IPC contract of M1-1 is frozen.

---

## M2 — Daily writing (= MVP)

Exit: all routine work is done without a terminal: staging (file, hunk, line), committing, switching branches, managing branches / stashes / tags, syncing with the remote, cloning and initializing. Every write goes through `cli.rs` + `OpQueue`, with translated errors and suggested actions.

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| M2-1 ✅ | Write foundation backend + staging + commit: operation conventions (events, cancellation by process group, log), extended error catalog; stage/unstage file, hunk and line (`git apply --cached` with a freshness check by blob id), discard file/hunk/line with a prior backup (for the M4 undo), commit / amend, hooks with full output | M1 | F-061 to F-065 (back), F-302 |
| M2-2 ✅ | Staging + commit front: interactive right panel (hover buttons, `Space`, drag between lists, stage all), hunk and line actions in the diff, discard with confirmation, commit area (72 counter, description, `⌘↵`, amend, push after commit), readable hook failure | M2-1 (contract) | F-060 to F-065 (front) |
| M2-3 ✅ | Branches, checkout, stash, tags backend: checkout (dirty tree: stash-checkout-pop or carry over), local branch tracking a remote one, create / rename / delete (+ remote), upstream, stash push (untracked, keep-index) / apply / pop / drop / rename / branch from a stash, lightweight and annotated tags | M2-1 | F-024, F-045, F-100 to F-103, F-180 to F-184, F-200 (back) |
| M2-4 ✅ | Branches, stash, tags front: double-click checkout, dirty-tree dialog, create (live name validation) / rename / delete dialogs, sidebar and graph context menus enabled, branch selector (F-106), stash `⌘⇧S` + options, stash preview and actions, tag creation, palette actions wired | M2-3 (contract) | same as M2-3 (front), F-106 |
| M2-5 ✅ | Network: fetch (one / all, prune) and auto-fetch, pull (ff-only / merge / rebase, default read from the config), push (upstream on first push), force-with-lease confirmed and refused on protected branches, parsed and cancellable progress, translated network and auth errors | M2-1 | F-120 to F-123, F-126, F-127 |
| M2-6 ✅ | Clone / init + preferences: clone (HTTPS/SSH, folder, branch, shallow, submodules, progress, cancellation), init (default branch, `.gitignore`, README), preferences screen (theme, density, fonts, Git path, auto-fetch, prune, pull strategy, protected branches, confirmations) | M2-1 | F-002, F-003, F-320, F-322, F-324 |
| M2-7a ✅ | Debt and polish independent of the network: P-05 (status on 50k files), diff options (F-082: wrapping, whitespace, context, whole file), Windows points (autocrlf, fileMode, long paths, `index.lock` after cancellation), open points of M2-1 to M2-4 (bounded hook output, hunk discard freshness, `op-finished` on failure, keyboard line selection, checks on the real backend for branches / tags / upstream / stash) | M2-1 to M2-4 | P-05, F-082 |
| M2-7b ✅ | Integration and validation: mock / real gaps for network, clone and preferences, `docs/validation/M2.md` | all of M2 | — |
| M2-7c ✅ | End-of-M2 fixes: Playwright e2e made obsolete by the network work (`addOfflineRemote` error trigger in the mock), faster Vitest test of the 100k graph, git started without a controlling terminal (ssh no longer hangs on a passphrase) | M2-5 | — |

Order: M2-1 first; M2-2 starts on the mock as soon as its IPC contract is pushed. Then M2-3 ∥ M2-4, then M2-5 ∥ M2-6 ∥ M2-7a, then M2-7b.

F-266 (terminal) was already delivered by M0-4.

## M3 — Advanced operations

Exit: merge, rebase (simple and interactive), cherry-pick, revert and reset from the graph, with the mouse (drag & drop) as with the keyboard; an interrupted operation is always visible and finishes or aborts in one click; conflicts are resolved in the app.

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| M3-1 ✅ | History operations backend: merge (ff when possible / merge commit / squash), rebase onto a branch, cherry-pick of one or more commits, revert (parent choice for a merge), soft/mixed/hard reset with a preview of lost files, detection of the operation in progress from `.git` (merge, rebase, cherry-pick, revert, bisect) with progress, continue / skip / abort; conflicts: typed list (content, delete/modify, binary), ours/theirs, mark resolved, content of the three versions for the editor | M2-1 | F-140, F-141, F-143 to F-146, F-160, F-161, F-165 (back) |
| M3-2 ✅ | Operations front: full commit context menu (F-025), drag & drop branch onto branch (merge / rebase / fast-forward) and commit onto branch (cherry-pick), multiple selection in the graph, confirmation dialogs (reset with lost files, revert of a merge), operation-in-progress banner, conflict list with ours/theirs in the right panel, palette actions | M3-1 (contract) | F-025, F-026, F-140 to F-146, F-160, F-161 (front) |
| M3-3 ✅ | 3-way merge editor: ours / theirs panels with per-block checkboxes, editable result, conflict navigation and counter, labels with branch names (during a rebase too), external tool (`merge.tool`), explicit choice for delete/modify and binaries | M3-1 (contract) | F-162 to F-165 |
| M3-4 ✅ | Visual interactive rebase: backend (todo written by yaggui, non-interactive editors, reword / squash with provided messages, stop on `edit`), front (list reorderable by drag and keyboard, `p r s f d e`, result preview, messages edited inline) | M3-1 | F-142 |
| M3-5 ✅ | Integration and validation: mock / real gaps, end-to-end conflict scenarios, `docs/validation/M3.md` | all of M3 | — |

Order: M3-1 starts during the end of M2; M3-2 ∥ M3-3 as soon as its contract is pushed, M3-4 when M3-1 is merged, then M3-5.

## M4 — Comfort (= V1) · awaiting PO validation

Exit: every V1 requirement of the spec is delivered; a local operation is undone with `⌘Z`; several repos are managed per workspace; the history of a file, of a line (blame) and the reflog can be traced; submodules, worktrees and LFS are handled; preferences, shortcuts and Git config are edited in the app.

Each task starts by checking what the previous milestones already delivered of its requirements, and does not redo what exists.

**Milestone status**: every task is delivered; the milestone awaits the PO's manual validation on macOS and Windows ([`docs/validation/M4.md`](validation/M4.md), which also covers M2 and M3). V1 requirements: 43 delivered, 2 partial (F-033, F-066), see [`docs/validation/V1-audit.md`](validation/V1-audit.md).

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| M4-1 ✅ | Undo / redo backend: `OpJournal` (touched refs, index, discarded blobs through `hash-object -w`) wired to every existing write, undo / redo by state restoration, non-undoable operations flagged, session history; contract pushed first | M3 | F-240 to F-243 (back) |
| M4-2 ✅ | Undo / redo front: `⌘Z` / `⌘⇧Z` outside text fields, toolbar button (grayed + tooltip for push / fetch), dropdown of the timestamped history, "Undone: …" toasts | M4-1 (contract) | F-240 to F-243 (front) |
| M4-3 ✅ | Workspaces: named groups of repos, opening in tabs, scan of a parent folder (depth), overview (branch, ahead / behind, dirty, last fetch, Fetch all), moved / deleted repo (relocate or remove) | M3 | F-006 to F-009 |
| M4-4 ✅ | File history, blame, reflog: `--follow` history with a diff per commit, blame colored by age (click → commit in the graph, blame of the parent), HEAD and per-branch reflog with restoration (branch / reset) | M3 | F-220 to F-222 |
| M4-5 ✅ | Submodules, worktrees, LFS: submodule state (expected / current, dirty), init / update, opening in a tab; worktrees list / create / open / remove; LFS detection, badge, `lfs pull` / `track`, no text diff on pointers | M3 | F-260 to F-262 |
| M4-6 ✅ | Full preferences: rebindable shortcuts (`keybindings.json` + editor), `⌘/` shortcut sheet, language, external editor / terminal / diff and merge tools, global and local Git config editor (common keys + raw editing), high-contrast theme and D · Terminal theme | M3 | F-281, F-283, F-320 (high contrast), F-321, F-323, F-325 |
| M4-7a ✅ | V1 commit and stash: signing (GPG / SSH per the config, signed / verified badge), message templates and Conventional Commits help, recent messages, add to `.gitignore`, identity profiles, partial stash | M3 | F-066 to F-070, F-182 |
| M4-7b ✅ | V1 graph, diff and branches: hide / solo a branch, diff between two commits, quick jumps (HEAD, branch, merge-base), opt-in Gravatar avatars, image diff, mode / line ending / submodule changes, external editor and `diff.tool`, compare two branches, cleanup of merged / `[gone]` branches | M3 | F-028 to F-030, F-033, F-085 to F-087, F-104, F-105 |
| M4-7c ✅ | V1 remotes and tags: manage remotes (add, rename, fetch / push URL, remove), push / pull of tags, push one tag or all, checkout of a tag (detached HEAD explained, branch creation offered) | M3 | F-124, F-125, F-201, F-202 |
| M4-9 ✅ | Integrated terminal: PTY on the Rust side (in `system/`), emulator in a resizable bottom panel, several terminals per repo, Terminal button and shortcut, integrated / external preference, CSP respected | M4-6 | F-267 |
| M4-10 ✅ | Rename Grove → **yaggui** ("yet another git graphical user interface"): `productName`, identifier `dev.tropico.yaggui` (domain yaggui.tropico.dev), crate / binary / lib, UI text and i18n, docs, agent branch prefix, `YAGGUI_*` variables, storage keys; no migration of the `dev.grove.app` data (app never deployed); the GitHub repo is renamed by the PO | all of M4 except M4-8 | — |
| M4-8 ✅ | V1 integration and validation: audit of the remaining V1 requirements (`docs/validation/V1-audit.md`), undo entry for the operations added by M4, mock / real gaps, `docs/validation/M4.md` | all of M4 | — |

Order: M4-1 ∥ M4-3 ∥ M4-4 ∥ M4-6 first; M4-2 as soon as the contract of M4-1 is pushed; M4-5 ∥ M4-7a ∥ M4-7b ∥ M4-7c ∥ M4-9 as the first wave gets merged; then M4-10 (run alone, to avoid conflicts); then M4-8.

## M5 — V1 polish and performance

Exit: the two partial V1 requirements of the audit are complete (F-033, F-066); P-07 is within target; the first opening of a repo without a commit-graph serves its first page without waiting for the full topological order. See [`docs/validation/V1-audit.md`](validation/V1-audit.md), "Major gaps" section.

This milestone does not wait for the M4 validation: its tasks do not change the flows of the M4 checklist, only their rendering or their speed. Each task that touches a `P-xx` target gives its before / after measurements in the PR.

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| M5-1 ✅ | Signature badge in the graph: signature kind (none / GPG / SSH / X.509) read by gix from the commit header and added to the graph pages (flat structure, no cryptographic verification), icon per row with a tooltip, on-demand verification in the detail unchanged; P-02 and P-04 measured again | M4 | F-066 |
| M5-2 ✅ | Disk cache for avatars: download on the Rust side (HTTP dependency justified in the PR), bounded cache in the OS cache folder with expiry, images served to the front without widening the CSP beyond what exists, no request while the option is off, cache clearing from the preferences | M4 | F-033 |
| M5-3 ✅ | Tab switch (P-07): keep the views of recent tabs mounted and hidden (bounded number), suspend their subscriptions (watcher, polling, queries) while hidden, targeted invalidation on return; memory measured with 5 open tabs | M4 | P-07 |
| M5-4 ✅ | Incremental topological order: without a commit-graph, the first graph page is served before the full walk ends (`graph/topo.rs`), consistent following pages, background commit-graph write unchanged; P-02 and P-03 measured again with and without commit-graph | M4 | P-02, P-03 |
| M5-5 | Graph at CPU ×4 (P-04): text columns (date, SHA, author) and avatars drawn in the canvas with the lanes, selection, hover, context menu and accessibility kept. **Conditional**: started only if the PO's measurement on macOS / Windows shows scrolling outside the target | M5-1, PO measurement | P-04 |
| M5-6 | Integration: mock / real gaps, P-01 to P-08 measurements up to date in `docs/validation/V1-audit.md`, checklist `docs/validation/M5.md` | all of M5 | — |
| M5-7 ✅ | Public release preparation: docs in English (`CLAUDE.md`, `docs/SPEC.md`, plan, validation, mockups), neutral persona in the mocks, GPL-3.0-or-later license, README with banner and screenshots (`pnpm screenshots`), internal notes removed | M4 | — |
| M5-8 ✅ | Per-repository layout: side panel sizes and collapsed state, expanded / collapsed sidebar sections and nodes, flat list, recent branches, graph columns (shown, widths) saved per repository (`repo_ui_state` table) and found again when a closed repository is reopened; the tab keeps a copy for the restoration at startup | M4 | F-021, F-040 |
| M5-9 ✅ | Rendered Markdown diff: "Preview" layout offered for Markdown files, whole-file diff parsed with `@lezer/markdown` (GFM), block alignment and word changes inside changed blocks, rendered to React without HTML injection (raw HTML shown as code, links do not navigate), change navigation, chunk loaded on demand | M4 | F-089 |

Order: M5-1 ∥ M5-2 ∥ M5-3 ∥ M5-4; M5-5 if the PO's measurement calls for it; then M5-6. M5-7, M5-8 and M5-9 are independent.

## M6 — Distribution

Exit: every tagged version is installable from GitHub Releases and from the main package managers (Homebrew, Chocolatey, winget, AUR, apt, dnf). See [`docs/RELEASING.md`](RELEASING.md).

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| M6-1 ✅ | Release builds: GitHub Actions workflow that builds the installers (macOS arm64 / x64 `.dmg`, Linux `.deb` / `.rpm` / `.AppImage`, Windows `.msi` / `.exe`) and, on a `vX.Y.Z` tag, attaches them with their checksums to a draft release; version check between the tag and the four version files, `pnpm release:version`; bundle metadata (`git` dependency of the Linux packages) | M5-7 | — |
| M6-2a ✅ | AUR (`yaggui-bin`): PKGBUILD generated from the release `.deb`, built and installed in an Arch container, pushed to the AUR when a release is published | M6-1 | — |
| M6-2b ✅ | Homebrew tap: cask updated by CI when a release is published | M6-1 | — |
| M6-3 | Signed apt and dnf repositories hosted on GitHub Pages, updated when a release is published | M6-1 | — |
| M6-4 | Chocolatey and winget packages submitted when a release is published | M6-1 | — |
| M6-5 | Code signing: Apple notarization, Windows signing | M6-1 | — |
| M6-6 ✅ | Updates: opt-in check at startup (asked once) and from the palette / preferences, against the `latest.json` manifest of the newest release; in-place install with the Tauri updater (signed bundles) for the Windows installers, the macOS app and the AppImage; upgrade command for Homebrew and the AUR, release page for `.deb` / `.rpm`. Beta channel left for later (pre-release versions are refused by the MSI bundler) | M6-1 | SPEC §10 |
| M6-7 ✅ | Changelog: `CHANGELOG.md` (Keep a Changelog) backfilled from 0.1.0, embedded in the binary and parsed in Rust (`changelog` command), "What's new" view (versions newest first, grouped as features / fixes / other, installed version highlighted), installed version in the status bar and the preferences, palette and macOS Help menu entries; `pnpm release:version` moves `Unreleased` into the new version and refuses an empty one | M6-1 | — |

Order: M6-1; then M6-2a ∥ M6-2b ∥ M6-3 ∥ M6-4 ∥ M6-6; M6-5 when the signing accounts exist.

## W — Website and documentation

Exit: `https://yaggui.tropico.dev` serves the landing page, the versioned docs (latest release by default, older versions selectable, `next` for `master`) and the live demo, in English and French, deployed by CI. Agents keep the docs current with each change. See [`docs/WEBSITE.md`](WEBSITE.md) and the mockup [`docs/ui/website.html`](ui/website.html).

| ID | Task | Depends on | Requirements |
|---|---|---|---|
| W-1 ✅ | Website scaffold: Astro + Starlight in `website/` (standalone package), app theme tokens through one adapter, EN / FR routing, versioned docs built from git refs (`website/versions.json`), lightbox, placeholder pages; `ci.yml` skips app jobs on site-only PRs, `website.yml` builds PRs (Cloudflare Pages preview) and deploys to Cloudflare Pages on `master` and on release | — | — |
| W-2 ✅ | Landing page from the mockup, EN and FR: OS-aware download, install commands, features, undo, transparency, themes, FAQ, final call to action | W-1 | — |
| W-3 ✅ | Docs content in English from an analysis of the app (features, flows, UI wording, edge cases, undo), information architecture, `sources` / `requirements` frontmatter, docs screenshots in both themes | — | — |
| W-4 ✅ | Docs upkeep: `CLAUDE.md` rules and Definition of done, PR template, `docs-impact` warning job, keyboard shortcut reference generated from the action registry | W-1 | — |
| W-5 ✅ | Live demo: mocked frontend built into `/demo/` with a demo banner | W-1 | — |
| W-6 ✅ | French docs | W-3 | — |

Order: W-1 ∥ W-3; then W-2 ∥ W-4 ∥ W-5 on top of W-1; W-6 once the English docs of W-3 are stable.
