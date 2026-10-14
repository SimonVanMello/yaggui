import { Activity, type ReactNode } from 'react';

import styles from './TabContent.module.css';

/**
 * A tab view kept mounted. Hidden, it keeps its state and DOM, but React tears its effects
 * down: no watcher subscription, query observer, timer or key handler runs until it is shown
 * again. `hidden` and `inert` keep it out of the accessibility tree and of the focus order.
 */
export function KeptView({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      <div className={styles.view} hidden={!active} inert={!active} data-tab-view={id}>
        {children}
      </div>
    </Activity>
  );
}
