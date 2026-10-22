import { confirm } from '../../app/errors/confirmStore';
import { localize, showYagguiError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  unwrap,
  type YagguiError,
  type HistoryResult,
  type MergeMode,
  type OpKind,
  type RepoOperation,
  type RepoState,
  type ResetMode,
  type ResetResult,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { diffKeys } from '../diff/diffQueries';
import { asYagguiError, getGraphSource, invalidateGraph } from '../graph/graphSource';
import { checkout } from '../refs/refOps';
import { shortOid } from '../repo/repoStatus';
import { openHistoryDialog } from './historyDialogsStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

const HISTORY_KINDS: ReadonlySet<OpKind> = new Set<OpKind>([
  'merge',
  'rebase',
  'cherryPick',
  'revert',
  'reset',
  'bisect',
  'applyMailbox',
]);

/** Operations whose outcome (result, conflicts, typed errors) this module reports itself. */
export function isHistoryKind(kind: OpKind): boolean {
  return HISTORY_KINDS.has(kind);
}

export type OperationName = RepoOperation['kind'];

/** Everything an operation can change: refs, graph, status, conflicts and the diffs. */
export function refreshHistory(repoId: number): void {
  invalidateGraph(repoId);
  for (const queryKey of [
    queryKeys.repoRefs(repoId),
    queryKeys.repoState(repoId),
    queryKeys.operationDetail(repoId),
    queryKeys.bisectState(repoId),
    queryKeys.conflicts(repoId),
    diffKeys.worktree(repoId),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** Branch checked out in the repository, from the cached state (`null`: detached or unknown). */
export function currentBranchOf(repoId: number): string | null {
  const state = queryClient.getQueryData<RepoState>(queryKeys.repoState(repoId));
  return state?.head.kind === 'branch' ? state.head.name : null;
}

export function operationOf(repoId: number): RepoOperation | null {
  return queryClient.getQueryData<RepoState>(queryKeys.repoState(repoId))?.operation ?? null;
}

/** Selects the working copy, where the conflicts are listed. */
export function showConflicts(repoId: number): void {
  getGraphSource(repoId).selectWip();
}

type Attempt<T> = { ok: true; data: T } | { ok: false; error: YagguiError };

async function attempt<T>(repoId: number, work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return { ok: false, error: asYagguiError(error) };
  } finally {
    refreshHistory(repoId);
  }
}

function operationName(operation: OperationName | undefined): string {
  return operation ? t(`operation.${operation}.short`) : '';
}

function failureTitle(op: HistoryOp): string {
  return t(`history.failed.${op}`);
}

/** Which operation failed: decides the follow-up offered by the typed errors. */
type HistoryOp =
  'merge' | 'rebase' | 'cherryPick' | 'revert' | 'reset' | 'reword' | 'continue' | 'skip' | 'abort';

export interface FailureContext {
  op: HistoryOp;
  /** Reopens the flow that failed with other parameters. */
  onNotFastForward?: () => void;
  onMainlineRequired?: () => void;
}

/**
 * An operation stopped on conflicts (`conflicts`), whatever started it: a history command or
 * a pull. Says how many files conflict and shows them; the banner and the conflict view
 * follow from `repoState().operation`.
 */
export function reportConflicts(repoId: number, error: YagguiError): void {
  const payload = error.payload?.kind === 'conflicts' ? error.payload : null;
  const count = payload?.paths.length ?? 0;
  toast({
    variant: 'warning',
    title: localize(error.message),
    description: count > 0 ? t('history.conflicts.count', { count }) : undefined,
    action: {
      label: t('history.conflicts.show'),
      onClick: () => {
        showConflicts(repoId);
      },
    },
    duration: 12_000,
  });
  showConflicts(repoId);
}

/**
 * The typed errors of the history commands (F-146, F-160): each one says what happened and
 * offers the next step, instead of a generic failure toast.
 */
export function reportHistoryError(
  repoId: number,
  error: YagguiError,
  context: FailureContext,
): void {
  const message = localize(error.message);
  switch (error.code) {
    case 'conflicts':
      reportConflicts(repoId, error);
      return;
    case 'unresolvedConflicts':
      toast({
        variant: 'warning',
        title: message,
        action: {
          label: t('history.conflicts.show'),
          onClick: () => {
            showConflicts(repoId);
          },
        },
      });
      showConflicts(repoId);
      return;
    case 'mainlineRequired':
      if (context.onMainlineRequired) {
        context.onMainlineRequired();
        return;
      }
      break;
    case 'emptyCommit':
      toast({
        variant: 'warning',
        title: message,
        action: {
          label: t('operation.skip'),
          onClick: () => {
            void skipOperation(repoId);
          },
        },
        duration: 12_000,
      });
      return;
    case 'notFastForward':
      toast({
        variant: 'warning',
        title: message,
        action: context.onNotFastForward
          ? { label: t('history.notFastForward.merge'), onClick: context.onNotFastForward }
          : undefined,
        duration: 12_000,
      });
      return;
    case 'nothingToCommit':
      if (context.op === 'merge' || context.op === 'continue') {
        // A squash whose result is empty stays pending: say why, and offer the way out.
        toast({
          variant: 'warning',
          title: t('history.nothingToCommit.title'),
          description: t('history.nothingToCommit.text'),
          action: { label: t('operation.merge.abort'), onClick: () => void abortOperation(repoId) },
          duration: 12_000,
        });
        return;
      }
      break;
    case 'operationInProgress':
    case 'noOperation':
      toast({ variant: 'warning', title: message, description: t('history.inProgress.hint') });
      return;
    case 'dirtyWorktree': {
      const paths = error.payload?.kind === 'dirtyWorktree' ? error.payload.paths : [];
      toast({
        variant: 'error',
        title: failureTitle(context.op),
        description:
          paths.length > 0
            ? `${message} ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '…' : ''}`
            : message,
        action: {
          label: t('history.dirty.show'),
          onClick: () => {
            showConflicts(repoId);
          },
        },
      });
      return;
    }
    default:
  }
  showYagguiError(error, { title: failureTitle(context.op) });
}

function describeEffect(result: HistoryResult): 'upToDate' | 'fastForward' | 'commits' {
  return result.effect;
}

// --- Merge ---------------------------------------------------------------------------------

export interface MergeParams {
  source: string;
  /** Branch that receives the merge; `null`: the checked-out one. */
  target: string | null;
  mode: MergeMode;
  message: string | null;
}

/**
 * Merges `source` into `target` (F-026: "Merge X into Y"). A target that is not checked out is
 * checked out first, since the backend only merges into the current branch (M3-1).
 */
export async function mergeBranch(repoId: number, params: MergeParams): Promise<boolean> {
  const current = currentBranchOf(repoId);
  const target = params.target ?? current;
  if (params.target !== null && params.target !== current) {
    if (!(await checkout(repoId, { kind: 'branch', name: params.target }))) return false;
  }
  const result = await attempt(repoId, () =>
    unwrap(
      ipc.commands.merge(repoId, {
        source: params.source,
        mode: params.mode,
        message: params.message,
      }),
    ),
  );
  if (!result.ok) {
    reportHistoryError(repoId, result.error, {
      op: 'merge',
      onNotFastForward: () => {
        openHistoryDialog({ kind: 'merge', repoId, source: params.source, target });
      },
    });
    return false;
  }
  const names = { source: params.source, target: target ?? 'HEAD' };
  const effect = describeEffect(result.data);
  if (effect === 'upToDate') {
    toast({ variant: 'info', title: t('history.merge.upToDate', names) });
  } else if (effect === 'fastForward') {
    toast({ variant: 'success', title: t('history.merge.fastForwarded', names) });
  } else if (params.mode === 'squash') {
    toast({ variant: 'success', title: t('history.merge.squashed', names) });
  } else {
    toast({ variant: 'success', title: t('history.merge.done', names) });
  }
  return true;
}

// --- Rebase --------------------------------------------------------------------------------

export interface RebaseParams {
  /** Local branch to rebase; `null`: the checked-out one. */
  branch: string | null;
  onto: string;
}

export function rebaseCommand(params: RebaseParams): string {
  return `git rebase ${params.onto}${params.branch ? ` ${params.branch}` : ''}`;
}

/** Rebases a branch onto another one, after a confirmation (it rewrites the branch's commits). */
export async function rebaseBranch(
  repoId: number,
  params: RebaseParams,
  alreadyConfirmed = false,
): Promise<boolean> {
  const branch = params.branch ?? currentBranchOf(repoId) ?? 'HEAD';
  if (!alreadyConfirmed) {
    const confirmed = await confirm({
      title: t('history.rebase.confirmTitle', { branch, onto: params.onto }),
      description:
        t('history.rebase.confirmText', { branch, onto: params.onto }) +
        (params.branch && params.branch !== currentBranchOf(repoId)
          ? ` ${t('history.rebase.checkoutNote', { branch })}`
          : ''),
      command: rebaseCommand(params),
      confirmLabel: t('history.rebase.confirm'),
    });
    if (!confirmed) return false;
  }
  const result = await attempt(repoId, () =>
    unwrap(ipc.commands.rebase(repoId, { branch: params.branch, onto: params.onto })),
  );
  if (!result.ok) {
    reportHistoryError(repoId, result.error, { op: 'rebase' });
    return false;
  }
  toast({
    variant: result.data.effect === 'upToDate' ? 'info' : 'success',
    title: t(
      result.data.effect === 'upToDate' ? 'history.rebase.upToDate' : 'history.rebase.done',
      { branch, onto: params.onto },
    ),
  });
  return true;
}

// --- Cherry-pick and revert ------------------------------------------------------------------

export interface CherryPickParams {
  /** Commits to apply; the backend orders them by graph position, oldest first. */
  shas: string[];
  /** Branch that receives them; `null`: the checked-out one. */
  target: string | null;
  mainline: number | null;
}

export async function cherryPickCommits(
  repoId: number,
  params: CherryPickParams,
): Promise<boolean> {
  const current = currentBranchOf(repoId);
  if (params.target !== null && params.target !== current) {
    if (!(await checkout(repoId, { kind: 'branch', name: params.target }))) return false;
  }
  const result = await attempt(repoId, () =>
    unwrap(ipc.commands.cherryPick(repoId, { commits: params.shas, mainline: params.mainline })),
  );
  if (!result.ok) {
    reportHistoryError(repoId, result.error, {
      op: 'cherryPick',
      onMainlineRequired: () => {
        openHistoryDialog({
          kind: 'parent',
          repoId,
          op: 'cherryPick',
          shas: params.shas,
          target: params.target,
        });
      },
    });
    return false;
  }
  toast({
    variant: 'success',
    title: t('history.cherryPick.done', {
      count: params.shas.length,
      target: params.target ?? current ?? 'HEAD',
    }),
  });
  return true;
}

export async function revertCommit(
  repoId: number,
  sha: string,
  mainline: number | null,
): Promise<boolean> {
  const result = await attempt(repoId, () =>
    unwrap(ipc.commands.revert(repoId, { commit: sha, mainline })),
  );
  if (!result.ok) {
    reportHistoryError(repoId, result.error, {
      op: 'revert',
      onMainlineRequired: () => {
        openHistoryDialog({ kind: 'parent', repoId, op: 'revert', shas: [sha], target: null });
      },
    });
    return false;
  }
  toast({ variant: 'success', title: t('history.revert.done', { sha: shortOid(sha) }) });
  return true;
}

// --- Reword --------------------------------------------------------------------------------

/**
 * New message for a commit of the current branch: HEAD is amended (its staged changes stay
 * staged), an older commit is reworded by a rebase replaying the commits after it. Resolves to
 * the reworded commit's new SHA, `null` on failure.
 */
export async function rewordCommit(
  repoId: number,
  sha: string,
  message: string,
): Promise<string | null> {
  const result = await attempt(repoId, () =>
    unwrap(ipc.commands.rewordCommit(repoId, sha, message)),
  );
  if (!result.ok) {
    reportHistoryError(repoId, result.error, { op: 'reword' });
    return null;
  }
  toast({
    variant: 'success',
    title: t('history.reword.done', { sha: shortOid(result.data.sha) }),
  });
  return result.data.sha;
}

// --- Reset ---------------------------------------------------------------------------------

export async function resetBranch(
  repoId: number,
  target: string,
  mode: ResetMode,
): Promise<ResetResult | null> {
  const result = await attempt(repoId, () => unwrap(ipc.commands.reset(repoId, { target, mode })));
  if (!result.ok) {
    reportHistoryError(repoId, result.error, { op: 'reset' });
    return null;
  }
  const { backupId } = result.data;
  toast({
    variant: 'success',
    title: t('history.reset.done', {
      mode: t(`history.reset.mode.${mode}`),
      sha: shortOid(target),
    }),
    description: backupId ? t('history.reset.backup') : undefined,
  });
  return result.data;
}

// --- Operation in progress -----------------------------------------------------------------

const DONE_KEYS: Record<OperationName, MessageKey> = {
  merge: 'history.continue.done.merge',
  rebase: 'history.continue.done.rebase',
  cherryPick: 'history.continue.done.cherryPick',
  revert: 'history.continue.done.revert',
  bisect: 'history.continue.done.bisect',
  applyMailbox: 'history.continue.done.applyMailbox',
};

/** Continues the operation in progress; `message` replaces the one Git prepared. */
export async function continueOperation(repoId: number, message: string | null): Promise<boolean> {
  const operation = operationOf(repoId);
  const result = await attempt(repoId, () =>
    unwrap(ipc.commands.continueOperation(repoId, message)),
  );
  if (!result.ok) {
    reportHistoryError(repoId, result.error, { op: 'continue' });
    return false;
  }
  if (await toastIfStillRebasing(repoId)) return true;
  if (operation) toast({ variant: 'success', title: t(DONE_KEYS[operation.kind]) });
  return true;
}

/**
 * A continue or skip that succeeds can leave the rebase in progress: an interactive rebase
 * halts on its next `edit`. Says so instead of "completed"; `false` when nothing is left.
 */
async function toastIfStillRebasing(repoId: number): Promise<boolean> {
  let operation: RepoOperation | null;
  try {
    operation = (await unwrap(ipc.commands.repoState(repoId))).operation;
  } catch {
    return false;
  }
  if (operation?.kind !== 'rebase') return false;
  toast({
    variant: 'info',
    title:
      operation.step !== null && operation.total !== null
        ? t('history.rebase.editStop', { step: operation.step, total: operation.total })
        : t('history.rebase.editStopNoStep'),
    description: t('history.rebase.editStopHint'),
    duration: 8000,
  });
  return true;
}

export async function skipOperation(repoId: number): Promise<boolean> {
  const operation = operationOf(repoId);
  const result = await attempt(repoId, () => unwrap(ipc.commands.skipOperation(repoId)));
  if (!result.ok) {
    reportHistoryError(repoId, result.error, { op: 'skip' });
    return false;
  }
  if (operation?.kind === 'rebase' && (await toastIfStillRebasing(repoId))) return true;
  if (operation)
    toast({
      variant: 'info',
      title: t('history.skip.done', { operation: operationName(operation.kind) }),
    });
  return true;
}

/** Git commands behind each abort, shown in the confirmation (spec §6.6). */
const ABORT_COMMANDS: Record<OperationName, string> = {
  merge: 'git merge --abort',
  rebase: 'git rebase --abort',
  cherryPick: 'git cherry-pick --abort',
  revert: 'git revert --abort',
  bisect: 'git bisect reset',
  applyMailbox: 'git am --abort',
};

/** A squash merge records no MERGE_HEAD: the backend resets instead of `merge --abort`. */
export function abortCommand(operation: RepoOperation): string {
  return operation.kind === 'merge' && operation.squash
    ? 'git reset -q --merge'
    : ABORT_COMMANDS[operation.kind];
}

/** Aborts the operation in progress after a confirmation that says what comes back. */
export async function abortOperation(repoId: number): Promise<boolean> {
  const operation = operationOf(repoId);
  if (!operation) return false;
  const confirmed = await confirm({
    title: t(`operation.${operation.kind}.abortTitle`),
    description: t(`operation.${operation.kind}.abortText`),
    command: abortCommand(operation),
    confirmLabel: t(`operation.${operation.kind}.abort`),
    danger: true,
  });
  if (!confirmed) return false;
  const result = await attempt(repoId, () => unwrap(ipc.commands.abortOperation(repoId)));
  if (!result.ok) {
    reportHistoryError(repoId, result.error, { op: 'abort' });
    return false;
  }
  toast({
    variant: 'info',
    title: t('history.abort.done', { operation: operationName(operation.kind) }),
  });
  return true;
}

/** Opens the continue dialog when Git prepared a message worth editing, else continues. */
export async function startContinue(repoId: number): Promise<void> {
  const operation = operationOf(repoId);
  if (!operation) return;
  const editable =
    operation.kind === 'merge' || operation.kind === 'cherryPick' || operation.kind === 'revert';
  if (editable) {
    openHistoryDialog({ kind: 'continue', repoId });
    return;
  }
  await continueOperation(repoId, null);
}

// --- From the graph selection (palette, keyboard) ------------------------------------------------

/** Cherry-picks the selected commits onto the checked-out branch, oldest first. */
export async function cherryPickSelection(repoId: number): Promise<boolean> {
  const commits = getGraphSource(repoId).commitsToApply();
  if (commits.length === 0) {
    toast({ variant: 'info', title: t('history.selectFirst') });
    return false;
  }
  return cherryPickCommits(repoId, {
    shas: commits.map((c) => c.sha),
    target: null,
    mainline: null,
  });
}

/** Reverts the selected commit (a merge asks for its parent first). */
export async function revertSelection(repoId: number): Promise<boolean> {
  const source = getGraphSource(repoId);
  const primary = source.picks.primary;
  if (!primary) {
    toast({ variant: 'info', title: t('history.selectFirst') });
    return false;
  }
  const parents = source.cache.row(primary.row)?.parents.length ?? 1;
  if (parents > 1) {
    openHistoryDialog({ kind: 'parent', repoId, op: 'revert', shas: [primary.sha], target: null });
    return false;
  }
  return revertCommit(repoId, primary.sha, null);
}

/** Opens the reset dialog on the selected commit. */
export function resetToSelection(repoId: number): void {
  const primary = getGraphSource(repoId).picks.primary;
  if (!primary) {
    toast({ variant: 'info', title: t('history.selectFirst') });
    return;
  }
  openHistoryDialog({ kind: 'reset', repoId, target: primary.sha, label: shortOid(primary.sha) });
}
