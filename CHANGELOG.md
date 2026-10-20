# Changelog

Notable changes of each yaggui release. The app shows this file in its "What's new" view; keep the
entries short and written for users.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
[Semantic Versioning](https://semver.org/). Sections: `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, `Security`. `pnpm release:version <x.y.z>` turns `Unreleased` into the new version.

## [Unreleased]

## [0.6.0] - 2026-10-20

### Added

- Edit the message of the selected commit right from the commit details: click the message, or the
  pencil shown on hover; `Esc` cancels, `Mod+Enter` saves, and the graph stays on the rewritten
  commit (#44).

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
