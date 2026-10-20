import { confirm } from '../../app/errors/confirmStore';
import { localize, showError, showYagguiError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type BranchStart,
  type CheckoutMode,
  type CheckoutTarget,
  type CreateTagRequest,
  type DeleteBranchRequest,
  type DeleteBranchResult,
  type YagguiError,
  type StashId,
  type StashPushRequest,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { diffKeys } from '../diff/diffQueries';
import { shortOid } from '../repo/repoStatus';
import { pushRecent } from '../sidebar/sidebarUiState';
import { openRefDialog } from './refDialogsStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Outcome of a ref write. `handled`: a global flow (conflict dialog, stale warning) took over. */
export type RefResult<T = null> =
  { ok: true; data: T } | { ok: false; error: YagguiError; handled: boolean };

function internalError(error: unknown): YagguiError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal',
    message: { en: message, fr: message },
    action: null,
    detail: null,
    payload: null,
  };
}

/** Lists, repo state and the worktree views change with every ref write; the watcher is slower. */
export function refreshRefs(repoId: number): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoRefs(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
  void queryClient.invalidateQueries({ queryKey: diffKeys.worktree(repoId) });
}

/** Errors every caller treats the same way: the conflict explanation and the stale-list warning. */
function handleGlobal(repoId: number, error: YagguiError): boolean {
  if (error.code === 'staleRefs') {
    refreshRefs(repoId);
    toast({
      variant: 'warning',
      title: t('refs.stale.title'),
      description: t('refs.stale.description'),
    });
    return true;
  }
  if (error.payload?.kind === 'stashConflict') {
    openRefDialog({
      kind: 'stashConflict',
      repoId,
      paths: error.payload.paths,
      checkedOut: error.payload.checkedOut,
    });
    return true;
  }
  return false;
}

/** Toast for an error that no dialog shows inline. */
export function reportRefError(error: YagguiError): void {
  if (error.code === 'nothingToStash') {
    toast({ variant: 'info', title: t('refs.stash.nothing') });
  } else {
    showYagguiError(error);
  }
}

async function call<T>(repoId: number, work: () => Promise<T>): Promise<RefResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    const typed = error instanceof YagguiIpcError ? error.error : null;
    if (!typed) showError(error);
    const yaggui = typed ?? internalError(error);
    return { ok: false, error: yaggui, handled: typed ? handleGlobal(repoId, typed) : true };
  } finally {
    refreshRefs(repoId);
  }
}

/** Like `call`, for actions without an inline error area: failures are reported here. */
async function callAndReport<T>(repoId: number, work: () => Promise<T>): Promise<RefResult<T>> {
  const result = await call(repoId, work);
  if (!result.ok && !result.handled) reportRefError(result.error);
  return result;
}

function rememberBranch(repoId: number, name: string): void {
  const store = useTabsStore.getState();
  const tab = store.tabs.find((candidate) => candidate.repoId === repoId);
  if (tab) store.updateSidebar(tab.id, (sidebar) => pushRecent(sidebar, name));
}

function targetLabel(target: CheckoutTarget): string {
  return target.kind === 'detached' ? shortOid(target.rev) : target.name;
}

/**
 * Checks out a branch, a remote branch (local tracking branch created when missing, F-045) or
 * a revision. With local changes in the way, the backend refuses (`clean`) and the dirty-tree
 * dialog (F-102) offers the other modes.
 */
export async function checkout(
  repoId: number,
  target: CheckoutTarget,
  mode: CheckoutMode = 'clean',
): Promise<boolean> {
  const result = await call(repoId, () => unwrap(ipc.commands.checkout(repoId, target, mode)));
  if (result.ok) {
    const { branch, created, fastForwarded } = result.data;
    if (branch) rememberBranch(repoId, branch);
    toast({
      variant: 'success',
      title: branch
        ? t(created ? 'refs.checkout.createdDone' : 'refs.checkout.done', { name: branch })
        : t('refs.checkout.detachedDone', { name: targetLabel(target) }),
      description: fastForwarded
        ? t('refs.checkout.fastForwarded', { remote: fastForwarded })
        : undefined,
    });
    return true;
  }
  if (result.handled) return false;
  const { error } = result;
  if (error.payload?.kind === 'dirtyWorktree') {
    openRefDialog({
      kind: 'dirtyCheckout',
      repoId,
      target,
      label: targetLabel(target),
      paths: error.payload.paths,
      canCarry: error.payload.canCarry,
    });
  } else {
    reportRefError(error);
  }
  return false;
}

export function createBranch(
  repoId: number,
  name: string,
  from: BranchStart,
  checkoutAfter: boolean,
): Promise<RefResult> {
  return call(repoId, async () => {
    await unwrap(ipc.commands.createBranch(repoId, name, from, checkoutAfter));
    if (checkoutAfter) rememberBranch(repoId, name);
    toast({
      variant: 'success',
      title: t(checkoutAfter ? 'refs.branch.createdCheckedOut' : 'refs.branch.created', { name }),
    });
    return null;
  });
}

export function renameBranch(repoId: number, name: string, newName: string): Promise<RefResult> {
  return call(repoId, async () => {
    await unwrap(ipc.commands.renameBranch(repoId, name, newName));
    toast({ variant: 'success', title: t('refs.branch.renamed', { name, newName }) });
    return null;
  });
}

export function deleteBranch(
  repoId: number,
  request: DeleteBranchRequest,
): Promise<RefResult<DeleteBranchResult>> {
  return call(repoId, async () => {
    const result = await unwrap(ipc.commands.deleteBranch(repoId, request));
    if (result.remoteError) {
      toast({
        variant: 'warning',
        title: t('refs.branch.deleted', { name: request.name }),
        description: t('refs.branch.remoteFailed', {
          message: localize(result.remoteError.message),
        }),
      });
      return result;
    }
    toast({
      variant: 'success',
      title: t('refs.branch.deleted', { name: request.name }),
      description: t(result.remote ? 'refs.branch.deletedRemote' : 'refs.branch.deletedHint', {
        sha: shortOid(result.local.sha),
      }),
    });
    return result;
  });
}

export function setUpstream(
  repoId: number,
  branch: string,
  upstream: string | null,
): Promise<RefResult> {
  return call(repoId, async () => {
    if (upstream === null) {
      await unwrap(ipc.commands.unsetUpstream(repoId, branch));
      toast({ variant: 'success', title: t('refs.upstream.unset', { name: branch }) });
    } else {
      await unwrap(ipc.commands.setUpstream(repoId, branch, upstream));
      toast({ variant: 'success', title: t('refs.upstream.set', { name: branch, upstream }) });
    }
    return null;
  });
}

export function unsetUpstream(repoId: number, branch: string): Promise<RefResult> {
  return callAndReport(repoId, async () => {
    await unwrap(ipc.commands.unsetUpstream(repoId, branch));
    toast({ variant: 'success', title: t('refs.upstream.unset', { name: branch }) });
    return null;
  });
}

export function createTag(repoId: number, request: CreateTagRequest): Promise<RefResult> {
  return call(repoId, async () => {
    await unwrap(ipc.commands.createTag(repoId, request));
    toast({ variant: 'success', title: t('refs.tag.created', { name: request.name }) });
    return null;
  });
}

/** Deletes a tag locally after a confirmation; the remote copy, if any, is left alone. */
export async function deleteTag(repoId: number, name: string): Promise<boolean> {
  const confirmed = await confirm({
    kind: 'deleteTag',
    title: t('refs.tag.deleteTitle', { name }),
    description: t('refs.tag.deleteDescription'),
    command: `git tag -d ${name}`,
    confirmLabel: t('refs.tag.deleteConfirm'),
    danger: true,
  });
  if (!confirmed) return false;
  const result = await callAndReport(repoId, async () => {
    const deleted = await unwrap(ipc.commands.deleteTag(repoId, name));
    toast({
      variant: 'success',
      title: t('refs.tag.deleted', { name }),
      description: t('refs.tag.deletedHint', { sha: shortOid(deleted.sha) }),
    });
    return null;
  });
  return result.ok;
}

export function stashPush(repoId: number, request: StashPushRequest): Promise<RefResult> {
  return call(repoId, async () => {
    await unwrap(ipc.commands.stashPush(repoId, request));
    toast({ variant: 'success', title: t('refs.stash.pushed') });
    return null;
  });
}

export async function stashApply(repoId: number, stash: StashId): Promise<boolean> {
  const result = await callAndReport(repoId, async () => {
    await unwrap(ipc.commands.stashApply(repoId, stash));
    toast({ variant: 'success', title: t('refs.stash.applied') });
    return null;
  });
  return result.ok;
}

export async function stashPop(repoId: number, stash: StashId): Promise<boolean> {
  const result = await callAndReport(repoId, async () => {
    await unwrap(ipc.commands.stashPop(repoId, stash));
    toast({ variant: 'success', title: t('refs.stash.popped') });
    return null;
  });
  return result.ok;
}

/** Drops a stash after a confirmation; its commit stays recoverable by SHA until Git collects it. */
export async function stashDrop(repoId: number, stash: StashId, message: string): Promise<boolean> {
  const confirmed = await confirm({
    kind: 'dropStash',
    title: t('refs.stash.dropTitle'),
    description: t('refs.stash.dropDescription'),
    items: [{ label: message, note: `stash@{${String(stash.index)}}`, danger: true }],
    command: `git stash drop stash@{${String(stash.index)}}`,
    confirmLabel: t('refs.stash.dropConfirm'),
    danger: true,
  });
  if (!confirmed) return false;
  const result = await callAndReport(repoId, async () => {
    const dropped = await unwrap(ipc.commands.stashDrop(repoId, stash));
    toast({
      variant: 'success',
      title: t('refs.stash.dropped'),
      description: t('refs.stash.droppedHint', { sha: shortOid(dropped.sha) }),
    });
    return null;
  });
  return result.ok;
}

export function stashRename(repoId: number, stash: StashId, message: string): Promise<RefResult> {
  return call(repoId, async () => {
    await unwrap(ipc.commands.stashRename(repoId, stash, message));
    toast({ variant: 'success', title: t('refs.stash.renamed') });
    return null;
  });
}

/** Pops the most recent stash (toolbar Pop button, palette). */
export async function popLatestStash(repoId: number): Promise<boolean> {
  const refs = await queryClient.query({
    queryKey: queryKeys.repoRefs(repoId),
    queryFn: () => unwrap(ipc.commands.listRefs(repoId)),
    staleTime: 0,
  });
  const latest = refs.stashes[0];
  if (!latest) {
    toast({ variant: 'info', title: t('refs.stash.none') });
    return false;
  }
  return stashPop(repoId, { index: latest.index, sha: latest.sha });
}
