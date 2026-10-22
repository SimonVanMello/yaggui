import { useShortcut } from '../keybindings/registry';
import type { ReactElement } from 'react';

import { useT } from '../../i18n/useT';
import type { ResetMode } from '../../ipc';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import { toast } from '../../ui/toastStore';
import { compareCommits, compareWithHead, jumpToMergeBase } from '../compare/compareActions';
import { openHistoryDialog } from '../history/historyDialogsStore';
import { openTree } from '../inspect/inspectStore';
import { RefContextMenu } from '../sidebar/RefContextMenu';
import { refTargetOf } from '../sidebar/sidebarRows';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { cherryPickCommits, revertCommit } from '../history/historyOps';
import { openCreateBranch, openCreateTag } from '../refs/refCommands';
import { createFixup, fixupBlock, startAutosquash } from '../rebase/fixupOps';
import { isFixupSummary } from '../rebase/rebaseModel';
import { openInteractiveRebase } from '../rebase/rebaseStore';
import { checkout } from '../refs/refOps';
import { shortOid } from '../repo/repoStatus';
import { useRepoState } from '../repo/useRepoState';
import type { GraphRow } from './pageCache';
import type { MenuRef } from './refLabels';
import type { PickedCommit } from './selectionModel';

interface Props {
  repoId: number;
  children: ReactElement;
  /** Commit under the pointer, set before the menu opens. */
  target: GraphRow | null;
  /** Ref label of `target` right-clicked: its menu replaces the commit's (F-023). */
  refLabel: MenuRef | null;
  /** Selected commits in graph order; more than one when a multi-selection is right-clicked. */
  picked: readonly PickedCommit[];
  /** Name of the operation in progress: history actions wait for it to end. */
  busy: boolean;
  /** Checked-out branch, for the labels. */
  current: string | null;
  onOpenChange: (open: boolean) => void;
}

export function copyText(text: string, message: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    toast({ variant: 'success', title: message, duration: 2000 });
  });
}

const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard'];

/**
 * Commit context menu (F-025). Opens with the right button, `Shift+F10` or the menu key, on the
 * selected commit. A right click inside a multi-selection acts on the whole selection.
 */
export function CommitContextMenu({
  repoId,
  children,
  target,
  refLabel,
  picked,
  busy,
  current,
  onOpenChange,
}: Props) {
  const t = useT();
  const copyShaShortcut = useShortcut('graph.copySha');
  const copyMessageShortcut = useShortcut('graph.copyMessage');
  const branch = current ?? 'HEAD';
  const busyHint = busy ? t('history.menu.busy') : undefined;
  const many = target !== null && picked.length > 1 && picked.some((c) => c.sha === target.sha);
  const refs = useRepoRefs(repoId).data;
  const refTarget = refLabel && refs ? refTargetOf(refs, refLabel.kind, refLabel.name) : null;
  const isHead = target?.refs.some((r) => r.isHead || r.kind === 'head') ?? false;
  const fixupBlocked = fixupBlock(useRepoState(repoId).data);

  const refContent = refTarget ? (
    <RefContextMenu repoId={repoId} target={refTarget} current={current} />
  ) : null;

  const manyContent = many ? (
    <>
      <ContextMenuItem
        icon="commit"
        disabled={busy}
        hint={busyHint}
        onSelect={() => {
          // Graph order is newest first: the backend applies them oldest first.
          void cherryPickCommits(repoId, {
            shas: picked.map((c) => c.sha),
            target: null,
            mainline: null,
          });
        }}
      >
        {t('graph.menu.cherryPickMany', { count: picked.length, branch })}
      </ContextMenuItem>
      {picked.length === 2 && (
        <>
          <ContextMenuItem
            icon="compare"
            onSelect={() => {
              compareCommits(repoId, picked);
            }}
          >
            {t('graph.menu.compareTwo')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="merge"
            onSelect={() => {
              const [a, b] = picked;
              if (a && b) void jumpToMergeBase(repoId, a.sha, b.sha);
            }}
          >
            {t('graph.menu.mergeBase')}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="copy"
        shortcut={copyShaShortcut}
        onSelect={() => {
          copyText(
            picked.map((c) => c.sha).join('\n'),
            t('graph.menu.shasCopied', { count: picked.length }),
          );
        }}
      >
        {t('graph.menu.copyShas')}
      </ContextMenuItem>
    </>
  ) : null;

  const content =
    refContent ??
    manyContent ??
    (target ? (
      <>
        <ContextMenuItem
          icon="commit"
          onSelect={() => {
            void checkout(repoId, { kind: 'detached', rev: target.sha });
          }}
        >
          {t('graph.menu.checkout')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="plus"
          onSelect={() => {
            openCreateBranch(repoId, { kind: 'commit', sha: target.sha }, shortOid(target.sha));
          }}
        >
          {t('graph.menu.branchHere')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="tag"
          onSelect={() => {
            openCreateTag(repoId, target.sha, shortOid(target.sha));
          }}
        >
          {t('graph.menu.tagHere')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="tree"
          onSelect={() => {
            openTree(repoId, target.sha);
          }}
        >
          {t('graph.menu.browseFiles')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon="commit"
          disabled={busy}
          hint={busyHint}
          onSelect={() => {
            void cherryPickCommits(repoId, { shas: [target.sha], target: null, mainline: null });
          }}
        >
          {t('graph.menu.cherryPick', { branch })}
        </ContextMenuItem>
        <ContextMenuItem
          icon="undo"
          disabled={busy}
          hint={busyHint}
          onSelect={() => {
            if (target.parents.length > 1) {
              openHistoryDialog({
                kind: 'parent',
                repoId,
                op: 'revert',
                shas: [target.sha],
                target: null,
              });
            } else {
              void revertCommit(repoId, target.sha, null);
            }
          }}
        >
          {t('graph.menu.revert')}
        </ContextMenuItem>
        <ContextMenuSub label={t('graph.menu.reset', { branch })} icon="retry" disabled={busy}>
          {RESET_MODES.map((mode) => (
            <ContextMenuItem
              key={mode}
              danger={mode === 'hard'}
              hint={t(`history.reset.${mode}Short`)}
              onSelect={() => {
                openHistoryDialog({
                  kind: 'reset',
                  repoId,
                  target: target.sha,
                  label: shortOid(target.sha),
                  mode,
                });
              }}
            >
              {t(`history.reset.${mode}`)}
            </ContextMenuItem>
          ))}
        </ContextMenuSub>
        <ContextMenuItem
          icon="branch"
          disabled={busy}
          hint={busyHint}
          onSelect={() => {
            // The commits after this one, up to HEAD, are rewritten (F-142).
            openInteractiveRebase(repoId, target.sha);
          }}
        >
          {t('graph.menu.rebase')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="pencil"
          disabled={busy}
          hint={busyHint}
          onSelect={() => {
            openHistoryDialog({ kind: 'reword', repoId, sha: target.sha, head: isHead });
          }}
        >
          {t('graph.menu.reword')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon="plus"
          disabled={fixupBlocked !== null}
          hint={fixupBlocked === null ? undefined : t(fixupBlocked)}
          onSelect={() => {
            void createFixup(repoId, target.sha);
          }}
        >
          {t('graph.menu.fixup')}
        </ContextMenuItem>
        {isFixupSummary(target.summary) && (
          <ContextMenuItem
            icon="merge"
            disabled={busy}
            hint={busyHint}
            onSelect={() => {
              void startAutosquash(repoId);
            }}
          >
            {t('graph.menu.autosquash')}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          icon="compare"
          onSelect={() => {
            compareWithHead(repoId, target.sha);
          }}
        >
          {t('graph.menu.compareHead')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="merge"
          onSelect={() => {
            void jumpToMergeBase(repoId, target.sha, 'HEAD');
          }}
        >
          {t('graph.menu.mergeBaseHead')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon="copy"
          shortcut={copyShaShortcut}
          onSelect={() => {
            copyText(target.sha, t('graph.menu.shaCopied'));
          }}
        >
          {t('graph.menu.copySha')}
        </ContextMenuItem>
        <ContextMenuItem
          icon="copy"
          shortcut={copyMessageShortcut}
          onSelect={() => {
            copyText(target.summary, t('graph.menu.messageCopied'));
          }}
        >
          {t('graph.menu.copyMessage')}
        </ContextMenuItem>
      </>
    ) : null);

  return (
    <ContextMenu content={content} onOpenChange={onOpenChange}>
      {children}
    </ContextMenu>
  );
}
