import { queryClient, queryKeys } from '../../app/queryClient';
import type { MessageKey } from '../../i18n/i18n';
import type { BisectMark, BisectState } from '../../ipc';
import { operationOf } from '../history/historyOps';
import type { PaletteAction } from '../palette/actionRegistry';
import { useGraphNavigation } from '../repo/graphNavigation';
import { activeRepoId } from '../repo/repoSessions';
import { endBisect, isBisecting, markBisect } from './bisectOps';
import { bisectPhase, canMarkCurrent } from './bisectModel';

/**
 * What a mark from the palette applies to: during a bisect, the commit under test (HEAD, as
 * the banner's buttons); otherwise the commit selected in the graph, which starts one (as its
 * menu). `null` with the reason when there is none.
 */
export function bisectMarkTarget(
  mark: BisectMark,
): { repoId: number; rev: string | null } | { reason: MessageKey } {
  const repoId = activeRepoId();
  if (repoId === null) return { reason: 'palette.disabled.noRepo' };
  if (isBisecting(repoId)) {
    const state = queryClient.getQueryData<BisectState | null>(queryKeys.bisectState(repoId));
    // Not loaded yet: the backend decides.
    if (state && !canMarkCurrent(bisectPhase(state))) {
      return { reason: 'palette.disabled.bisectNoCommit' };
    }
    return { repoId, rev: null };
  }
  if (mark === 'skip') return { reason: 'palette.disabled.noBisect' };
  if (operationOf(repoId) !== null) return { reason: 'palette.disabled.operationRunning' };
  const selected = useGraphNavigation.getState().selected[repoId];
  if (!selected) return { reason: 'palette.disabled.noCommit' };
  return { repoId, rev: selected };
}

function markAction(mark: BisectMark, title: MessageKey): PaletteAction {
  const target = () => bisectMarkTarget(mark);
  return {
    id: `git.bisect.${mark}`,
    title,
    group: 'git',
    enabled: () => !('reason' in target()),
    disabledReason: () => {
      const result = target();
      return 'reason' in result ? result.reason : 'palette.disabled.unavailable';
    },
    run: () => {
      const result = target();
      if (!('reason' in result)) void markBisect(result.repoId, result.rev, mark);
    },
  };
}

const bisectRepo = () => {
  const repoId = activeRepoId();
  return repoId !== null && isBisecting(repoId) ? repoId : null;
};

/** Palette actions of the assisted bisect (F-263); ids are public, never renamed. */
export const BISECT_ACTIONS: readonly PaletteAction[] = [
  markAction('good', 'palette.action.bisect.good'),
  markAction('bad', 'palette.action.bisect.bad'),
  markAction('skip', 'palette.action.bisect.skip'),
  {
    id: 'git.bisect.reset',
    title: 'palette.action.bisect.reset',
    group: 'git',
    enabled: () => bisectRepo() !== null,
    disabledReason: () =>
      activeRepoId() === null ? 'palette.disabled.noRepo' : 'palette.disabled.noBisect',
    run: () => {
      const repoId = bisectRepo();
      if (repoId !== null) void endBisect(repoId);
    },
  },
];
