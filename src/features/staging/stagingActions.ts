import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type ChangedFile,
  type DiffOptions,
  type FileDiff,
  type HunkSelection,
  type PathSelection,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { diffKeys } from '../diff/diffQueries';
import { discardPreview } from './discardPreview';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Index and working tree views are re-read; the watcher does it too, this is just sooner. */
export function refreshWorktree(repoId: number): void {
  void queryClient.invalidateQueries({ queryKey: diffKeys.worktree(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
}

function selection(paths: readonly string[] | 'all'): PathSelection {
  return paths === 'all' ? { kind: 'all' } : { kind: 'paths', paths: [...paths] };
}

/**
 * Reports a failed write. A typed backend error already came with the `op-finished` event,
 * which toasts it (`useBackendEvents`): only anything else is reported here.
 */
export function reportWriteError(error: unknown): void {
  if (!(error instanceof YagguiIpcError)) showError(error);
}

/** Runs a write and returns whether it succeeded. */
async function run(repoId: number, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    reportWriteError(error);
    return false;
  } finally {
    refreshWorktree(repoId);
  }
}

export function stageFiles(repoId: number, paths: readonly string[] | 'all'): Promise<boolean> {
  return run(repoId, () => unwrap(ipc.commands.stagePaths(repoId, selection(paths))));
}

export function unstageFiles(repoId: number, paths: readonly string[] | 'all'): Promise<boolean> {
  return run(repoId, () => unwrap(ipc.commands.unstagePaths(repoId, selection(paths))));
}

/**
 * Discards the working tree changes of `files` after a confirmation listing what will
 * happen to each (untracked files are deleted). `all` discards every unstaged change.
 */
export async function discardFiles(
  repoId: number,
  files: readonly ChangedFile[],
  all: boolean,
): Promise<boolean> {
  if (files.length === 0) return false;
  const preview = discardPreview(files, (kind) => t(`discard.note.${kind}`));
  const summary = [
    preview.reverted > 0 ? t('discard.summary.reverted', { count: preview.reverted }) : null,
    preview.deleted > 0 ? t('discard.summary.deleted', { count: preview.deleted }) : null,
  ]
    .filter(Boolean)
    .join(' ');
  const confirmed = await confirm({
    kind: 'discardChanges',
    title: all ? t('discard.title.all') : t('discard.title', { count: files.length }),
    description: `${summary} ${t('discard.irreversible')}`,
    items: preview.items,
    moreItems: preview.more,
    confirmLabel: t('discard.confirm'),
    danger: true,
  });
  if (!confirmed) return false;
  return run(repoId, () =>
    unwrap(
      ipc.commands.discardPaths(repoId, selection(all ? 'all' : files.map((f) => f.path)), false),
    ),
  );
}

export type HunkAction = 'stage' | 'unstage' | 'discard';

export interface HunkActionRequest {
  repoId: number;
  action: HunkAction;
  diff: FileDiff;
  /** Options of the diff the selection was made on (they decide the hunk ids). */
  options: DiffOptions;
  hunks: HunkSelection[];
  /** Changed lines covered, for the confirmation of a discard. */
  lineCount: number;
}

/**
 * Stages, unstages or discards hunks / lines of the diff on screen, with the blob ids it was
 * read at. A stale diff is refreshed and reported instead of being applied.
 */
export async function applyHunks(request: HunkActionRequest): Promise<boolean> {
  const { repoId, action, diff, options, hunks, lineCount } = request;
  if (hunks.length === 0) return false;
  if (action === 'discard') {
    const confirmed = await confirm({
      kind: 'discardChanges',
      title: t('discard.hunks.title'),
      description: t('discard.hunks.description', { count: lineCount, path: diff.path }),
      items: [{ label: diff.path, note: t('discard.note.revert') }],
      confirmLabel: t('discard.confirm'),
      danger: true,
    });
    if (!confirmed) return false;
  }
  const change = {
    path: diff.path,
    oldPath: diff.oldPath,
    oldId: diff.oldId,
    newId: diff.newId,
    options,
    hunks,
  };
  try {
    if (action === 'stage') await unwrap(ipc.commands.stageHunks(repoId, change));
    else if (action === 'unstage') await unwrap(ipc.commands.unstageHunks(repoId, change));
    else await unwrap(ipc.commands.discardHunks(repoId, change));
    return true;
  } catch (error) {
    if (error instanceof YagguiIpcError && error.error.code === 'staleDiff') {
      toast({
        variant: 'warning',
        title: t('diff.stale.title'),
        description: t('diff.stale.description', { path: diff.path }),
      });
    } else {
      reportWriteError(error);
    }
    return false;
  } finally {
    refreshWorktree(repoId);
  }
}
