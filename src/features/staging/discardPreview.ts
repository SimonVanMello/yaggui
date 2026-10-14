import type { ConfirmItem } from '../../app/errors/confirmStore';
import type { ChangedFile } from '../../ipc';

/** Files listed in a confirmation; the rest is summarized as "and N more". */
export const PREVIEW_LIMIT = 100;

export interface DiscardPreview {
  items: ConfirmItem[];
  more: number;
  /** Untracked files: discarding deletes them for good (they are not in any commit). */
  deleted: number;
  /** Tracked files whose working tree changes are lost. */
  reverted: number;
}

/**
 * What discarding `files` (working tree changes) does, file by file: untracked files are
 * deleted, tracked ones go back to their staged content. `note` is the localized wording.
 */
export function discardPreview(
  files: readonly ChangedFile[],
  note: (kind: 'delete' | 'revert') => string,
): DiscardPreview {
  const deleted = files.filter((f) => f.status === 'untracked').length;
  return {
    items: files.slice(0, PREVIEW_LIMIT).map((file) => {
      const remove = file.status === 'untracked';
      return {
        label: file.path,
        note: note(remove ? 'delete' : 'revert'),
        danger: remove,
      };
    }),
    more: Math.max(0, files.length - PREVIEW_LIMIT),
    deleted,
    reverted: files.length - deleted,
  };
}
