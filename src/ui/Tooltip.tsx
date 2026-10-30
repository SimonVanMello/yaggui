import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

import { Kbd } from './Kbd';
import styles from './Tooltip.module.css';

interface TooltipProps {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** The trigger; must accept a ref and forward props (a DOM element or a primitive from `ui/`). */
  children: ReactElement;
}

export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={styles.content} side={side} sideOffset={6}>
          <span className={styles.body}>{content}</span>
          {shortcut && <Kbd shortcut={shortcut} />}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
