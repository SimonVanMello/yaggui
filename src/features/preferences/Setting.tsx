import type { ReactNode } from 'react';

import { isSettingVisible, useSettingsFilter } from './settingsFilter';
import styles from './Setting.module.css';

interface SettingProps {
  /** Id of the setting in `SETTINGS` (settingsIndex.ts). */
  id: string;
  children: ReactNode;
}

/** One setting of a section: hidden when a search does not match it. */
export function Setting({ id, children }: SettingProps) {
  const filter = useSettingsFilter();
  if (!isSettingVisible(filter, id)) return null;
  return (
    <div className={styles.setting} data-setting={id}>
      {children}
    </div>
  );
}
