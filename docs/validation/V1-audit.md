# V1 requirements audit (M4-8)

State at the M4-8 PR commit, after M4-1 to M4-10. One row per requirement marked **V1** in the [spec](../SPEC.md) §5, plus the performance targets of §3. The **V2** requirements (milestone M7) were added by M7-10: §6 to §8, manual validation in [M7.md](M7.md).

Statuses: **delivered** (the spec's behavior is in place and tested) · **partial** (the essentials are there, one point is missing, detailed in the column) · **missing**.

The evidence cites the code, the tests (`src-tauri/tests/*.rs` = Rust integration on fixture repos, `e2e/*.spec.ts` = Playwright on the mock, `*.test.ts(x)` = Vitest) and the PR that delivered it. The manual macOS / Windows validation is in [M4.md](M4.md).

## 1. Functional requirements

### 5.1 Workspaces

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-006 workspaces, open all in tabs | delivered | `src/features/workspaces/`, `store/workspaces.rs`, `tests/workspaces.rs`, `e2e/workspaces.spec.ts`; PR #34 (M4-3) | |
| F-007 scan of a parent folder | delivered | `repo/scan.rs` (depth 1 to 8, `node_modules` and nested repos skipped), unit tests of `scan.rs`; PR #34 | |
| F-008 overview, Fetch all | delivered | `WorkspaceOverview`, `lastFetchedAt`; `tests/workspaces.rs`; PR #34 | No grouped cancellation of "Fetch all" (each fetch stays cancellable). |
| F-009 moved / deleted repo | delivered | `MissingRepoDialog.tsx` (relocate / remove); PR #34 | |

### 5.2 Graph

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-028 hide / solo, hide remotes and stashes | delivered | `GraphFilter` (SQLite v5), `tests/graph_tools.rs`, `graphFilter.test.ts`, `e2e/graph-diff-branches.spec.ts`; PR #46 (M4-7b) | Hiding a tag: accepted by the backend, not offered in the sidebar. |
| F-029 diff between two commits | delivered | `compareRevisions`, comparison panel; PR #46 | |
| F-030 quick jumps (HEAD, branch, merge-base) | delivered | `⌘⇧H`, palette, `graph.goToMergeBase`; `tests/graph_tools.rs`; PR #46 | |
| F-033 opt-in Gravatar, disk cache | delivered | `system/avatars.rs` (cache, eviction, negative cache, deduplication; tests with a fake transport), `avatar` and `clearAvatarCache` commands, `features/graph/gravatar.ts`, `gravatar.test.tsx` (no request while disabled), `e2e/graph-diff-branches.spec.ts`; PR #46 (opt-in), M5-2 (disk cache) | The backend downloads (`ureq` + rustls, HTTPS only, no referrer) and keeps the images 7 days in `app_cache_dir` (20 MB / 10,000 entries max, oldest evicted; "no Gravatar" kept 2 days). Images reach the front as `data:` URLs: the CSP no longer contains any remote origin (`img-src 'self' asset: data:`). "Clear the avatar cache" button in Appearance. To be validated with the real network on macOS / Windows. |

### 5.4 Staging and commit

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-066 signing, signed / verified badge | delivered | `signingFailed`, `verifyCommitSignature`, `SignatureBadge.tsx`, `tests/commit_stash.rs` (real SSH signature); PR #43 (M4-7a); graph badge: `signatures` column of the pages, `SignedMark.tsx`, `tests/commit_stash.rs` `graph_pages_carry_the_signature_kind`, `e2e/graph.spec.ts`; M5-1 | In the graph, a padlock on each signed row gives the kind read from the header (GPG, SSH, X.509), **without verification** (gpg / ssh-keygen per row would be too costly); verification stays on demand in the commit detail. |
| F-067 `commit.template`, Conventional Commits | delivered | `conventional.test.ts`, `tests/commit_stash.rs`; PR #43 | Conventional mode not persisted (session state). |
| F-068 recent messages | delivered | SQLite v4 `recent_commit_messages`; PR #43 | |
| F-069 add to `.gitignore` | delivered | `git/ops/gitignore.rs`, `tests/commit_stash.rs` (undo included); PR #43 | |
| F-070 identity and profiles | delivered | `setGitIdentity`, SQLite profiles; PR #43 | No "back to the global identity" action in the profile menu. |

### 5.5 Diff

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-085 binaries (sizes), images side by side / overlay / slider | delivered | `DiffContent::Binary { oldSize, newSize }` (M1-4), `diffImage`, `git/read/image.rs`; PR #46 | |
| F-086 mode, line endings, submodule | delivered | `emptyDiff.test.ts`, diff notices; PR #46 | |
| F-087 editor, file explorer, `diff.tool` | delivered | `runDiffTool`, `revealPath` (`system/editor.rs`), `tests/graph_tools.rs`; PR #46 | |

### 5.6 Branches

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-104 compare two branches | delivered | `Comparison`, `tests/graph_tools.rs`; PR #46 | Global "tip to tip" diff (`git diff B A`), no `B...A` mode. |
| F-105 cleanup of merged / `[gone]` | delivered | `branchCleanup`, `deleteBranches` (one undo entry), `cleanupModel.test.ts`; PR #46 | |

### 5.7 Remotes

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-124 push / pull of tags | delivered | `pushAllTags`, `fetchTags`, `tests/remotes_tags.rs`; PR #42 (M4-7c) | |
| F-125 manage remotes | delivered | `repo/remotes.rs`, `tests/remotes_tags.rs`, `e2e/remotes-tags.spec.ts`; PR #42 | M4-8: URL changes go into the undo. Undoing a removal does not restore `branch.<b>.pushRemote` nor `remote.pushDefault`. |

### 5.8 and 5.9 Interactive rebase, conflicts

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-142 visual interactive rebase | delivered | `repo/interactive.rs`, `tests/interactive_rebase.rs`, `e2e/rebase-interactive.spec.ts`; PR #28 (M3-4) | 200 commits at most, no `--rebase-merges`. |
| F-162 3-way merge editor | delivered | `features/conflicts/`, `e2e/conflicts.spec.ts`, `tests/conflict_scenarios.rs`; PR #26 (M3-3) | |
| F-163 labels with branch names | delivered | `ConflictLabels`; PR #26 | |
| F-164 external merge tool | delivered | `runMergeTool`, `tests/history.rs` (`merge_tool_*`); PR #26 | M4-8: the mock also simulates failure and closing without saving. |
| F-165 delete / modify and binaries | delivered | `tests/conflict_scenarios.rs`; PR #26 | |

### 5.10 and 5.11 Stash, tags

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-182 partial stash | delivered | `stashPushPaths`, `tests/commit_stash.rs` (undo / redo); PR #43 | Git records the whole index in the stash (Git limitation, documented). |
| F-201 delete local / remote, push one tag or all | delivered | `deleteRemoteTag` (M3-5), `pushTag`, `pushAllTags`; `tests/remotes_tags.rs`; PR #42 | M4-8: pushing all tags has its own undo label (`pushTags`). |
| F-202 tag checkout explained | delivered | detached HEAD dialog + branch creation; `e2e/remotes-tags.spec.ts`; PR #42 | |

### 5.12 History, blame, reflog

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-220 `--follow` history with diff | delivered | `git/read/file_history.rs`, `tests/inspect.rs`, `e2e/inspect.spec.ts`; PR #39 (M4-4) | The palette only offers it for the displayed file. |
| F-221 blame by age, blame of the parent | delivered | `git/read/blame.rs`, `blameRows`, `pnpm perf:blame`; PR #39 | |
| F-222 reflog and restoration | delivered | `git/read/reflog.rs`, restoration through `createBranch` / `reset`; PR #39 | M4-8: undo of both restorations tested (`tests/undo.rs`, `reflog_restorations_are_undone`). |

### 5.13 Undo / redo

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-240 undo / redo of the listed operations | delivered | `repo/journal.rs`, `tests/undo.rs` (33 tests), `e2e/undo.spec.ts`; PR #37 (M4-1), #36 (M4-2) | Coverage of the M4 writes: §3 below. In-memory journal (persistence: V2). |
| F-241 `OpJournal` (refs, index, blobs) | delivered | `journal.rs` (`update-ref --stdin`, `write-tree`, `hash-object -w`); PR #37 | |
| F-242 push / fetch prune not undoable, flagged | delivered | `UndoBlock`, grayed button + tooltip; PR #37, #36 | |
| F-243 timestamped session history | delivered | `opHistory`, `e2e/undo.spec.ts`; PR #36 | |

### 5.14 Submodules, worktrees, LFS, terminal

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-260 submodules | delivered | `repo/modules.rs`, `tests/modules.rs`, `e2e/modules.spec.ts`; PR #44 (M4-5) | |
| F-261 worktrees | delivered | `tests/modules.rs`; PR #44 | `lock` / `unlock` / `move` not exposed. |
| F-262 Git LFS | delivered | `git/read/lfs.rs`, `tests/modules.rs`; PR #44 | |
| F-267 integrated terminal | delivered | `system/pty.rs`, `features/terminal/`, `tests/terminal.rs`, `e2e/terminal.spec.ts`; PR #45 (M4-9) | No clickable URLs, no search in the scrollback. |

### 5.15 and 5.17 Keyboard and preferences

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-281 rebindable shortcuts, `keybindings.json` | delivered | `store/keybindings.rs`, `features/keybindings/`, `e2e/m4-6-preferences.spec.ts`; PR #38 (M4-6) | No detection of shortcuts reserved by the OS. |
| F-283 `⌘/` shortcut sheet | delivered | `Mod+/`; PR #38 | On AZERTY, `/` needs Shift: the default shortcut does not fire (it can be rebound). |
| F-320 high contrast (the rest is MVP) | delivered | `contrast` and Terminal themes; PR #38 | |
| F-321 FR / EN language | delivered | `src/i18n/`; M2-6, PR #38 | |
| F-323 editor, terminal, external tools | delivered | Tools tab of the preferences; PR #38, #46 | |
| F-325 Git config editor | delivered | `repo/config.rs`, `tests/git_config.rs`; PR #38 | A multi-valued key cannot be edited in place. |

**Summary**: 44 requirements marked V1, plus the high contrast of F-320 (planned in V1 by M4-6), i.e. 45 rows: 45 delivered, none partial or missing. F-066 moved to "delivered" in M5-1, F-033 in M5-2.

Gap outside `F-xxx`, closed: the spec §8 planned a hand-editable `settings.json`; it now describes what is built (preferences in `yaggui.db`, only `keybindings.json` is a file).

## 2. Major gaps (not handled in M4-8)

1. **F-066, signature badge in the graph.** Done in M5-1: signature kind read by gix from the `gpgsig` (or `gpgsig-sha256`) header already decoded for the row, `signatures` column in the pages, padlock per row. P-02 / P-04 measurements in §4.
2. ~~**F-033, disk cache for avatars.**~~ Handled by M5-2.
3. **Performance outside the target** (details in §4):
   - P-04 at CPU ×4: draw the text columns in the canvas;
   - ~~first opening without commit-graph (P-02 / P-03): incremental topological order~~: done in M5-4 (§4);
   - ~~P-07 in this container: keep the views of recent tabs mounted.~~ Done in M5-3 (§4).

## 3. Undo of the writes added by M4

Each M4 write is either journaled (undoable, or blocked with its reason), or deliberately left out of the journal for the reason given. Writes that are not journaled do not block the undo of what precedes them: the undo only checks what it is about to change.

| Task | Write | Journal entry | Evidence |
|---|---|---|---|
| M4-3 | Create / rename / delete a workspace, add or remove repos, relocate a repo | **Not journaled**: these operations only touch the yaggui database, not Git. Each is undone in one gesture in the same view, and the yaggui undo stays "the Git state of the tab's repo". | — |
| M4-3 | Fetch all | `fetch` (blocked `pruned` with prune; otherwise not journaled, like a single fetch) | `tests/undo.rs` (`push_and_fetch_with_prune_…`) |
| M4-4 | Restore a reflog entry | `createBranch` or `reset` (undoable) | `tests/undo.rs` `reflog_restorations_are_undone` (M4-8) |
| M4-5 | Create / remove a worktree | `createWorktree` / `removeWorktree` (forced removal with losses: blocked `filesDeleted`) | `tests/modules.rs` |
| M4-5 | `worktree prune` | **Not journaled** (forgets folders that are already gone) | `tests/undo.rs` `worktree_prune_is_not_journaled` (M4-8) |
| M4-5 | `lfs track` / `lfs pull`, `submodule update` | `lfsTrack` (undoable); `lfsPull`, `updateSubmodules` (blocked `downloaded`) | `tests/modules.rs` |
| M4-6 | Git config (global or local) | **Not journaled**: it is a setting, not the repo state; the value stays visible and editable in the editor | `tests/undo.rs` `config_changes_are_not_journaled_…` (M4-8) |
| M4-7a | Commit (signed), partial stash, `.gitignore` | `commit`, `stashPush`, `gitignore` (undoable) | `tests/undo.rs`, `tests/commit_stash.rs` |
| M4-7a | Apply an identity profile | **Not journaled** (config, same reason) | `tests/undo.rs` (same test) |
| M4-7b | Branch cleanup | `deleteBranches` (one entry, upstreams restored) | `tests/graph_tools.rs` |
| M4-7b | Hide / solo (graph filter) | **Not journaled** (display preference, SQLite) | — |
| M4-7c | Add / rename / remove a remote; create / delete a local tag | `addRemote`, `renameRemote`, `removeRemote`, `createTag`, `deleteTag` (undoable) | `tests/remotes_tags.rs` |
| M4-7c | Change the URLs of a remote | `setRemoteUrls` (undoable, refused if the URL changed elsewhere) — **added in M4-8** | `tests/undo.rs` `remote_url_changes_…` |
| M4-7c | Push one tag / all tags, delete a remote tag | `push` / `pushTags` (blocked `published`) — `pushTags` **added in M4-8** (dedicated label) | `tests/remotes_tags.rs` |
| M4-7c | Fetch tags | **Not journaled** (like a fetch without prune) | — |
| M4-9 | Integrated terminal | **Not journaled**: what the user types in the shell is outside yaggui, as in an external terminal ("refs moved elsewhere" → `undoDiverged`) | — |

## 4. Performance measurements

Linux container, 4 vCPU, no GPU (headless Chromium for the front). Targets: spec §3. Commands: `CLAUDE.md`.

| ID | Target | M4-8 measurement | Status | Previous reference |
|---|---|---|---|---|
| P-01 cold start | < 800 ms | **600 ms** to the welcome screen (571 to 703 ms), **608 ms** with 1 restored tab (545 to 1,061 ms, the maximum on the first launch); 10 launches, release binary, Xvfb | ✅ | M0: 680 ms (welcome), 633 ms (1 tab) |
| P-02 `git/git` (85,563 commits), first screen | < 300 ms | M5-4: **186 ms** without commit-graph (151 to 186 ms depending on the run), **32 to 36 ms** with | ✅ | M4-8: 40 ms / 692 ms; before M5-4 in the M5-4 container: 28 ms / 844 ms |
| P-03 1.3M commits (synthetic), first screen | < 1.5 s | M5-4: **40 ms** without commit-graph, **26 ms** with; real `torvalds/linux` (1,485,199 commits): **102 ms** without, **51 ms** with | ✅ | M4-8: 730 ms / 7.5 s; before M5-4 in the M5-4 container: 704 ms / 8.1 s (synthetic), 1,032 ms / 13.8 s (linux) |
| P-04 graph scrolling (100k mock, 6,000 px/s) | 60 fps, 0 frame > 32 ms | CPU ×1: 60 fps, p95 16.7 ms, 0.3 % > 20 ms, max 33.3 ms; CPU ×4: 20 fps, p95 83 ms | ✅ at ×1; ×4 outside the target (known) | M1-6 / M3-2: identical |
| P-05 status after a disk change (50,001 files) | < 200 ms | backend **101 ms** (median, max 134) + front 18.5 ms (max 34) | ✅ | M2-7a: ≈ 110 ms |
| P-06 diff of a file < 5k lines | < 100 ms | front 38–61 ms (median), max 96 ms; backend 1.2 ms | ✅ | M1-4: 46–61 ms |
| P-07 tab switch (3 repos) | < 50 ms | M5-3: median **26 to 38 ms** depending on the run (6 runs), p95 34 to 50 ms; CPU ×4: median 148 to 159 ms, p95 213 to 236 ms | ✅ at ×1 (p95 borderline); ×4 outside the target | M4-8: median 53 to 75 ms, p95 65 to 147 ms, ×4 ≈ 300 ms; before M5-3 in the same container: 54 to 56 ms, p95 83 to 86 ms, ×4 271 to 277 ms |
| P-08 palette, 10k refs, per keystroke | < 30 ms | filter + render 7.7 ms (p95 13.7), until the next frame 16.5 ms (p95 21.6); CPU ×4: 35 ms (p95 108) | ✅ | M1-5: median 12.6 ms |
| P-09 RAM, 3 tabs | < 350 MB | not measured (no tooled measurement; to be taken on macOS / Windows, [M4.md](M4.md) §5) | — | — |
| P-10 installer size | < 25 MB | not measured (no bundle in this container); release binary alone, not stripped: 37.9 MB | — | — |

Additional measurement: blame of 20,000 lines (`pnpm perf:blame`) shown in 84 ms and scrolled at 60 fps at CPU ×1 (p95 16.7 ms); at ×4, 282 ms and 30 fps. M4-4 measured 74 ms / 60 fps and 443 ms / 30 fps.

M5-1, signature kind in the graph pages (before → after, same container, binaries and builds alternated):

- **P-02** (`git/git`, 85,563 commits, `graph-bench`): with commit-graph, first screen 24.5 → 25.1 ms (medians over 15 runs), first page of 500 rows 3.3 → 4.0 ms, next page 3.7 → 3.6 ms; without commit-graph, first screen 828 → 772 ms (7 runs, noise of the topological order), first page 3.3 → 3.2 ms. Overhead below the noise: the read walks the extra headers already parsed (usually none), with no allocation for an unsigned commit. Payload: one more integer per row (≈ 1 KB per JSON page).
- **P-04** (linux 100k mock, ≈ 15 % signed commits): CPU ×1, 60 fps, p95 16.7 ms, 0 % > 20 ms before (3 runs) as after (4 runs, one of them with a single 133 ms hitch); CPU ×4, 30 fps median before as after, p95 50 to 67 ms on both sides, script 1,484 to 1,567 ms before, 1,558 to 1,708 ms after (≈ +5 %, within the variance between runs). The padlock is a `<span>` with an SVG icon and a native `title` (no Radix tooltip per row).

### Points outside the target

**P-04 at CPU ×4** (20 fps in Chromium without GPU): unchanged since M1-6. The cost is spread between script, layout and style (6 s of tasks over 6 s at ×4). The next lead, noted in M1-6, is to draw the avatars and the date and SHA columns in the canvas, in addition to the lanes. It is not a small fix, and the measurement on a real machine with a GPU (WKWebView, WebView2) must first say whether it is needed.

**First opening without commit-graph** (P-02: 692 ms, P-03: 7.5 s in M4-8): fixed by M5-4. The topological order is computed incrementally (`graph/topo.rs`): the first page only waits for its rows, a background thread finishes the walk and announces it through the `graph-progress` event (the front shows "Reading the history… N commits" while the total is not exact). The full walk takes as long as before (git/git ≈ 0.7–1 s, synthetic ≈ 9 s, linux ≈ 14 s without commit-graph; 1.4–1.6 s for linux with one), but in the background; only jumps to a commit not reached yet wait for it. The order is identical to `git log --topo-order` over the whole of git/git (with and without commit-graph) and linux (without); it only departs from it, while staying topological, for a commit under more than one year of unread history. If wrong dates mislead the walk (never seen on git/git nor linux, where 832 edges have a parent more recent than the child, by up to 298 days), it detects it and the graph is computed again with a full exploration.

**P-07** (M5-3): until M4-8, each tab switch remounted the tab's `RepoView` (41 ms at M1-6, 48 ms at M3-5, 53 to 75 ms at M4-8 in this container). Since M5-3, the views of the 3 most recent tabs (`KEEP_ALIVE_TABS`, `src/app/tabs/keepAlive.ts`) stay mounted in a React `<Activity>`: hidden, they keep their state and their DOM, but their effects are unmounted (watcher subscriptions, TanStack Query observers, auto-fetch, shortcuts), and they are `hidden` and `inert`. On return, only the queries invalidated while hidden are read again (default `refetchOnMount`, `src/app/tabs/tabSuspension.ts`), and the event-driven refreshes (`useRepoEvent`: worktree diff, blame / histories, comparison, resolved conflict) catch up on the missed events; a tab switch no longer calls any backend command (8 per switch before). The profile also showed a `getComputedStyle` (sidebar row height) that forced a full style recalculation on every display: the value is now read once. What remains: bringing back a view hidden by `display: none` recalculates the style and layout of its ≈ 700 elements (≈ 11 ms at ×1, forced by the virtualizer's measurement), plus reconnecting the effects; this cost makes the ≈ 150 ms at ×4. Hiding with `content-visibility` without `<Activity>` goes down to 23 ms (×4: 55 ms), but leaves the effects of hidden views alive, which M5-3 rules out. Memory, 5 tabs open and each shown once, after GC (`pnpm perf:tabs`, 2nd test): JS heap 95.4 → 97.6 MB (+2.2 MB), DOM nodes 1,267 → 2,814, JS listeners 465 → 548.

## 5. Mock / real gaps fixed in M4-8

Reference: the real backend and its tests. Parity checked by `src/ipc/mock/parity.test.ts` ("M4" block).

| Case | Before | After |
|---|---|---|
| `undoWouldOverwrite` | never produced for a file modified afterwards; when it was, listed every modified file | produced after a discard or a hard reset followed by a modification; only lists the files changed since, like the backend; trigger `window.__yagguiMock.simulateEdit(id, path, text)`; the Playwright test no longer needs to fake the response |
| Reset during an operation | ended any operation (except rebase), accepted `--soft` during a merge | `--soft` during a merge refused (`operationInProgress`, on the backend too, which returned `gitFailed`); a bisect and a cherry-pick sequence stay in progress; reference `tests/history.rs` `reset_during_an_operation_behaves_like_git` |
| Hard reset preview | ignored untracked files | lists the untracked files that the target tracks (`untracked`), and backs them up |
| External merge tool | always succeeded | `mergetool-fails` in the repo path: `mergeToolFailed`; `mergetool-unsaved`: closed without saving, file still in conflict |
| Bisect and `git am` | `op-finished` under `maintenance` / `commit`: generic toast on top of the typed toast | `OpKind` `bisect` and `applyMailbox` (backend and mock), handled like the other history operations |
| "Paused" / "aborted" | set by the front after the IPC response | `OpOutcome::Success { note }` sent by the backend (`paused`, `aborted`) and by the mock |

## 6. V2 requirements (M7-10)

State at the M7-10 PR commit, after M7-1 to M7-9. One row per requirement marked **V2** in the spec §5 and planned in §12; the ones §12 drops (F-010 multiple windows, F-071 co-authors, F-264 patches, F-265 Git Flow, F-303 notifications) are not audited. Same statuses and evidence conventions as §1.

| ID | Status | Evidence | Note |
|---|---|---|---|
| F-244 persistent undo journal | delivered | `store/undo_journal.rs` (migration, 100 entries / 30 days per repo), `repo/journal.rs` (`missing_objects`, `UndoBlock::ObjectsMissing` / `Unreadable`), `tests/undo_persistent.rs` (12 tests: restart for a commit, a branch deletion, a discard, **a fixup and a single stash file** (M7-10), redo after a restart, refs moved while closed, objects pruned by `gc`, age bound, unreadable rows, journal dropped with the repo); front: `undoHistory.test.ts`, `e2e/undo.spec.ts` ("earlier sessions…", "…objects were pruned is refused"); PR #50 (M7-1), #52 (M7-2) | Nothing is written into the repo to keep the backup blobs alive: `git gc` can make an entry unrestorable, which then says so and is never partly applied. Files under `<config>/backups/` are never cleaned. |
| F-147 fixup / autosquash | delivered | `repo/fixup.rs`, `rebase_todo::autosquash` (unit tests), `tests/fixup.rs` (7 tests), `e2e/fixup-autosquash.spec.ts`; PR #53 (M7-3) | Only `fixup!` is arranged; `squash!` / `amend!` stay picks. The automatic base follows first parents and stops at the first merge (200 commits at most). |
| F-185 one file from a stash | delivered | `repo/stash_file.rs`, `tests/stash_file.rs` (11 tests), `e2e/stash-file.spec.ts`; PR #54 (M7-4) | A conflict is journaled and undoable, but the queue reports the operation as a success (see §8, follow-up). A file renamed in the stash: only the new path is applied. |
| F-032 first-parent history | delivered | `GraphFilter.first_parent` (`graph_filters`), `graph/mod.rs`, `tests/graph.rs` (`first_parent_order_matches_git_with_and_without_commit_graph`, `first_parent_layout_snapshot_and_pages`, `first_parent_search_and_jumps_stay_in_the_mode`), `mockGraph.test.ts`, `e2e/first-parent.spec.ts`; PR #55 (M7-5) | Saved with the graph filter (backend) rather than `repo_ui_state`, so the first page is served in the right mode. Bisect, comparisons and merge-base use the full history. P-02 / P-04 below. |
| F-326 preferences import / export | delivered | `store/prefs_sync.rs` and its tests (`store/prefs_sync/tests.rs`), `e2e/m7-6-preferences-sync.spec.ts`, `src/ipc/mock/prefsSync.test.ts`; PR #51 (M7-6) | Machine-specific values (Git path, editor, terminal, diff / merge tools, update answer) are never exported and are listed as left out on import. Identity profiles and templates are not included. A well-formed but unknown action id is accepted. |
| F-223 history of a line range | delivered | `git/read/line_history.rs` (unit tests), `repo/inspect.rs`, `tests/line_history.rs` (9 tests, cancellation included), `e2e/line-history.spec.ts` (stop and search again: M7-10); PR #62 (M7-7) | No per-commit progress (Stop only); moved or copied lines are not followed, like `git log -L`. Started from the blame or a commit diff; no palette entry. |
| F-224 files at a commit | delivered | `git/read/tree.rs`, `repo/tree.rs`, `tests/tree.rs` (8 tests, `tree_bench`), `e2e/commit-tree.spec.ts`; PR #59 (M7-8) | Folders read lazily by pages of 500; text over 1 MB on demand; LFS pointers not downloaded. Flat 100k-entry folder: first page 28 ms (release). |
| F-263 assisted bisect | delivered | `repo/bisect.rs`, `git/read/bisect.rs`, `tests/bisect.rs` (8 tests, interrupted CLI bisect read by a fresh backend included), `bisectModel.test.ts`, `src/ipc/mock/bisect.test.ts`, `e2e/bisect.spec.ts` (reopened bisect and failed checkout: M7-10); PR #61 (M7-9) | Steps are not journaled; ref undos wait for the end of the bisect. No palette entry for good / bad, no `git bisect run`. |

**Summary**: 8 requirements planned for V2, 8 delivered. Bug fix shipped with M7 and validated in [M7.md](M7.md): Git hooks get the `PATH` of the login shell when the app is started from the macOS Dock or Finder (`system/shell_env.rs`, `tests/shell_env.rs`, PR #58).

### Performance in the M7 features

Measured by the M7 PRs, Linux container without GPU.

| ID | Mode | Full graph | First-parent |
|---|---|---|---|
| P-02 `git/git` first screen | without commit-graph | 56.8 ms | 31.9 ms |
| P-02 `git/git` first screen | with commit-graph | 16.9 ms | 18.2 ms |
| P-04 linux mock 100k, CPU ×1 | — | 60 fps, p95 16.7 ms | 60 fps, p95 16.7 ms |
| P-04 linux mock 100k, CPU ×4 | — | median 50.1 ms, p95 116.6 ms | median 50.0 ms, p95 100.0 ms |

`git/git` in first-parent mode has 35,629 rows out of 85,677 commits; the whole first-parent walk takes 332 ms without commit-graph, 21 ms with. Bisect markers are one map lookup per row (P-04 unchanged); tree pages: 19 to 28 ms for a 100k-entry folder.

## 7. Undo of the writes added by M7

| Task | Write | Journal entry | Evidence |
|---|---|---|---|
| M7-3 | Fixup commit | `commit` (`fixup! <summary>`), undoable, kept across restarts | `tests/fixup.rs`, `tests/undo_persistent.rs` `fixup_commit_is_undone_after_a_restart` (M7-10) |
| M7-3 | Autosquash | the interactive rebase (M3-4): not journaled, like any rebase | — |
| M7-4 | One file from a stash, clean or conflicted | `stashApplyFile` (files mode: only the file is checked and restored, undoable during an operation), kept across restarts | `tests/stash_file.rs`, `tests/undo_persistent.rs` `stash_file_apply_is_undone_after_a_restart` (M7-10) |
| M7-5 | First-parent toggle | **Not journaled** (display filter, like hide / solo) | — |
| M7-6 | Preferences import | **Not journaled** (settings, not the repo state); the export file is the backup | — |
| M7-8 | "Save as…" of a version | **Not journaled** (writes outside the repository, after the dialog's overwrite confirmation) | — |
| M7-9 | Bisect marks and steps | **Not journaled**; undo of ref entries refused during a bisect (`operationInProgress`), the way back is "End bisect" | `tests/bisect.rs` |

## 8. Mock / real gaps fixed in M7-10

Reference: the real backend and its tests. Parity checked by `src/ipc/mock/parity.test.ts` ("M7" block) and the Playwright tests named.

| Case | Before | After |
|---|---|---|
| Undo of a files entry (discard, one stash file, `.gitignore`, LFS track) | refused during any operation; compared and restored the whole index and working tree (an unrelated edit refused it), and HEAD | like `Mode::Files`: allowed during an operation, only its files checked and restored, HEAD untouched; diverged refs checked before a dirty worktree; "Nothing to undo." text of the backend |
| One file from a stash | an untracked file "applied" from a stash without untracked files; a file deleted in the stash got made-up content; `refs-changed` emitted; no `status-changed` after a conflict | `invalidArgument` "… is not a file of this stash." (the mock's preview also lists fixture files it holds no content for, so a path missing from a stash made in the session is not refused); deletion applied, unstaged; only `status-changed`, also after a conflict |
| Fixup refused (unknown target, commit off the branch) | before the queue: no `op-finished`, so no toast in the app | in the queue: `op-finished` failed, like `commit_fixup` |
| Bisect | a refused wrong-order mark stayed recorded; checks before the queue; `canSkip` false; `bisectCheckoutFailed` / `awaitingCheckout` unreachable; an interrupted bisect had no marks; marks survived `reset()` | mark checked on a copy; checks in the queue; `canSkip` true; `simulateBisectCheckoutFailure(id)`; `simulateOperation(id, 'bisect', { marks })` (found again on reopen, `e2e/bisect.spec.ts`) |
| Line history, file history, blame | `cancelRead` a no-op, reads instant | `simulateSlowReads(ms)`: reads wait, `cancelRead(token)` ends them `cancelled`, also before they start (`e2e/line-history.spec.ts`); a file not in HEAD refused ("not committed yet"); next pages not re-checked against the line count; version named as requested; `oldLineCount` ≥ 0 |
| Preferences file | `diffOptions` stored as written (extra keys kept, `markdownPreview` missing → a spurious change, negative `contextLines` accepted); a shortcut entry without `shortcut` refused; no 1,000-entry bound; export could not be cancelled | read like the Rust struct; missing shortcut = removed; bound; `setPickedExportPath(null)` (`e2e/m7-6-preferences-sync.spec.ts`) |
| Files at a commit | locale collation; no non-UTF-8 file | code point order of the lowercased names, then the names; `docs/legacy-notes.txt` decoded as Windows-1252 (`e2e/commit-tree.spec.ts`) |
| Forgetting a repository | its graph filter (first-parent included) kept | dropped, like `ON DELETE CASCADE` |

### Closed in M8-3

Parity checked by the "M8-3" block of `src/ipc/mock/parity.test.ts` and the Playwright tests named.

| Case | Before | After |
|---|---|---|
| Line history of working tree lines | the range was taken as HEAD lines | `mapToHead` is a port of `map_to_head` (HEAD → working tree diff without context): changed lines stand for the HEAD lines they replace, added lines are dropped, "These lines are not committed yet" when nothing is left; the cursor keeps the mapped range |
| Line history across commits | the same line numbers in every commit | the range follows lines added or removed above it (`git log -L`): each entry's range after is the range before of the newer one (`e2e/line-history.spec.ts` unchanged) |
| `stashFileMissing` | unreachable | `MockStashState.base` holds HEAD's version of the stashed files; a file of the base that is no longer in the index is refused like `apply_tracked` |
| Bisect marks across a page reload | lost | saved in the mock store (`bisects`, commits by index: the history is regenerated from the repository seed), read back lazily where the bisect is read; ending the bisect forgets them |
| Journal age | no bound | entries older than 30 days are dropped when an entry is appended and when the journal is read back (`simulateRestoredJournal(id, { ageDays })`); the last 100 per repository were already kept |
| `unreadable` journal entries | unreachable | `simulateRestoredJournal(id, { unreadable: true })`: listed, refused with `undoBlocked` `unreadable` (`e2e/undo.spec.ts`) |
| `staleLease` | unreachable | `simulateStaleLease(id)`: the next force push is refused (`e2e/network.spec.ts`) |
| `unsafeRepository` | unreachable | opening a path containing `unsafe-owner` is refused with the `addSafeDirectory` action until `addSafeDirectory` was called (`e2e/shell.spec.ts`) |

Sweep of `src/ipc/bindings.ts` against the mock: the 13 events exist in the mock and are emitted at the same points as in the backend (`journal-changed` after a journaled write and after an undo or redo, `op-finished` for every queued write); every command is implemented (the type checker enforces it). Error codes the mock never produced: `notImplemented`, `gitNotFound`, `pathTooLong`, `storage`, `internal`, `fileManagerFailed`, `avatarUnavailable`. They are environment failures (no `git`, Windows path limit, disk, OS file manager, network) with no screen state of their own beyond the generic error toast; left out on purpose. `updateCheckFailed` is produced through the update failure hook of the mock. This is a sweep of events and error codes, not a line by line review of every command.

### Left as follow-ups

- **Backend**: a conflicted single stash file ends with `op-finished` *success* (`journal_op` cannot journal an entry and report a failure); the full `stash apply` reports *failed*. Needs a `journal_op` variant that records the plan and returns the error as the outcome.
- **Mock**: the stash apply of one file cannot reach "same content on both sides" (`not_in_stash` for a tracked file whose stashed and base versions are equal) because the mock's preview lists fixture files with no content; the line history picks which commits touch a range by hash, not by diffing real file versions; bisect marks of commits made during a session (not in the regenerated history) are dropped on reload.
