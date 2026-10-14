import type { RebaseAction } from '../../ipc';
import { useT } from '../../i18n/useT';
import styles from './ActionButtons.module.css';

export const ACTIONS: readonly RebaseAction[] = [
  'pick',
  'reword',
  'squash',
  'fixup',
  'drop',
  'edit',
];

const KEY: Record<RebaseAction, string> = {
  pick: 'P',
  reword: 'R',
  squash: 'S',
  fixup: 'F',
  drop: 'D',
  edit: 'E',
};

interface ActionButtonsProps {
  value: RebaseAction;
  /** Accessible name of the group (the commit it applies to). */
  label: string;
  onChange: (action: RebaseAction) => void;
}

/**
 * The action of a commit as a button group. The buttons are out of the tab order: the list
 * itself is the keyboard target (letter keys), so the group serves the pointer.
 */
export function ActionButtons({ value, label, onChange }: ActionButtonsProps) {
  const t = useT();
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {ACTIONS.map((action) => (
        <button
          key={action}
          type="button"
          tabIndex={-1}
          className={styles.button}
          data-action={action}
          aria-pressed={value === action}
          aria-keyshortcuts={KEY[action]}
          title={`${t(`rebaseInteractive.actionHelp.${action}`)} (${KEY[action]})`}
          onClick={(event) => {
            event.stopPropagation();
            onChange(action);
          }}
        >
          {t(`rebaseInteractive.action.${action}`)}
        </button>
      ))}
    </div>
  );
}
