import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  unwrap,
  type BranchStart,
  type CheckoutTarget,
  type RepoRefs,
  type StashId,
} from '../../ipc';
import { toast } from '../../ui/toastStore';
import { queryClient, queryKeys } from '../../app/queryClient';
import { shortOid } from '../repo/repoStatus';
import { otherWorktreeOf } from '../worktrees/worktreeOps';
import { targetName, targetSha, type RefTarget } from '../sidebar/sidebarRows';
import { openRefDialog } from './refDialogsStore';
import { checkout } from './refOps';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

export function stashId(stash: { index: number; sha: string }): StashId {
  return { index: stash.index, sha: stash.sha };
}

/** What a checkout of this ref moves HEAD to; `null` for refs that cannot be checked out. */
export function checkoutTargetOf(target: RefTarget): CheckoutTarget | null {
  switch (target.kind) {
    case 'local':
      return { kind: 'branch', name: target.branch.name };
    case 'remote':
      return { kind: 'remote', name: target.branch.name };
    case 'tag':
      return { kind: 'detached', rev: target.tag.name };
    default:
      return null;
  }
}

/** Double-click on a ref (F-024, F-045): checks out what can be, tells when already there. */
export function checkoutRef(repoId: number, target: RefTarget): void {
  if (target.kind === 'local' && target.branch.isHead) {
    toast({ variant: 'info', title: t('refs.checkout.already', { name: target.branch.name }) });
    return;
  }
  if (target.kind === 'tag') {
    // A tag detaches HEAD: explained first, with a branch offered (F-202).
    openRefDialog({
      kind: 'tagCheckout',
      repoId,
      name: target.tag.name,
      fullName: target.tag.fullName,
    });
    return;
  }
  const refs = queryClient.getQueryData<RepoRefs>(queryKeys.repoRefs(repoId));
  const elsewhere = target.kind === 'local' ? otherWorktreeOf(refs, target.branch.name) : null;
  if (elsewhere) {
    toast({
      variant: 'info',
      title: t('sidebar.branch.inWorktree', { path: elsewhere.path }),
    });
    return;
  }
  const checkoutTarget = checkoutTargetOf(target);
  if (checkoutTarget) void checkout(repoId, checkoutTarget);
}

/** Start point of a branch created from this ref (menu "Create a branch here…"). */
export function branchStartOf(target: RefTarget): { from: BranchStart; label: string } | null {
  switch (target.kind) {
    case 'head':
      return target.head.kind === 'detached'
        ? { from: { kind: 'head' }, label: shortOid(target.head.oid) }
        : null;
    case 'local':
      return { from: { kind: 'ref', fullName: target.branch.fullName }, label: target.branch.name };
    case 'remote':
      return { from: { kind: 'ref', fullName: target.branch.fullName }, label: target.branch.name };
    case 'tag':
      return { from: { kind: 'ref', fullName: target.tag.fullName }, label: target.tag.name };
    case 'stash':
      return { from: { kind: 'stash', stash: stashId(target.stash) }, label: target.stash.name };
    default:
      return null;
  }
}

export function openCreateBranch(repoId: number, from: BranchStart, fromLabel: string): void {
  openRefDialog({ kind: 'createBranch', repoId, from, fromLabel });
}

/** Branch from the checked-out commit (toolbar, palette, ⌘B). */
export async function openCreateBranchFromHead(repoId: number): Promise<void> {
  try {
    const state = await queryClient.query({
      queryKey: queryKeys.repoState(repoId),
      queryFn: () => unwrap(ipc.commands.repoState(repoId)),
      staleTime: 5_000,
    });
    const { head } = state;
    const label = head.kind === 'branch' || head.kind === 'unborn' ? head.name : shortOid(head.oid);
    openCreateBranch(repoId, { kind: 'head' }, label);
  } catch {
    openCreateBranch(repoId, { kind: 'head' }, 'HEAD');
  }
}

export function openCreateTag(repoId: number, target: string, targetLabel: string): void {
  openRefDialog({ kind: 'createTag', repoId, target, targetLabel });
}

/**
 * Tag on the checked-out commit (toolbar, palette). The SHA is pinned when the dialog opens, so
 * the tag lands on the commit it shows even if HEAD moves meanwhile; an unborn HEAD has nothing
 * to tag.
 */
export async function openCreateTagFromHead(repoId: number): Promise<void> {
  try {
    const state = await queryClient.query({
      queryKey: queryKeys.repoState(repoId),
      queryFn: () => unwrap(ipc.commands.repoState(repoId)),
      staleTime: 5_000,
    });
    const { head } = state;
    if (head.kind === 'unborn') {
      toast({ variant: 'info', title: t('refs.createTag.unborn') });
      return;
    }
    openCreateTag(repoId, head.oid, head.kind === 'branch' ? head.name : shortOid(head.oid));
  } catch {
    openCreateTag(repoId, 'HEAD', 'HEAD');
  }
}

/** Tag at the commit a ref points to. */
export function openCreateTagAt(repoId: number, target: RefTarget): void {
  const sha = targetSha(target);
  if (sha) openCreateTag(repoId, sha, targetName(target));
}
