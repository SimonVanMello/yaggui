import type { ReactNode } from 'react';

import { isSettingVisible, useSettingsFilter } from './settingsFilter';
import styles from './Setting.module.css';

interface SettingGroupProps {
  title: string;
  /** Settings of the group: the group is left out when a search matches none of them. */
  ids: readonly string[];
  children: ReactNode;
}

/** A titled group of settings inside a section. */
export function SettingGroup({ title, ids, children }: SettingGroupProps) {
  const filter = useSettingsFilter();
  if (!ids.some((id) => isSettingVisible(filter, id))) return null;
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>{title}</h3>
      {children}
    </section>
  );
}
