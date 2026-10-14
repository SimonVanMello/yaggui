import { Popover } from 'radix-ui';
import { useEffect, useState } from 'react';

import { useT } from '../../i18n/useT';
import { useShortcut } from '../keybindings/registry';
import { IconButton } from '../../ui/IconButton';
import toolbar from '../toolbar/Toolbar.module.css';
import { ToolbarButton } from '../toolbar/ToolbarButton';
import { activeRepoId } from '../repo/repoSessions';
import { OpHistory } from './OpHistory';
import { blockMessage } from './undoLabels';
import { entryText, runUndo, text } from './undoOps';
import { useUndoState } from './undoQueries';
import { buttonState, type UndoDirection } from './undoState';
import { OP_HISTORY_EVENT } from './undoEvents';

/** Undo and Redo of the toolbar, with the operation they act on, and the session history. */
export function UndoButtons({ repoId }: { repoId: number }) {
  const t = useT();
  const undoShortcut = useShortcut('edit.undo');
  const redoShortcut = useShortcut('edit.redo');
  const state = useUndoState(repoId).data;
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const onHistory = () => {
      if (activeRepoId() === repoId) setHistoryOpen(true);
    };
    window.addEventListener(OP_HISTORY_EVENT, onHistory);
    return () => {
      window.removeEventListener(OP_HISTORY_EVENT, onHistory);
    };
  }, [repoId]);

  const button = (direction: UndoDirection) => {
    const current = buttonState(state, direction);
    const label = t(direction === 'undo' ? 'toolbar.undo' : 'toolbar.redo');
    let description: string;
    let accessibleLabel: string | undefined;
    if (current.kind === 'empty') {
      description = t(direction === 'undo' ? 'undo.toolbar.empty' : 'redo.toolbar.empty');
    } else {
      const op = entryText(current.step.entry);
      accessibleLabel = t(direction === 'undo' ? 'undo.toolbar.label' : 'redo.toolbar.label', {
        op,
      });
      description =
        current.kind === 'blocked' && current.step.blocked
          ? t(direction === 'undo' ? 'undo.toolbar.blocked' : 'redo.toolbar.blocked', {
              op,
              reason: text(blockMessage(current.step.blocked)),
            })
          : accessibleLabel;
    }
    return (
      <ToolbarButton
        icon={direction}
        label={label}
        accessibleLabel={accessibleLabel}
        description={description}
        shortcut={direction === 'undo' ? undoShortcut : redoShortcut}
        // A blocked or empty button stays focusable and keeps its tooltip, like the others.
        disabled={current.kind !== 'ready'}
        data-state={current.kind}
        onClick={() => {
          void runUndo(repoId, direction);
        }}
      />
    );
  };

  return (
    <>
      {button('undo')}
      <span className={toolbar.split}>
        {button('redo')}
        <Popover.Root open={historyOpen} onOpenChange={setHistoryOpen}>
          <Popover.Trigger asChild>
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('undo.history.open')}
              className={toolbar.chevron}
            />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className={toolbar.historyPopover} align="start" sideOffset={4}>
              <OpHistory repoId={repoId} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </span>
    </>
  );
}
