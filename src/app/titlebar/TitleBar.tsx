import { isDemo } from '../../demo/isDemo';
import { useT } from '../../i18n/useT';
import { nativeWindow } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { platform } from '../../ui/platform';
import { useShellStore } from '../shellStore';
import { TabStrip } from './TabStrip';
import styles from './TitleBar.module.css';
import { WindowControls } from './WindowControls';

/**
 * Title bar holding the tabs (F-004). Window buttons follow the OS (spec §6.9): native
 * traffic lights on macOS (overlay title bar), app-drawn buttons on the right elsewhere.
 */
export function TitleBar() {
  const t = useT();
  const macNative = platform === 'mac' && nativeWindow.isNative;
  return (
    <header className={styles.titlebar} data-tauri-drag-region>
      {macNative && <div className={styles.trafficLights} data-tauri-drag-region />}
      <TabStrip />
      <div className={styles.spacer} data-tauri-drag-region />
      <div className={styles.actions}>
        <IconButton
          icon="settings"
          label={t('settings.title')}
          size="sm"
          onClick={() => {
            useShellStore.getState().setPreferencesOpen(true);
          }}
        />
      </div>
      {platform !== 'mac' && !isDemo && <WindowControls />}
    </header>
  );
}
