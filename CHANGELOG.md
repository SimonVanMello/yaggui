# Changelog

Notable changes of each yaggui release. The app shows this file in its "What's new" view; keep the
entries short and written for users.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
[Semantic Versioning](https://semver.org/). Sections: `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, `Security`. `pnpm release:version <x.y.z>` turns `Unreleased` into the new version.

## [Unreleased]

## [0.8.0] - 2026-10-26

### Added

- Bisect from the palette: "Bisect: mark as good", "mark as bad", "skip the commit under test" and
  "end and go back to the start"; during a bisect they act on the commit under test (#72).
- "History of the selected lines" in the palette, after a selection in the blame or a commit diff
  (#72).
- Autosquash also arranges `squash!` and `amend!` commits, the way `git rebase --autosquash` does:
  a `squash!` adds its message, an `amend!` replaces it (#72).
- Bisect along first parents: with first-parent mode on, a bisect started from the graph only
  tests commits of the main line, shown by a "First parent" tag in the banner (#72).

### Changed

- Dragging a branch onto another one offers the fast-forward of whichever branch is behind: to
  bring `develop` up to a branch ahead of it, drop `develop` on that branch, or that branch on
  `develop`. The fast-forward no longer checks out the moved branch, and is disabled with the
  reason when the branches have diverged or nothing would move (#74).
- Old undo backups are cleaned at startup, with the same bounds as the undo history (the last 100
  of each repository, up to 30 days); a backup that an undoable operation still needs is always
  kept (#72).

### Fixed

- Files opened from "Browse files at this commit", and the file editor of the diff, now show their
  syntax colors: the highlighting was computed but its colors were only defined for the diff and
  the merge editor (#75).
- Applying a single file from a stash that ends in a conflict is now reported as failed in the
  status bar; the undo stays available (#70).
- Skipping during a bisect when only skipped commits are left now ends the bisect with an
  inconclusive result instead of an error (#70).

## [0.7.0] - 2026-10-23

### Added

- Undo history kept across restarts: `Mod+Z` still undoes the last operations after you quit and
  reopen yaggui (the last 100 of each repository, up to 30 days), listed under "Earlier sessions"
  in the history; an operation that can no longer be restored, because a branch moved or Git
  pruned what it needs, says why and is never partly applied (#50, #52).
- Files at a commit: browse the folders and files of any commit (commit details, graph menu or
  palette), read a file read-only with syntax highlighting, and jump to its history or blame at
  that commit. "Save as…" writes that version of the file to disk without ever replacing a file
  silently. Binary files, large texts, LFS pointers, symbolic links and submodules each get their
  own view (#59).
- Fixup commits: "Create a fixup for this commit" in the commit menu and the palette commits the
  staged changes as `fixup! <summary>`, undoable like a commit; "Autosquash" opens the interactive
  rebase with the fixups already under their targets, to review before running it (#53).
- Export your preferences and custom shortcuts to one JSON file, and import it on another machine
  (Preferences dialog or command palette). The import lists what changes before applying anything;
  the Git path, editor, terminal and diff/merge tools stay specific to each machine (#51).
- Apply a single file of a stash from the stash details (hover button or right-click), tracked or
  untracked: the stash is kept, a conflict is explained like for a whole stash, and the operation
  can be undone (#54).
- First-parent history in the graph: each branch's main line only, merges without the commits
  they brought in. Toggle it from the toolbar, the palette or `Mod+Alt+R`; it is kept per
  repository, and search and jumps follow it (#55).
- Assisted bisect: mark a commit good or bad from its menu in the graph to start, then mark each
  commit yaggui checks out from the banner (good, bad or skip) while it shows the steps left;
  markers in the graph, the first bad commit at the end, and a bisect started in a terminal or
  left open is picked up again (#61).
- History of a range of lines (`git log -L`): select lines in the blame (Shift-click) or in a
  commit diff (gutter), then "History of lines": every commit that changed them, with its change to
  those lines, followed across renames; the search can be stopped on long histories (#62).

### Fixed

- Git hooks that call `npx`, `node` or other tools installed with Homebrew, nvm or Volta failed
  with "command not found" when yaggui was started from the Dock or Finder: Git, its hooks and the
  editor and terminal yaggui opens now get the `PATH` of the login shell, read in the background at
  startup (#58).

## [0.6.0] - 2026-10-20

### Added

- Edit the message of the selected commit right from the commit details: click the message, or the
  pencil shown on hover; `Esc` cancels, `Mod+Enter` saves, and the graph stays on the rewritten
  commit (#44).

### Changed

- Checking out a remote branch (double-click on its label in the graph or the sidebar) brings an
  existing local branch that is behind it up to it, without fetching; one with commits of its own
  is left as it is (#46).

### Fixed

- Stash labels in the graph and the commit details show the stash's message instead of
  `stash@{0}` (#44).
- Fast scrolling in the commit graph and in the split diff no longer shows blank strips, and both
  diff columns stay aligned while scrolling (#42).

## [0.5.0] - 2026-10-20

### Added

- Right-click a branch or tag label in the commit graph for the same menu as in the sidebar: push a
  tag, delete it, rename or push a branch… (#40).
- Edit the message of a commit from its menu in the graph: the last commit is amended (staged
  changes are left out, undoable), an older one of the current branch is rewritten by a rebase
  (#40).

### Security

- Credentials embedded in remote URLs (`https://user:token@…`) are masked in the command log, in
  error details and in the remote and submodule dialogs (#34).

## [0.4.0] - 2026-10-19

### Added

- Edit an unstaged file right from its diff: changes are marked as you type, `Mod+S` saves, and a
  file changed on disk meanwhile is never overwritten silently (#22).
- Update button for every install channel: AUR, `.deb` and `.rpm` copies update in an integrated
  terminal (the package is checked against the release checksums first), and the Homebrew cask now
  updates itself like the `.dmg` (#21).
- "What's new" view with this changelog, opened from the installed version in the status bar, the
  command palette, Preferences or the Help menu on macOS (#24).

### Fixed

- A long repository name or path wraps inside the tab tooltip instead of running past its edge (#26).
- Held keys repeat again in the integrated terminal on macOS (holding `j` in vim moves more than one
  line) (#22).
- Welcome screen: the highlighted repository row keeps its border and no longer stays highlighted
  after the pointer leaves (#22).
- Discarding, staging or reverting the file whose diff is open closes the diff instead of showing a
  "no changes" error (#23).

## [0.3.0] - 2026-10-16

### Added

- Rendered preview of Markdown files in the diff, with their changes highlighted block by block
  (#17).
- Panel sizes, sidebar sections and graph columns are remembered per repository (#16).

### Fixed

- The Homebrew upgrade command refreshes the tap first, so it finds the new version (#15).
- The last progress lines of a Git command (such as the final rebase step) are no longer lost (#19).

## [0.2.0] - 2026-10-14

### Added

- Opt-in update check at startup, from the command palette and from Preferences, with in-app update
  where the install allows it (#14).
- Open the repository folder in the file manager from the toolbar (#11).
- Tag button next to Branch in the toolbar (#6).
- Ref pills in the graph adapt their width and shorten long names in the middle (#10).
- Clicking the file of the open diff again closes the diff (#5).

### Fixed

- Scrollbars no longer draw over popovers on macOS and Linux (#13).

### Changed

- yaggui is published to the AUR (`yaggui-bin`) and to a Homebrew tap (#4, #7).

## [0.1.0] - 2026-10-14

### Added

- First public release.
- Commit graph drawn on a canvas, smooth on very large histories; drag a branch onto another to
  merge or rebase.
- Staging by file, hunk or line, straight from the diff.
- Diff and 3-way merge editor: unified or side by side, intra-line highlighting, image diffs.
- Visual interactive rebase: reorder, squash, reword and drop by drag and drop or keyboard.
- Undo and redo for local operations.
- Workspaces to group repositories, open them as tabs and fetch them all.
- Blame, file history and reflog; submodules, worktrees and Git LFS.
- Integrated terminal, command palette and rebindable shortcuts.
- Graphite, Paper, high contrast and Terminal themes; English and French.
- Installers for macOS, Windows and Linux (#1).
