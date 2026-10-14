import type { FileDiff } from '../../ipc';

/**
 * Why a text diff has no hunk to show (F-086), so the view says what changed instead of an
 * empty diff: the file mode only, the line endings or whitespace only (hidden by "Ignore
 * whitespace"), the entry type, or nothing at all.
 */
export type EmptyDiffReason =
  | { kind: 'mode'; from: NonNullable<FileDiff['oldMode']>; to: NonNullable<FileDiff['newMode']> }
  | { kind: 'lineEndings' }
  | { kind: 'whitespace' }
  | { kind: 'none' };

export function emptyDiffReason(diff: FileDiff, ignoreWhitespace: boolean): EmptyDiffReason {
  const { oldMode, newMode, content } = diff;
  if (oldMode && newMode && oldMode !== newMode)
    return { kind: 'mode', from: oldMode, to: newMode };
  if (content.kind === 'text' && ignoreWhitespace && diff.oldId !== diff.newId) {
    const { oldLineEnding: before, newLineEnding: after } = content;
    if (before !== 'none' && after !== 'none' && before !== after) return { kind: 'lineEndings' };
    return { kind: 'whitespace' };
  }
  return { kind: 'none' };
}
