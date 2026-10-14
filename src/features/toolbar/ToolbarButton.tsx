import type { ButtonHTMLAttributes, Ref } from 'react';

import { useT } from '../../i18n/useT';
import { Icon, type IconName } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import styles from './Toolbar.module.css';

interface ToolbarButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'children' | 'className'
> {
  /** Lets a Radix trigger (`asChild`) reach the button. */
  ref?: Ref<HTMLButtonElement>;
  icon: IconName;
  label: string;
  /** Accessible name when it must say more than the visible label. */
  accessibleLabel?: string;
  /** Longer explanation shown in the tooltip. */
  description?: string;
  /** Equivalent Git command, shown in the tooltip for learning (spec §6.6). */
  command?: string;
  shortcut?: string;
  /** Small counter in the corner (commits to pull / push). */
  count?: number;
  /** Not implemented yet: stays focusable with an explanatory tooltip, but does nothing. */
  soon?: boolean;
  /** Nothing to do right now (e.g. no stash to pop): stays focusable, does nothing. */
  disabled?: boolean;
  onClick?: () => void;
}

export function ToolbarButton({
  icon,
  label,
  accessibleLabel,
  description,
  command,
  shortcut,
  count,
  soon = false,
  disabled = false,
  onClick,
  ref,
  ...rest
}: ToolbarButtonProps) {
  const t = useT();
  return (
    <Tooltip
      shortcut={shortcut}
      content={
        <span className={styles.tooltip}>
          <span>{description ?? label}</span>
          {command && <code className={styles.command}>{command}</code>}
          {soon && <span className={styles.soonNote}>{t('common.soonLong')}</span>}
        </span>
      }
    >
      <button
        type="button"
        {...rest}
        ref={ref}
        className={styles.button}
        aria-disabled={soon || disabled || undefined}
        aria-label={count ? `${label} (${String(count)})` : (accessibleLabel ?? label)}
        onClick={soon || disabled ? undefined : onClick}
      >
        <Icon name={icon} size="md" />
        <span className={styles.buttonLabel}>{label}</span>
        {count !== undefined && count > 0 && <span className={styles.count}>{count}</span>}
      </button>
    </Tooltip>
  );
}
