import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc } from '../../ipc';
import { toast } from '../../ui/toastStore';
import type { PickedCommit } from '../graph/selectionModel';
import { revealCommit } from '../repo/graphNavigation';
import { shortOid } from '../repo/repoStatus';
import { openCompare } from './compareStore';

const tr = (key: MessageKey, params?: MessageParams) =>
  translate(useI18nStore.getState().locale, key, params);

/**
 * Two commits picked in the graph (F-029), newest first: the comparison shows what the newer
 * one has that the older lacks, and the diff older → newer.
 */
export function compareCommits(repoId: number, picked: readonly PickedCommit[]): void {
  const [newer, older] = picked;
  if (!newer || !older || picked.length !== 2) return;
  openCompare(repoId, {
    a: { rev: newer.sha, label: shortOid(newer.sha) },
    b: { rev: older.sha, label: shortOid(older.sha) },
  });
}

export function compareWithHead(repoId: number, sha: string): void {
  openCompare(repoId, {
    a: { rev: sha, label: shortOid(sha) },
    b: { rev: 'HEAD', label: 'HEAD' },
  });
}

/** Selects and centers the merge-base of `a` and `b` in the graph (F-030). */
export async function jumpToMergeBase(repoId: number, a: string, b: string): Promise<void> {
  const result = await ipc.commands.mergeBase(repoId, a, b);
  if (result.status === 'error') {
    showYagguiError(result.error, { title: tr('graph.mergeBase.failed') });
    return;
  }
  const base = result.data;
  if (base === null) {
    toast({ variant: 'info', title: tr('graph.mergeBase.none') });
    return;
  }
  if (base.row === null) {
    toast({
      variant: 'info',
      title: tr('graph.mergeBase.hidden', { sha: shortOid(base.sha) }),
    });
  }
  revealCommit(repoId, base.sha, base.row, base.version);
}
