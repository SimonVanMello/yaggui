import { confirm } from '../../app/errors/confirmStore';
import { localize, showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap, type BisectMark, type BisectState, type YagguiError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { asYagguiError } from '../graph/graphSource';
import { abortOperation, operationOf, refreshHistory } from '../history/historyOps';
import { stashPush } from '../refs/refOps';
import { revealCommit } from '../repo/graphNavigation';
import { shortOid } from '../repo/repoStatus';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Files listed in the stash confirmation; the rest is counted. */
const LISTED_PATHS = 8;

/** Selects a commit of the bisect in the graph and scrolls to it (its detail opens). */
export function showBisectCommit(repoId: number, sha: string): void {
  revealCommit(repoId, sha, null);
}

async function run(
  repoId: number,
  work: () => Promise<BisectState>,
  retry: () => Promise<boolean>,
): Promise<boolean> {
  let state: BisectState;
  try {
    state = await work();
  } catch (error) {
    refreshHistory(repoId);
    await reportBisectError(repoId, asYagguiError(error), retry);
    return false;
  }
  refreshHistory(repoId);
  const { result } = state;
  if (result?.kind === 'found') {
    const { sha } = result.commit;
    toast({
      variant: 'success',
      title: t('bisect.found.toast', { sha: shortOid(sha) }),
      description: result.commit.summary,
      action: {
        label: t('bisect.showCommit'),
        onClick: () => {
          showBisectCommit(repoId, sha);
        },
      },
      duration: 12_000,
    });
    showBisectCommit(repoId, sha);
  } else if (result?.kind === 'inconclusive') {
    toast({
      variant: 'warning',
      title: t('bisect.inconclusive.toast', { count: result.candidates.length }),
    });
  }
  return true;
}

/**
 * Marks `rev` (HEAD when `null`) good, bad or skipped. Without a bisect in progress, a good or
 * bad mark starts one; Git checks out the next commit to test once both kinds are known.
 */
export function markBisect(repoId: number, rev: string | null, mark: BisectMark): Promise<boolean> {
  const retry = () => markBisect(repoId, rev, mark);
  return run(repoId, () => unwrap(ipc.commands.bisectMark(repoId, rev, mark)), retry);
}

/** Checks out the next commit to test after a step that could not. */
export function bisectNext(repoId: number): Promise<boolean> {
  const retry = () => bisectNext(repoId);
  return run(repoId, () => unwrap(ipc.commands.bisectNext(repoId)), retry);
}

/** Ends the bisect: HEAD goes back to where it started (confirmed first). */
export function endBisect(repoId: number): Promise<boolean> {
  return abortOperation(repoId);
}

/** Whether a bisect is in progress, from the cached repo state. */
export function isBisecting(repoId: number): boolean {
  return operationOf(repoId)?.kind === 'bisect';
}

/**
 * Local changes refuse a step: offers to stash them (tracked files only, untracked files do
 * not stop a bisect) and retries. A checkout that failed after the mark was saved says so.
 */
async function reportBisectError(
  repoId: number,
  error: YagguiError,
  retry: () => Promise<boolean>,
): Promise<void> {
  if (error.code === 'dirtyWorktree' && error.payload?.kind === 'dirtyWorktree') {
    const { paths } = error.payload;
    const stash = await confirm({
      title: t('bisect.dirty.title'),
      description: localize(error.message),
      command: 'git stash push',
      confirmLabel: t('bisect.dirty.stash'),
      items: paths.slice(0, LISTED_PATHS).map((label) => ({ label })),
      moreItems: Math.max(0, paths.length - LISTED_PATHS),
    });
    if (!stash) return;
    const stashed = await stashPush(repoId, {
      message: t('bisect.dirty.stashMessage'),
      includeUntracked: false,
      keepIndex: false,
    });
    if (stashed.ok) await retry();
    return;
  }
  if (error.code === 'bisectCheckoutFailed') {
    const paths = error.payload?.kind === 'dirtyWorktree' ? error.payload.paths : [];
    toast({
      variant: 'warning',
      title: localize(error.message),
      description: paths.length > 0 ? paths.slice(0, LISTED_PATHS).join(', ') : undefined,
      detail: error.detail ?? undefined,
      duration: 12_000,
    });
    return;
  }
  showYagguiError(error, { title: t('bisect.failed') });
}
