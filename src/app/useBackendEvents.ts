import { graphWalkProgress, invalidateGraph } from '../features/graph/graphSource';
import { invalidateRemoteTags, relistRemoteTags } from '../features/graph/remoteTags';
import { useOpsStore } from '../features/repo/opsStore';
import { useRepoSessions } from '../features/repo/repoSessions';
import { translate, useI18nStore } from '../i18n/i18n';
import type { CommandLogEntry, YagguiError, OpKind } from '../ipc';
import { useYagguiEvent } from '../ipc/useYagguiEvent';
import { toast } from '../ui/toastStore';
import { isHistoryKind } from '../features/history/historyOps';
import { isRefUiError } from '../features/refs/refErrors';
import { invalidateJournal } from '../features/undo/undoQueries';
import { showYagguiError } from './errors/presentError';
import { queryClient, queryKeys } from './queryClient';

/** Same bound as a reasonable backend log, so a long session does not grow memory forever. */
const MAX_LOG_ENTRIES = 2000;

function opLabel(kind: OpKind): string {
  return translate(useI18nStore.getState().locale, `op.${kind}`);
}

/** Maintenance the user did not ask for: no busy indicator, no toast (still in the command log). */
function isBackgroundOp(kind: OpKind): boolean {
  return kind === 'commitGraph';
}

/** Writes whose success is visible in the lists (or toasted by the UI itself): no toast. */
function isQuietWrite(kind: OpKind): boolean {
  return (
    kind === 'stage' ||
    kind === 'discard' ||
    kind === 'commit' ||
    kind === 'checkout' ||
    kind === 'branch' ||
    kind === 'stash' ||
    kind === 'tag' ||
    kind === 'remote' ||
    // Undo and redo toast "Undone: …" themselves, with what they undid.
    kind === 'undo' ||
    kind === 'redo' ||
    isHistoryKind(kind) ||
    // The conflict view toasts whether the tool resolved the file.
    kind === 'mergeTool' ||
    // The file editor shows the save.
    kind === 'editFile' ||
    isNetworkOp(kind)
  );
}

/** Fetch, pull and push: the caller toasts the result, with actions only it can offer. */
function isNetworkOp(kind: OpKind): boolean {
  return kind === 'fetch' || kind === 'pull' || kind === 'push';
}

/** Failures the staging UI presents on its own (hook panel, identity form, refreshed diff). */
function shownInline(kind: OpKind, error: YagguiError): boolean {
  // Merge, rebase, cherry-pick, revert, reset: conflicts and typed errors get their own toast.
  if (isHistoryKind(kind)) return true;
  // A pull stopped on conflicts is reported like a merge or rebase stopped on them.
  if (kind === 'pull' && error.code === 'conflicts') return true;
  // The conflict view reports the external tool's failures (`conflictOps.runMergeTool`).
  if (kind === 'mergeTool') return true;
  // The file editor reports a failed save (and reloads a file changed on disk).
  if (kind === 'editFile') return true;
  // The remote dialogs show their errors next to the field; a removal toasts its own.
  if (kind === 'remote') return true;
  // Undo and redo explain their refusals (blocked, diverged, local changes) themselves.
  if (kind === 'undo' || kind === 'redo') return true;
  if (kind === 'checkout' || kind === 'branch' || kind === 'stash' || kind === 'tag') {
    return isRefUiError(error);
  }
  if (kind === 'commit') return error.code === 'hookFailed' || error.code === 'identityUnknown';
  return (kind === 'stage' || kind === 'discard') && error.code === 'staleDiff';
}

/** The banner and the conflict list follow the repo state: no polling, no global render. */
function invalidateOperation(repoId: number): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.operationDetail(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.bisectState(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.conflicts(repoId) });
}

function repoName(repoId: number): string | null {
  const session = useRepoSessions.getState().sessions[repoId];
  if (session?.status === 'open') return session.info.name;
  return session?.name ?? null;
}

/**
 * Wires backend events to the caches: targeted invalidation per repository (no global
 * re-render on watcher events), live command log, operation progress and result toasts.
 */
export function useBackendEvents(): void {
  useYagguiEvent('statusChanged', ({ repoId }) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
    invalidateOperation(repoId);
  });
  useYagguiEvent('refsChanged', ({ repoId }) => {
    invalidateGraph(repoId);
    void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
    invalidateOperation(repoId);
    void queryClient.invalidateQueries({ queryKey: queryKeys.repoRefs(repoId) });
    void queryClient.invalidateQueries({ queryKey: ['commit-detail', repoId] });
    invalidateRemoteTags(repoId);
    // A ref moved outside yaggui can make the next undo `diverged`.
    void queryClient.invalidateQueries({ queryKey: queryKeys.undoState(repoId) });
  });
  useYagguiEvent('graphProgress', graphWalkProgress);
  useYagguiEvent('journalChanged', ({ repoId }) => {
    invalidateJournal(repoId);
  });
  useYagguiEvent('commandLogged', ({ entry }) => {
    queryClient.setQueryData<CommandLogEntry[]>(queryKeys.commandLog, (log) =>
      log ? [...log, entry].slice(-MAX_LOG_ENTRIES) : log,
    );
  });
  useYagguiEvent('opStarted', ({ repoId, opId, kind, cancellable }) => {
    if (isBackgroundOp(kind)) return;
    useOpsStore.getState().started({ repoId, opId, kind, cancellable });
  });
  useYagguiEvent('opProgress', ({ opId, phase, percent, bytes, bytesPerSec }) => {
    useOpsStore.getState().progress(opId, { phase, percent, bytes, bytesPerSec });
  });
  useYagguiEvent('opFinished', ({ repoId, opId, kind, outcome }) => {
    if (isBackgroundOp(kind)) {
      // Same commits, read from the new commit-graph: the backend already rebuilt the graph.
      if (kind === 'commitGraph' && outcome.kind === 'success') invalidateGraph(repoId);
      return;
    }
    // A failure the UI explains in a dialog is not an error state for the status bar.
    const handled = outcome.kind === 'failed' && shownInline(kind, outcome.error);
    const note = outcome.kind === 'success' ? (outcome.note ?? undefined) : undefined;
    useOpsStore
      .getState()
      .finished(
        repoId,
        { opId, kind, outcome: outcome.kind, finishedAt: Date.now(), note },
        !handled,
      );

    void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
    invalidateOperation(repoId);
    // Even a failed push may have sent some tags (`tagRejected` lists only the refused ones).
    if (isNetworkOp(kind) && outcome.kind !== 'cancelled') relistRemoteTags(repoId);
    const locale = useI18nStore.getState().locale;
    const name = repoName(repoId);
    const params = { op: opLabel(kind), repo: name ?? '' };
    if (outcome.kind === 'success') {
      if (isQuietWrite(kind)) return;
      toast({
        variant: 'success',
        title: translate(locale, 'op.toast.success', params),
        description: name ?? undefined,
      });
    } else if (outcome.kind === 'cancelled') {
      toast({ variant: 'info', title: translate(locale, 'op.toast.cancelled', params) });
    } else if (!shownInline(kind, outcome.error) && !isNetworkOp(kind)) {
      showYagguiError(outcome.error, { title: translate(locale, 'op.toast.failed', params) });
    }
  });
}
