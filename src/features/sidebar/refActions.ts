import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { ipc } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { revealCommit, useGraphNavigation } from '../repo/graphNavigation';
import { targetCommit, type RefTarget } from './sidebarRows';

/**
 * Selects the commit of a ref and scrolls the graph to it. When the row is unknown (graph not
 * computed yet, worktree HEAD…), the commit is selected at once and its row resolved with
 * `graphIndexOf`. Returns `false` when the ref has no commit in this repository.
 */
export function revealRef(repoId: number, target: RefTarget, graphVersion: number | null): boolean {
  const commit = targetCommit(target);
  if (!commit) return false;
  const { sha, row } = commit;
  if (row !== null && graphVersion !== null) {
    revealCommit(repoId, sha, row, graphVersion);
    return true;
  }
  useGraphNavigation.getState().selectCommit(repoId, sha);
  void ipc.commands.graphIndexOf(repoId, sha).then((result) => {
    // Another commit was selected meanwhile: that one wins.
    if (useGraphNavigation.getState().selected[repoId] !== sha) return;
    if (result.status === 'ok') revealCommit(repoId, sha, result.data.row, result.data.version);
    else revealCommit(repoId, sha, null, null);
  });
  return true;
}

export function copyText(text: string, what: string): void {
  const t = (key: MessageKey, params?: Record<string, string>) =>
    translate(useI18nStore.getState().locale, key, params);
  navigator.clipboard.writeText(text).then(
    () => {
      toast({ variant: 'success', title: t('sidebar.copied', { what }), description: text });
    },
    () => {
      toast({ variant: 'error', title: t('sidebar.copyFailed') });
    },
  );
}
