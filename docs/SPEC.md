# yaggui — Specification

> Local, cross-platform (Windows / macOS / Linux) graphical Git client, focused on ergonomics and performance.
> UX reference: GitKraken. Performance references: Fork, Sublime Merge.

Version 0.1 — October 2026

---

## 1. Vision and principles

**Goal**: a Git client you can use without knowing the commands, but that never holds back someone who does. Every common action takes one click, one drag & drop or one keyboard shortcut, and every destructive action is understandable before it runs and undoable after.

Guiding principles, in priority order when they conflict:

1. **Never lose the user's work.** Explicit confirmations on destructive operations, `--force-with-lease` only, reflog-based undo, auto-stash offered before any checkout on a dirty tree.
2. **Fast, all the time.** The UI never blocks on a Git operation. The graph scrolls at the display refresh rate, even with 1M commits.
3. **Git's behavior is the behavior.** No "creative" reimplementation: write operations go through the user's `git` binary, so the same hooks, config and credentials as in a terminal.
4. **Discoverable, then efficient.** Everything is visible with the mouse (context menus, drag & drop), everything is reachable from the keyboard (command palette, shortcuts).
5. **Transparent.** Every Git command that runs can be inspected in a log. Git errors are translated into plain language with a suggested action.

**100% local**: no account, no telemetry by default, no network call other than the Git operations themselves (fetch/pull/push/clone) and, opt-in, Gravatar avatars and update checks.

### Out of scope (v1)

Hosting integrations (GitHub, GitLab, Azure DevOps PRs/issues), cloud sync of preferences, AI-generated commit messages, GPG/SSH key management (keys are used, not created), SCMs other than Git. These are listed in §12 as possible evolutions.

---

## 2. Technical choices

### 2.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| App shell | **Tauri 2** | ~10 MB binary vs ~150 MB for Electron, ~3–5× less idle RAM, native Rust backend. System WebView on all 3 OSes. |
| Frontend | **React 19 + TypeScript + Vite** | Mature ecosystem for virtualization and diff editors. |
| Frontend state | Zustand (UI) + TanStack Query (repo data, cache/invalidation) | Clean split between UI state and state derived from the repo, fine-grained invalidation on watcher events. |
| Styles | CSS Modules + design tokens as CSS variables | Themes switch live without a React re-render. No CSS-in-JS runtime. |
| Primitive components | Radix UI (menus, dialogs, popovers) | Correct accessibility and focus handling without reinventing them. |
| Diff / merge editor | **CodeMirror 6** (+ `@codemirror/merge`) | Much lighter than Monaco, natively virtualized, unified and split views, extensible for line staging. |
| List virtualization | TanStack Virtual | Graph, file lists, history. |
| Graph rendering | **Canvas 2D** for the lanes, virtualized DOM for the text | SVG collapses beyond a few thousand nodes; the canvas only draws the visible rows. |
| Git backend (reads) | **gitoxide (`gix`)**, `git2` as fallback | Reads the graph, refs, status and blobs without spawning a process. `gix` uses the `commit-graph` file. |
| Git backend (writes) | **System `git` binary** (CLI) | Hooks, credential helpers, ssh-agent, LFS, user config, `rebase`, `merge`: same behavior as in a terminal. Minimum version: Git 2.30. |
| FS watcher | `notify` (Rust) + 150 ms debounce | Automatic refresh of status and refs. |
| Tests | Rust: `cargo test` on script-generated fixture repos; front: Vitest; E2E: WebdriverIO + `tauri-driver` | |

**Why not Electron**: it is what GitKraken uses, and it is precisely its weak spot (slow startup, RAM). **Why not Avalonia/.NET**: viable, but the ecosystem of diff editors and virtualization is much poorer than on the web side, and LibGit2Sharp lags behind libgit2. Tauri keeps React for the UI and gives a fast native backend. The cost: learning enough Rust for the Git layer, a real investment to take on deliberately.

**WebView caveat**: Tauri uses WebView2 (Windows), WKWebView (macOS) and WebKitGTK (Linux). WebKitGTK is the weak link for rendering performance, so the canvas graph and strict virtualization are mandatory, not optional. Test on Linux from the first sprint.

### 2.2 Architecture

```
┌─────────────────────────── Frontend (WebView) ───────────────────────────┐
│  Tabs ─ RepoView ─ Graph(canvas) ─ Staging ─ Diff(CodeMirror) ─ Palette  │
│  Zustand (UI)       TanStack Query (repo data cache)                     │
└───────────────▲──────────────────────────────────────┬───────────────────┘
                │ events (refs-changed, status-changed, │ invoke(commands)
                │ op-progress, op-finished)             ▼
┌──────────────────────────────── Rust backend ────────────────────────────┐
│  RepoManager (1 RepoSession per open tab)                                │
│   ├─ ReadService  (gix): log/graph, refs, status, diff, blame, blobs     │
│   ├─ OpQueue      : per-repo serialized queue for writes,                │
│   │                 cancellation, progress parsed from git --progress    │
│   ├─ GitCli       : spawns git, controlled env (GIT_TERMINAL_PROMPT=0,   │
│   │                 LC_ALL=C for parsing), captures stdout/stderr        │
│   ├─ Watcher      : worktree + .git/{HEAD,refs,index,*_HEAD}             │
│   ├─ GraphLayout  : incremental lane layout, in pages                    │
│   └─ OpJournal    : operation history for Undo/Redo                      │
│  AppStore (SQLite): workspaces, repos, tabs, preferences, caches         │
└──────────────────────────────────────────────────────────────────────────┘
```

Architecture rules:

- **Concurrent reads, serialized writes** per repo. A running write visually disables conflicting actions but does not prevent navigation.
- **Never an interactive Git process.** `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR` pointing to an internal helper (for `rebase -i` and merge messages), same for `GIT_SEQUENCE_EDITOR`.
- **Credentials**: delegated to the configured credential helper (Git Credential Manager recommended and detected on Windows/macOS) and to `ssh-agent`. When authentication fails, a dialog explains why and offers to open the docs or enter a token through `git credential approve`. The app stores **no** secret itself.
- **Compact IPC payloads**: the graph is sent as typed arrays / flat structures in pages of 500 commits, not as one JSON object per commit.
- **`index.lock` handling**: detects an orphan lock (no process, older than 10 s) and offers to remove it, with an explanation.

---

## 3. Performance targets (measurable requirements)

Reference machine: 2023 mid-range laptop (8 cores, 16 GB, NVMe SSD).

| ID | Measure | Target | Test repo |
|---|---|---|---|
| P-01 | Cold start until the window is interactive | < 800 ms | — |
| P-02 | Opening a repo → first screen of the graph | < 300 ms | `git/git` (~75k commits) |
| P-03 | Opening a very large repo → first screen | < 1.5 s | `torvalds/linux` (~1.3M commits) |
| P-04 | Graph scrolling | sustained 60 fps, no frame > 32 ms | `torvalds/linux` |
| P-05 | Status refresh after a change on disk | < 200 ms | 50k-file repo |
| P-06 | Showing a file diff (< 5k lines) | < 100 ms | — |
| P-07 | Tab switch | < 50 ms (state kept in memory) | — |
| P-08 | Palette (fuzzy) search over 10k branches/files | < 30 ms per keystroke | — |
| P-09 | Idle RAM, 3 tabs open | < 350 MB | — |
| P-10 | Installer size | < 25 MB | — |

These targets are checked by reproducible local benchmarks (§11).

Safeguards: diffs over 5k lines or 1 MB are rendered on demand ("Show anyway"); binary files are detected and not rendered as text; status on huge repos runs incrementally with a "scanning" indicator.

---

## 4. Overall layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [yaggui ×] [api-backoffice ×] [website ×]  [+]                ⌘K    │ ← tab bar
├──────────────────────────────────────────────────────────────────────────────┤
│ ⟲ Undo  ⟳ Redo │ ↓ Pull ▾  ↑ Push  ⇣ Fetch │ ⎇ Branch  ⊞ Stash  ⊟ Pop │ main ▾ │ ← toolbar
├──────────────┬───────────────────────────────────────────┬───────────────────┤
│ LOCAL        │ ┌ // WIP  3 files changed                  │  Commit / Details │
│  ● main  ↑2  │ ●─┤ feat: add tab drag & drop     main     │                   │
│    feat/tabs │ │ ● fix: stash list refresh                │  Unstaged (3)     │
│ REMOTE       │ ├─╯ Merge branch 'feat/graph'              │   M src/App.tsx   │
│  ▸ origin    │ ● chore: bump tauri          v0.3.0        │  Staged (1)       │
│ TAGS         │ │                                          │   A docs/x.md     │
│ STASHES (2)  │ ⋮                                          │                   │
│ SUBMODULES   │                                           │  [Summary     ]   │
│ WORKTREES    │                                           │  [Description ]   │
│              │                                           │  [ Commit ]       │
├──────────────┴───────────────────────────────────────────┴───────────────────┤
│ ✓ Fetch done · origin · 2 min ago                git 2.47 · 3 operations ⌄   │ ← status bar
└──────────────────────────────────────────────────────────────────────────────┘
```

When a commit or file is selected, the diff opens **in place of the graph** (center area) with a button/`Esc` to go back, like GitKraken, which keeps the diff wide and readable. Option: diff in a bottom panel for large screens.

The three panels are resizable and collapsible; their sizes are remembered per tab.

---

## 5. Functional requirements

Priorities: **MVP** (required for daily use), **V1** (public release), **V2** (after v1), **Dropped** (decided against after v1; the ID is kept so it is not reused).

### 5.1 Projects, workspaces and tabs

| ID | Requirement | Prio |
|---|---|---|
| F-001 | Open an existing repo (folder picker, drag & drop of a folder onto the window, CLI argument `yaggui <path>`). | MVP |
| F-002 | Clone a repo (HTTPS/SSH URL, target folder, branch, optional shallow depth, recursive submodules) with detailed progress and cancellation. | MVP |
| F-003 | Initialize a repo (configurable default branch, `.gitignore` from templates, optional README). | MVP |
| F-004 | **Tabs**: one tab per repo, reorderable by drag, closable (`⌘W`), restored on restart, `⌃Tab` / `⌘1..9` navigation. Tab indicator: operation in progress, conflicts, uncommitted changes. | MVP |
| F-005 | Welcome screen (new tab): recent repos, favorites, fuzzy search, Open/Clone/Init actions. | MVP |
| F-006 | **Workspaces**: named groups of repos (e.g. "Client X", "Personal"), open every repo of a workspace as tabs at once. | V1 |
| F-007 | Scan a parent folder to discover and import every repo it contains (configurable depth). | V1 |
| F-008 | Workspace overview: list of repos with current branch, ahead/behind, dirty state, last fetch; "Fetch all". | V1 |
| F-009 | Detect a moved/deleted repo and offer to relocate or remove it. | V1 |
| F-010 | Multiple windows: detach a tab into a new window. | Dropped |

### 5.2 Commit graph (center view)

| ID | Requirement | Prio |
|---|---|---|
| F-020 | Graph with colored lanes, one stable color per branch, readable merges and forks, virtualized canvas rendering. | MVP |
| F-021 | Columns: graph, message (summary), author (initials/avatar), date (relative, absolute on hover), short SHA. Resizable and hideable columns. | MVP |
| F-022 | **WIP node** at the top of the graph when the working tree is dirty, with the number of changed files; clicking it opens the staging panel. | MVP |
| F-023 | Ref labels on commits: local branch, remote branch, tag, HEAD, stash, clearly distinguished; local and remote merged into one label when they point to the same commit. | MVP |
| F-024 | Double-click on a branch label → checkout. | MVP |
| F-025 | Commit context menu: checkout (detached HEAD, with a warning), create branch here, create tag here, cherry-pick, revert, reset (soft/mixed/hard) the current branch here, interactive rebase from here, copy SHA/message, compare with… | MVP |
| F-026 | **Drag & drop a branch onto another** → menu: Merge X into Y / Rebase X onto Y / Fast-forward when possible. | MVP |
| F-027 | Search / filter in the graph: message, author, SHA, changed file path, date range; step through results (`↵` / `⇧↵`). | MVP |
| F-028 | Hide / "solo" a branch (show only its history), hide remote branches, hide stashes. | V1 |
| F-029 | Select two commits (`⌘click`) → diff between them. | V1 |
| F-030 | Quick jump: to HEAD, to a branch (palette), to the merge-base of two branches. | V1 |
| F-031 | Incremental loading (pages) with infinite scrolling and an estimated proportional scrollbar. | MVP |
| F-032 | "First-parent" mode (linear history of the main branch). | V2 |
| F-033 | Gravatar avatars (opt-in, disk cache); deterministic colored initials by default. | V1 |

### 5.3 Left side panel (refs)

| ID | Requirement | Prio |
|---|---|---|
| F-040 | Collapsible sections: Local, Remote (per remote), Tags, Stashes, Submodules, Worktrees. Counters. | MVP |
| F-041 | Branches grouped by prefix as a tree (`feat/`, `fix/`…), flat list option. | MVP |
| F-042 | Ahead/behind per local branch vs. upstream (`↑2 ↓5`). | MVP |
| F-043 | Instant filter at the top of the panel. | MVP |
| F-044 | Click → selects the commit and scrolls the graph to it; double-click → checkout; full context menu. | MVP |
| F-045 | Remote branches: double-click → creates and checks out a local tracking branch (if none exists). | MVP |

### 5.4 Working tree, staging, commit

| ID | Requirement | Prio |
|---|---|---|
| F-060 | Unstaged / Staged lists, list or tree view, per-file status (M, A, D, R, C, U, ?) with icons and colors. | MVP |
| F-061 | Stage/unstage per file (button on hover, `Space`, drag between lists), "Stage all" / "Unstage all". | MVP |
| F-062 | **Stage/unstage/discard per hunk and per line** directly in the diff. | MVP |
| F-063 | Discard a file / everything, with a confirmation and an undo entry (content saved before removal). | MVP |
| F-064 | Commit area: summary (counter, warning over 72 chars), multi-line description, `⌘↵` to commit, amend (prefills the previous message), "Push after commit" checkbox. | MVP |
| F-065 | Hooks (`pre-commit`, `commit-msg`) run, with their output shown on failure, readable and untruncated. | MVP |
| F-066 | Commit signing (GPG / SSH / `gpg.format`) per the Git config; "signed/verified" badge in the graph. | V1 |
| F-067 | Message templates (`commit.template`), optional Conventional Commits helper (type/scope picker). | V1 |
| F-068 | History of recent, reusable messages. | V1 |
| F-069 | Add to `.gitignore` from an untracked file (exact file, extension, folder). | V1 |
| F-070 | Change the repo identity (user.name/email) from the panel, with identity profiles (personal/work). | V1 |
| F-071 | Co-authors (`Co-authored-by`) with autocompletion from history. | Dropped |

### 5.5 Diff

| ID | Requirement | Prio |
|---|---|---|
| F-080 | **Unified** and **side-by-side** views, persisted toggle. | MVP |
| F-081 | Syntax highlighting, intra-line highlighting (changed words). | MVP |
| F-082 | Options: ignore whitespace, number of context lines, "show whole file", line wrapping. | MVP |
| F-083 | Navigation between hunks (`↑`/`↓` in the hunk list, `n`/`p`) and between files (`j`/`k`). | MVP |
| F-084 | Rename and copy detection with similarity %. | MVP |
| F-085 | Binary files: size before/after; **images**: side by side, onion skin, swipe. | V1 |
| F-086 | Mode changes (chmod), line ending changes (CRLF/LF) and submodule changes shown explicitly. | V1 |
| F-087 | Open the file in the external editor / in the file manager; launch the configured external diff tool (`diff.tool`). | V1 |
| F-088 | Commit diff: list of changed files + diff, stats (+/−). | MVP |
| F-089 | Markdown files: **rendered preview** of the new version with its changes (changed blocks marked in the margin, inserted words highlighted, removed ones struck through in place, `n`/`p` between changes, removed text can be hidden), persisted toggle next to the diff layout. | V1 |

### 5.6 Branches and checkout

| ID | Requirement | Prio |
|---|---|---|
| F-100 | Create a branch (from HEAD, a commit, a branch, a tag, a stash), with an option to check it out right away. Live name validation (`git check-ref-format`). | MVP |
| F-101 | Rename, delete (with a warning if unmerged), delete the associated remote branch (checkbox). | MVP |
| F-102 | Checkout with a dirty tree: dialog offering **Stash & checkout & pop**, **Bring changes along** (when compatible), **Cancel**. | MVP |
| F-103 | Set / change / remove the upstream. | MVP |
| F-104 | Compare two branches: commits only on one side / the other, overall diff. | V1 |
| F-105 | Cleanup: list local branches that are merged or whose upstream is gone (`[gone]`) and delete them in bulk. | V1 |
| F-106 | Quick branch picker in the toolbar (fuzzy, recent first). | MVP |

### 5.7 Remotes and sync

| ID | Requirement | Prio |
|---|---|---|
| F-120 | Fetch (one remote / all), configurable periodic **auto-fetch** (default 10 min, can be disabled), configurable `--prune`. | MVP |
| F-121 | Pull with the strategy picked in the button menu: fast-forward only / merge / rebase; default read from `pull.rebase` / `pull.ff`. | MVP |
| F-122 | Push; first push of a branch → offers to create the upstream on `origin`. | MVP |
| F-123 | Force push **only through `--force-with-lease`**, behind an explicit confirmation, and refused by default on protected branches (configurable list: `main`, `master`, `develop`, `release/*`). | MVP |
| F-124 | Push/pull tags. | V1 |
| F-125 | Manage remotes: add, rename, change URL (fetch/push), remove. | V1 |
| F-126 | Parsed network progress (objects, MB, speed) in the status bar, cancellable. | MVP |
| F-127 | Translated network/auth errors: "Push rejected: the remote branch has commits you don't have. → [Pull then push]". | MVP |

### 5.8 Merge, rebase, cherry-pick, revert, reset

| ID | Requirement | Prio |
|---|---|---|
| F-140 | Merge (ff when possible / always create a merge commit / squash), configurable per action. | MVP |
| F-141 | Rebase a branch onto another. | MVP |
| F-142 | **Visual interactive rebase**: commit list, reorder by drag, pick/reword/squash/fixup/drop/edit actions through buttons or keys (`p`,`r`,`s`,`f`,`d`,`e`), preview of the result, inline message editing. | V1 |
| F-143 | Cherry-pick one or more commits (multi-selection, drag a commit onto a branch). | MVP |
| F-144 | Revert a commit (merges included, with parent choice). | MVP |
| F-145 | Reset soft/mixed/hard with a clear explanation of each mode and of what will be lost (list of affected files for `hard`). | MVP |
| F-146 | **Operation-in-progress banner** (merge/rebase/cherry-pick/revert/bisect detected from `.git`): progress ("Rebase 3/7"), Continue / Skip / Abort. | MVP |
| F-147 | Autosquash (`fixup!`) and "Create a fixup for this commit" from the context menu. | V2 |

### 5.9 Conflict resolution

| ID | Requirement | Prio |
|---|---|---|
| F-160 | List of conflicted files, counter, resolved / unresolved status. | MVP |
| F-161 | Quick per-file resolution: **Take mine / Take theirs** (`--ours`/`--theirs`), mark as resolved. | MVP |
| F-162 | **3-way merge editor**: "Ours" / "Theirs" panels on top with per-block checkboxes, editable result below, navigation between conflicts, remaining counter. | V1 |
| F-163 | Explicit labels depending on context (during a rebase, "ours" is the base and "theirs" is your commit: the UI shows **branch names** instead of ours/theirs). | V1 |
| F-164 | Launch the external merge tool (`merge.tool`). | V1 |
| F-165 | Delete/modify and binary conflicts handled with an explicit choice. | V1 |

### 5.10 Stash

| ID | Requirement | Prio |
|---|---|---|
| F-180 | Quick stash (toolbar, `⌘⇧S`) with an optional message. | MVP |
| F-181 | Options: include untracked files, keep the index (`--keep-index`). | MVP |
| F-182 | **Partial stash**: only the selected files (`git stash push -- <paths>`). | V1 |
| F-183 | Stash list (left panel + nodes in the graph on their base commit), diff preview. | MVP |
| F-184 | Apply, Pop, Drop (with undo), rename (through drop + store), create a branch from a stash. | MVP |
| F-185 | Apply a single file from a stash. | V2 |

### 5.11 Tags

| ID | Requirement | Prio |
|---|---|---|
| F-200 | Create a lightweight / annotated tag (message, signature) on any commit. | MVP |
| F-201 | Delete locally / on the remote, push one tag or all. | V1 |
| F-202 | Checkout a tag (detached HEAD, with an explanation and an offer to create a branch). | V1 |

### 5.12 History, blame, reflog

| ID | Requirement | Prio |
|---|---|---|
| F-220 | File history (following renames with `--follow`), with a diff per commit. | V1 |
| F-221 | Blame colored by age, click on a line → commit in the graph, "blame parent" to go further back. | V1 |
| F-222 | Reflog viewer (HEAD and per branch), with state restoration (branch creation / reset). | V1 |
| F-223 | History of a line range (`git log -L`). | V2 |
| F-224 | File explorer at a given commit (commit tree), open/save a version. | V2 |

### 5.13 Undo / Redo

A signature feature of GitKraken and a pillar of the ergonomics: it lowers the fear of doing something wrong.

| ID | Requirement | Prio |
|---|---|---|
| F-240 | Undo (`⌘Z` outside text fields) / Redo of the last operation for: commit, amend, checkout, branch creation/deletion/rename, merge (unpushed), reset, discard, stash drop, cherry-pick, revert. | V1 |
| F-241 | Implementation: an `OpJournal` that records, before each operation, the touched refs (SHA), the index and, for discards, a backup of the contents (blobs written with `git hash-object -w`). Undo restores those states. | V1 |
| F-242 | Operations that cannot be undone locally (push, fetch with prune) are flagged as such on the button (disabled + explanatory tooltip). | V1 |
| F-243 | Drop-down list of the session's operation history with timestamps. | V1 |
| F-244 | Persistent journal: the `OpJournal` is saved in `yaggui.db`, so the last operations of a repo stay undoable after a restart. An entry whose refs or index moved since (outside yaggui, or while it was closed) is not restored and says why. | V2 |

### 5.14 Submodules, worktrees, LFS, misc.

| ID | Requirement | Prio |
|---|---|---|
| F-260 | Submodules: list, state (expected vs. current commit, dirty), init/update, open in a new tab. | V1 |
| F-261 | Worktrees: list, create (from a branch), open in a tab, remove. | V1 |
| F-262 | Git LFS: detection, "LFS" badge on tracked files, `lfs pull`/`track`, no text diff on pointers. | V1 |
| F-263 | Assisted bisect: mark good/bad from the graph, progress banner. | V2 |
| F-264 | Patches: create a patch from a commit/selection, apply a patch (`git apply` / `git am`). | Dropped |
| F-265 | Git Flow / configurable branch conventions (prefixes, base branch per type). | Dropped |
| F-266 | Open a terminal in the repo (terminal configurable per OS). | MVP |
| F-267 | **Integrated terminal**: panel at the bottom of the repo view (opened by the Terminal button and a shortcut), the OS default shell in the repo folder, several terminals per repo, survives tab switches; the external terminal (F-266) stays available as a preference. | V1 |

### 5.15 Command palette and keyboard

| ID | Requirement | Prio |
|---|---|---|
| F-280 | **Command palette** `⌘K` / `Ctrl+K`: fuzzy search over every action, branch, tag, commit (SHA/message), repo file, repo/tab. Typed results with icons, shortcut shown. | MVP |
| F-281 | Every palette action has a stable identifier and can be rebound (`keybindings.json` + editor in the preferences). | V1 |
| F-282 | Full keyboard navigation: visible focus, `Tab` between panels, arrows in lists, `Space` stages, `↵` opens, `Delete` discards (with confirmation). | MVP |
| F-283 | Shortcut cheat sheet (`⌘/`). | V1 |

Default shortcuts (macOS; `⌘`→`Ctrl` elsewhere):

| Action | Shortcut |
|---|---|
| Palette | `⌘K` |
| New tab / close | `⌘T` / `⌘W` |
| Tab n | `⌘1…9` |
| Fetch / Pull / Push | `⌘⇧F` / `⌘⇧L` / `⌘⇧P` |
| New branch | `⌘B` |
| Stash / Pop | `⌘⇧S` / `⌘⇧⌥S` |
| Commit | `⌘↵` (in the message area) |
| Stage all | `⌘⇧A` |
| Undo / Redo | `⌘Z` / `⌘⇧Z` |
| Search the graph | `⌘F` |
| Go to HEAD | `⌘⇧H` |
| Toggle unified / split diff | `⌘D` |

### 5.16 Log, notifications, errors

| ID | Requirement | Prio |
|---|---|---|
| F-300 | **Log of the Git commands** that ran (command, duration, exit code, stdout/stderr), reachable from the status bar, copyable. | MVP |
| F-301 | Non-blocking toast notifications for successes; errors stay until dismissed and offer an action. | MVP |
| F-302 | Catalog of known Git errors → clear message + action (push rejected, conflict, lock, auth, detached, dirty tree, failed hook, missing upstream, etc.). | MVP |
| F-303 | Optional system notifications for long operations finished in the background (window not focused). | Dropped |

### 5.17 Preferences

| ID | Requirement | Prio |
|---|---|---|
| F-320 | Color theme from a catalogue of well-known themes (yaggui's Graphite, Paper and Terminal, Catppuccin, VS Code, JetBrains, GitHub, classics), previewed live on the whole app before it is applied (gallery in the preferences, theme picker in the palette); one theme for the light mode and one for the dark mode, following the OS or not; high contrast on every theme; interface style Standard / Terminal (shape only, see §7); density (compact / comfortable), UI font and code font, size. | MVP |
| F-321 | Language: French, English. i18n architecture ready for more. | V1 |
| F-322 | Path to the Git binary (auto-detected), version shown, warning below 2.30. | MVP |
| F-323 | External editor, terminal, external diff/merge tools. | V1 |
| F-324 | Behavior: auto-fetch, prune, default pull strategy, protected branches, confirmations that can be turned on/off. | MVP |
| F-325 | Git config editor (global and local) for common keys (identity, `pull.rebase`, `core.autocrlf`, `init.defaultBranch`, signing) + raw editing. | V1 |
| F-326 | Import/export preferences (JSON file) to sync between machines by hand. | V2 |

---

## 6. Cross-cutting UX requirements

1. **One action, one gesture.** Checkout = double-click. Merge/rebase = drag & drop. Stage = click or `Space`. Commit = `⌘↵`.
2. **Preview before acting.** Destructive dialogs show the concrete effect: "3 commits will be removed from `feat/x`: …", "5 files will lose their changes: …".
3. **No dialog for safe operations.** Fetch, stage, commit, branch creation: inline feedback, no interruption.
4. **Useful empty states.** A repo without changes shows "Nothing to commit" + shortcuts to the likely next actions (pull, new branch).
5. **Always say where you are.** Current branch, upstream, ahead/behind and operation in progress are always visible in the toolbar.
6. **Human language, Git terms as a subtitle.** "Throw away changes (discard)"; tooltips with the exact equivalent Git command, for learning.
7. **Motion only when useful.** Animations ≤ 150 ms, only to signal a state transition (panel, toast, drop). `prefers-reduced-motion` is respected.
8. **Accessibility**: at least WCAG AA contrast in every theme, status colors doubled by an icon/letter (color blindness), visible focus, ARIA roles on lists/trees/menus, adjustable font size.
9. **Native on each OS**: window button placement (left on macOS, right on Windows/Linux), native application menus on macOS, `⌘` vs `Ctrl`, paths and line endings respected.

---

## 7. UI style proposals

The interactive mockups are in [`docs/ui/styles.html`](ui/styles.html); open the file in a browser. One markup, four themes applied through design tokens (exactly the theming architecture planned for the app).

| Style | Spirit | For whom | Strengths | Risks |
|---|---|---|---|---|
| **A — Graphite** (dark) | Pro, understated, inspired by Linear / Zed. Slightly bluish neutral grays, a single accent (violet). Saturated lanes that stand out on the background. | Dark default | Comfortable for long sessions, the graph is the star, very "GitKraken but more refined". | Can feel austere without the lane colors. |
| **B — Paper** (light) | Light, airy, close to a native macOS app (Tower, Fork). Off-white background, thin separators, blue accent. | Light default | Reassuring for beginners, great in daylight, "native" feel. | Lanes must be darkened to keep enough contrast. |
| **C — Aurora** (colorful dark) | More expressive: midnight-blue background, Nord/Catppuccin palette, rounder corners, labels as colored pills. | "Fun" option | Closest to the GitKraken energy, very recognizable, pleasant. | Tires the eyes faster, less pro in front of a client. |
| **D — Terminal** (dense dark) | Monospace everywhere, maximum density, sharp contrasts, green accent. Inspired by lazygit / Sublime Merge. | "Power user" option | More information on screen, consistent with keyboard-first use. | Off-putting for beginners, against the accessibility goal if used as the default. |

**Recommendation**: ship **A (dark) + B (light)** as the default pair, built on the same tokens; keep **C** and **D** as optional themes (they cost almost nothing once the tokens exist). Density (compact/comfortable) is a setting orthogonal to the theme.

**Shipped (M10-1)**: A, B and the colors of D are color themes of a catalogue that also holds well-known editor themes (Catppuccin, VS Code, JetBrains, GitHub, One Dark, Dracula, Nord, Tokyo Night, Gruvbox, Solarized, Rosé Pine), generated from their palettes with the contrast moved to WCAG AA. The shape of D (monospace, square corners, dense rows) is the separate "Terminal" interface style, which goes with any color theme. C is covered by the Catppuccin and Nord themes.

### 7.1 Design tokens (shared base)

```css
:root {
  /* Surfaces */
  --bg-app; --bg-panel; --bg-elevated; --bg-hover; --bg-selected;
  /* Text */
  --fg-primary; --fg-secondary; --fg-muted;
  /* Borders */
  --border-subtle; --border-strong;
  /* Accent and semantics */
  --accent; --accent-fg; --success; --warning; --danger; --info;
  /* Diff */
  --diff-add-bg; --diff-add-strong; --diff-del-bg; --diff-del-strong;
  /* Graph: 8 lane colors, assigned by a hash of the branch name */
  --lane-0 … --lane-7;
  /* Type */
  --font-ui; --font-code; --text-xs: 11px; --text-sm: 12px; --text-md: 13px;
  /* Geometry */
  --radius-sm; --radius-md; --row-height: 28px; /* 22px in compact mode */
}
```

Fonts: UI in **Inter** (bundled, system font fallback), code in **JetBrains Mono** (bundled). Base size 13 px.

---

## 8. Persisted data

Stored in the OS application config folder (`~/Library/Application Support/dev.tropico.yaggui`, `%APPDATA%\dev.tropico.yaggui`, `$XDG_CONFIG_HOME/dev.tropico.yaggui`):

- `yaggui.db` (SQLite): known repos (path, display name, color, favorite, last access), workspaces, tab and panel state, per-repo layout, undo journal, preferences (`preferences` table, one row per setting, JSON values), identity profiles, commit templates and message history. The preferences are edited in the Preferences window only; there is no `settings.json` (hand sync between machines: F-326).
- `keybindings.json`: custom shortcuts (readable and editable by hand).
- `backups/`: content saved before a discard, for undo.

The operation journal (undo / redo) is also in `yaggui.db` (F-244): per repo, the last 100 entries and none older than 30 days, with what each undo restores (ids of commits and objects, ref names, paths; never file contents, which stay in the repo as unreachable blobs). It is dropped with the repo.

Downloaded avatars (opt-in, F-033) go to the OS cache folder (`avatars-v1/`), not the config folder.

Nothing is written into the user's repos, except what Git writes itself.

---

## 9. Security

- No secret stored by the application; full delegation to credential helpers and `ssh-agent`.
- The frontend has no shell access: only typed, allowlisted Tauri commands (Tauri 2 capabilities). No user argument is interpolated into a shell string: `Command` with separate arguments, `--` before paths.
- Branch/ref names validated with `git check-ref-format`; paths normalized and confined to the worktree.
- Repo flagged as unsafe (`safe.directory`): explicit message and an action to add it, never automatic.
- Strict CSP on the WebView, no remote content loaded (except opt-in avatars, served through the backend cache).
- Diff content shown as text, never interpreted as HTML.

---

## 10. Distribution

| OS | Formats | Signing |
|---|---|---|
| macOS (Intel + Apple Silicon, universal) | `.dmg` | Signed + notarized (Apple Developer ID required) |
| Windows 10/11 x64 + ARM64 | NSIS installer (`.exe`) + `.msi`; winget | Authenticode signing (otherwise SmartScreen blocks it) |
| Linux x64 + ARM64 | `.AppImage`, `.deb`, `.rpm`, Flatpak; **Nix package (flake)** | — |

Updates: Tauri updater, **opt-in** (consistent with 100% local), update signature verification. Stable / beta channels.

---

## 11. Quality and tests

- **Backend**: unit and integration tests on script-generated fixture repos (linear histories, multiple merges, octopus, conflicts, submodules, renames, LFS, non-UTF-8 encodings, unicode file names, CRLF). Every write operation is tested by checking the resulting Git state **and** its undo.
- **Graph**: snapshot tests of the lane layout on fixture repos.
- **Frontend**: Vitest + Testing Library on critical components (staging, palette, destructive dialogs).
- **E2E**: WebdriverIO + `tauri-driver` (Linux, under `xvfb`) for the key flows: clone, commit, branch, merge with a conflict, stash, undo. Manual validation on macOS and Windows at the end of each milestone.
- **CI**: postponed. Until there is one, each PR must pass `pnpm check` (lint + typecheck + front tests) and `cargo clippy` / `cargo test` locally.
- **Performance**: benchmarks of targets P-01 to P-09 on `git/git` and `torvalds/linux`, run locally at each milestone; a regression over 10% is fixed before moving on.
- **Git matrix**: tests on the minimum supported version (2.30) and the latest.

---

## 12. Roadmap

| Milestone | Content | Exit criterion |
|---|---|---|
| **M0 — Foundations** (2–3 wks) | Tauri + React skeleton, design tokens and A/B themes, tabs, opening a repo, `GitCli` + `OpQueue`, watcher, command log. | A window opens a repo in a tab; manually validated on macOS and Windows. |
| **M1 — Reading** (3–4 wks) | Virtualized canvas graph + lane layout, refs panel, commit details, unified/split diff, `⌘K` palette (actions + branches). | P-02/P-03/P-04 met on `linux`. |
| **M2 — Daily writing** (4 wks) | File/hunk/line staging, commit/amend, checkout + auto-stash, branches, fetch/pull/push, stash, tags, translated errors. | Usable instead of the terminal for daily work (dogfooding). **= MVP** |
| **M3 — Advanced operations** (4–5 wks) | Drag & drop merge/rebase, cherry-pick, revert, reset, operation banner, conflicts (ours/theirs then 3-way editor), visual interactive rebase. | |
| **M4 — Comfort** (3–4 wks) | Undo/redo, workspaces, blame, file history, reflog, submodules, worktrees, LFS, full preferences, FR/EN i18n, C/D themes. | **= public V1** |
| **V2** | Persistent undo (F-244) first, then the small items: fixup / autosquash (F-147), one file from a stash (F-185), first-parent (F-032), preferences import/export (F-326); then `log -L` (F-223), tree at a commit (F-224), assisted bisect (F-263). Possibly later: hosting integrations (read-only GitHub/GitLab PRs), opt-in AI commit messages. Dropped: multiple windows (F-010), co-authors (F-071), patches (F-264), Git Flow (F-265), system notifications (F-303). | |

---

## 13. Risks and open points

1. **Rust learning curve** for the Git layer. Mitigation: start with as many operations as possible through the CLI (including non-critical reads), move to `gix` where performance requires it (graph, status).
2. **WebKitGTK on Linux**: rendering performance and specific bugs. Test from M0; keep the graph in a canvas.
3. **Graph layout on very large histories**: a full computation over 1M commits is expensive. Strategy: incremental paged layout + disk cache invalidated when refs change.
4. **Code signing**: yearly costs (Apple Developer ~$99/year, Windows certificate ~$200–400/year) to plan for a public distribution.
5. **License**: GPL-3.0-or-later. Dependencies must stay GPL-3.0-compatible (`git2`/libgit2 is GPLv2 with a linking exception, compatible).
