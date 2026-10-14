import { useState } from 'react';

import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type YagguiError,
  type InteractiveRebasePlan,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { openConflictView } from '../conflicts/conflictViewStore';
import { shortSha } from '../diff/format';
import { leaveRebase, refreshAfterRebase } from './rebaseOps';
import { firstRewritten, rewrittenPushed, toTodo, type RebaseRow } from './rebaseModel';
import { setRebaseStop } from './rebaseStore';

export type RebaseStep = 'start' | 'continue' | 'skip' | 'abort';

/**
 * Runs the rebase and drives it afterwards (F-142): start, then continue / skip / abort when
 * it stops on an `edit` or on conflicts. The progress of the Git command itself reaches the
 * status bar through the operation events.
 */
export function useRebaseRun(repoId: number, tabId: string) {
  const t = useT();
  const [busy, setBusy] = useState<RebaseStep | null>(null);
  const [error, setError] = useState<YagguiError | null>(null);

  /** Leaves the view and says how the rebase ended: history operations get no generic
   * `op-finished` toast. */
  const finish = (aborted: boolean, branch: string) => {
    leaveRebase(repoId);
    toast({
      variant: 'success',
      title: t(aborted ? 'rebaseInteractive.aborted' : 'rebaseInteractive.done', { branch }),
      duration: 4000,
    });
  };

  /** What follows a command that ran to its end: finished, or halted on the next `edit`. */
  const afterRun = async (branch: string) => {
    const state = await unwrap(ipc.commands.repoState(repoId));
    const operation = state.operation;
    if (operation?.kind !== 'rebase') {
      finish(false, branch);
      return;
    }
    const head = state.head.kind === 'detached' ? state.head.oid : '';
    const detail = head ? await unwrap(ipc.commands.commitDetail(repoId, head)) : null;
    setRebaseStop(repoId, {
      kind: 'edit',
      commit: { sha: head, summary: detail?.summary ?? '' },
      step: operation.step,
      total: operation.total,
    });
  };

  const run = async (step: RebaseStep, work: () => Promise<void>) => {
    setBusy(step);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (cause instanceof YagguiIpcError) {
        const { code } = cause.error;
        if (code === 'conflicts') {
          setRebaseStop(repoId, { kind: 'conflicts' });
          // Straight to the 3-way editor (M3-3) on the first file; the panel stays behind it.
          const { payload } = cause.error;
          const first = payload?.kind === 'conflicts' ? payload.paths[0] : undefined;
          if (first !== undefined) void openConflictView(tabId, { repoId, path: first });
        } else if (code !== 'cancelled') setError(cause.error);
      } else {
        showError(cause);
      }
    } finally {
      setBusy(null);
      refreshAfterRebase(repoId);
    }
  };

  const start = async (plan: InteractiveRebasePlan, rows: readonly RebaseRow[]) => {
    const pushed = rewrittenPushed(rows, plan);
    const rewritten = rows.length - firstRewritten(rows, plan);
    const target = plan.upstream ?? '';
    const confirmed = await confirm({
      title: t('rebaseInteractive.confirm.title', { count: rewritten, branch: plan.branch }),
      description:
        pushed.length === 0
          ? t('rebaseInteractive.confirm.description', { count: rewritten, branch: plan.branch })
          : t('rebaseInteractive.confirm.pushed', {
              count: pushed.length,
              target,
              branch: plan.branch,
            }),
      command: `git rebase -i ${shortSha(plan.base.sha)}`,
      confirmLabel: t('rebaseInteractive.start'),
      danger: pushed.length > 0,
      items: pushed.map((commit) => ({
        label: `${shortSha(commit.sha)} ${commit.summary}`,
        note: t('rebaseInteractive.confirm.pushedNote', { target }),
        danger: true,
      })),
    });
    if (!confirmed) return;
    await run('start', async () => {
      const result = await unwrap(
        ipc.commands.interactiveRebase(repoId, plan.base.sha, toTodo(rows)),
      );
      if (result.stopped) {
        setRebaseStop(repoId, {
          kind: 'edit',
          commit: result.stopped.commit,
          step: result.stopped.step,
          total: result.stopped.total,
        });
      } else {
        finish(false, plan.branch);
      }
    });
  };

  const goOn = (step: 'continue' | 'skip', branch: string) =>
    run(step, async () => {
      if (step === 'continue') await unwrap(ipc.commands.continueOperation(repoId, null));
      else await unwrap(ipc.commands.skipOperation(repoId));
      await afterRun(branch);
    });

  const abort = (branch: string) =>
    run('abort', async () => {
      await unwrap(ipc.commands.abortOperation(repoId));
      finish(true, branch);
    });

  const clearError = () => {
    setError(null);
  };

  return { busy, error, clearError, start, goOn, abort };
}
