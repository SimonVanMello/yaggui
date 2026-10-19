import type { ChangelogRelease } from '../bindings';

/** Shaped like the embedded `CHANGELOG.md`: an unreleased section, then versions newest first. */
export const mockChangelog: ChangelogRelease[] = [
  {
    version: null,
    date: null,
    entries: [
      {
        kind: 'feature',
        text: 'Edit an unstaged file right from its diff: changes are marked as you type, `Mod+S` saves (#22).',
      },
      {
        kind: 'feature',
        text: 'Update button for every install channel: AUR, `.deb` and `.rpm` copies update in an integrated terminal (#21).',
      },
      {
        kind: 'fix',
        text: 'Held keys repeat again in the integrated terminal on macOS (#22).',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-16',
    entries: [
      {
        kind: 'feature',
        text: 'Rendered preview of Markdown files in the diff, with their changes highlighted block by block (#17).',
      },
      {
        kind: 'feature',
        text: 'Panel sizes, sidebar sections and graph columns are remembered per repository (#16).',
      },
      {
        kind: 'fix',
        text: 'The Homebrew upgrade command refreshes the tap first, so it finds the new version (#15).',
      },
      {
        kind: 'fix',
        text: 'The last progress lines of a Git command (such as the final rebase step) are no longer lost (#19).',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-14',
    entries: [
      {
        kind: 'feature',
        text: 'Opt-in update check at startup, from the command palette and from Preferences (#14).',
      },
      { kind: 'feature', text: 'Tag button next to Branch in the toolbar (#6).' },
      { kind: 'fix', text: 'Scrollbars no longer draw over popovers on macOS and Linux (#13).' },
      {
        kind: 'other',
        text: 'yaggui is published to the AUR (`yaggui-bin`) and to a Homebrew tap (#4, #7).',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-14',
    entries: [
      { kind: 'feature', text: 'First public release.' },
      {
        kind: 'feature',
        text: 'Commit graph drawn on a canvas, smooth on very large histories.',
      },
      { kind: 'feature', text: 'Staging by file, hunk or line, straight from the diff.' },
    ],
  },
];
