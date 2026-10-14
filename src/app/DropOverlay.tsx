import { useEffect, useState } from 'react';

import { openRepoPath } from '../features/repo/repoSessions';
import { useT } from '../i18n/useT';
import { nativeWindow } from '../ipc';
import { Icon } from '../ui/Icon';
import styles from './DropOverlay.module.css';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';

/** Drop a folder anywhere on the window to open it (F-001). */
export function DropOverlay() {
  const t = useT();
  const [over, setOver] = useState(false);

  useEffect(
    () =>
      nativeWindow.subscribeFolderDrop({
        onEnter: () => {
          setOver(true);
        },
        onLeave: () => {
          setOver(false);
        },
        onDrop: (paths) => {
          setOver(false);
          const active = selectActiveTab(useTabsStore.getState());
          // The first folder may reuse the current welcome tab; the others get new tabs.
          void paths.reduce<Promise<unknown>>(
            (previous, path, index) =>
              previous.then(() =>
                openRepoPath(path, index === 0 && active.repoId === null ? active.id : undefined),
              ),
            Promise.resolve(),
          );
        },
      }),
    [],
  );

  if (!over) return null;
  return (
    <div className={styles.overlay} aria-hidden="true">
      <div className={styles.card}>
        <Icon name="drop" size="lg" />
        <span>{t('drop.title')}</span>
      </div>
    </div>
  );
}
