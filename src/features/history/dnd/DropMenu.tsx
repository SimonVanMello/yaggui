import { useT } from '../../../i18n/useT';
import { Menu } from '../../../ui/Menu';
import { MenuItem } from '../../../ui/MenuItem';
import { MenuLabel } from '../../../ui/MenuLabel';
import { planDrop, type DropAction } from '../dropActions';
import { openHistoryDialog } from '../historyDialogsStore';
import {
  cherryPickCommits,
  currentBranchOf,
  mergeBranch,
  operationOf,
  rebaseBranch,
} from '../historyOps';
import { useDragStore } from './dragStore';

/** Runs the action picked in the drop menu (or its keyboard / palette twin). */
export function runDropAction(repoId: number, action: DropAction): void {
  switch (action.id) {
    case 'merge':
      openHistoryDialog({ kind: 'merge', repoId, source: action.source, target: action.target });
      return;
    case 'fastForward':
      // Never creates a commit and refuses when the branches diverged: no dialog needed.
      void mergeBranch(repoId, {
        source: action.source,
        target: action.target,
        mode: 'fastForwardOnly',
        message: null,
      });
      return;
    case 'rebase':
      void rebaseBranch(repoId, { branch: action.source, onto: action.target });
      return;
    case 'cherryPick':
      void cherryPickCommits(repoId, { shas: action.shas, target: action.target, mainline: null });
      return;
  }
}

/**
 * Menu opened where a branch or commits were dropped on a branch: Merge X into Y, Rebase X onto
 * Y, Fast-forward Y to X, or Cherry-pick onto Y. Only what can run is enabled.
 */
export function DropMenu() {
  const t = useT();
  const menu = useDragStore((state) => state.menu);
  const setMenu = useDragStore((state) => state.setMenu);
  if (!menu) return null;
  const current = currentBranchOf(menu.repoId);
  const actions = planDrop(menu.payload, menu.target, current);
  const busy = operationOf(menu.repoId) !== null;
  const names = (action: DropAction) => ({
    source: action.source,
    target: action.target,
    count: action.shas.length,
  });

  return (
    <Menu
      open
      onOpenChange={(open) => {
        if (!open) setMenu(null);
      }}
      trigger={
        <span
          aria-hidden
          style={{ position: 'fixed', left: menu.x, top: menu.y, width: 1, height: 1 }}
        />
      }
    >
      <MenuLabel>{t('dnd.dropOn', { target: menu.target })}</MenuLabel>
      {actions.length === 0 && <MenuItem disabled>{t('dnd.sameBranch')}</MenuItem>}
      {actions.map((action) => (
        <MenuItem
          key={action.id}
          icon={action.id === 'merge' ? 'merge' : action.id === 'cherryPick' ? 'commit' : 'branch'}
          disabled={busy || action.disabled !== null}
          hint={
            busy
              ? t('history.menu.busy')
              : action.disabled === 'remoteSource'
                ? t('dnd.remoteRebase')
                : action.needsCheckout
                  ? t('dnd.checkoutFirst', { target: action.target })
                  : action.id === 'rebase' && action.source !== current
                    ? t('dnd.checkoutFirst', { target: action.source })
                    : undefined
          }
          onSelect={() => {
            runDropAction(menu.repoId, action);
          }}
        >
          {t(`dnd.action.${action.id}`, names(action))}
        </MenuItem>
      ))}
    </Menu>
  );
}
