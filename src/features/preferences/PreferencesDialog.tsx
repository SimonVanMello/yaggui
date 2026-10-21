import { Tabs } from 'radix-ui';

import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { AppearanceTab } from './AppearanceTab';
import { KeybindingsTab } from '../keybindings/KeybindingsTab';
import { BehaviorTab } from './BehaviorTab';
import { exportPreferencesFile, startPreferencesImport } from './prefsSync';
import { GitConfigTab } from './GitConfigTab';
import { GitTab } from './GitTab';
import { ToolsTab } from './ToolsTab';
import styles from './PreferencesDialog.module.css';

/** Preferences screen (F-320, F-322, F-324): every change applies and is saved at once. */
export function PreferencesDialog() {
  const open = useShellStore((state) => state.preferencesOpen);
  const requestedTab = useShellStore((state) => state.preferencesTab);
  const t = useT();
  return (
    <Dialog
      open={open}
      wide
      onEscapeKeyDown={(event) => {
        // Escape cancels the shortcut being captured, not the whole dialog.
        if (document.querySelector('[data-capturing]')) event.preventDefault();
      }}
      onOpenChange={(next) => {
        useShellStore.getState().setPreferencesOpen(next);
      }}
      title={t('prefs.title')}
      description={t('prefs.description')}
      footer={
        <>
          <div className={styles.sync}>
            <Button
              variant="ghost"
              onClick={() => {
                void startPreferencesImport();
              }}
            >
              {t('prefs.sync.import')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void exportPreferencesFile();
              }}
            >
              {t('prefs.sync.export')}
            </Button>
          </div>
          <Button
            onClick={() => {
              useShellStore.getState().setPreferencesOpen(false);
            }}
          >
            {t('common.close')}
          </Button>
        </>
      }
    >
      <Tabs.Root
        key={requestedTab ?? 'default'}
        defaultValue={requestedTab ?? 'appearance'}
        className={styles.tabs}
      >
        <Tabs.List className={styles.list} aria-label={t('prefs.tabs')}>
          <Tabs.Trigger value="appearance" className={styles.trigger}>
            {t('prefs.tab.appearance')}
          </Tabs.Trigger>
          <Tabs.Trigger value="keybindings" className={styles.trigger}>
            {t('prefs.tab.keybindings')}
          </Tabs.Trigger>
          <Tabs.Trigger value="tools" className={styles.trigger}>
            {t('prefs.tab.tools')}
          </Tabs.Trigger>
          <Tabs.Trigger value="git" className={styles.trigger}>
            {t('prefs.tab.git')}
          </Tabs.Trigger>
          <Tabs.Trigger value="gitconfig" className={styles.trigger}>
            {t('prefs.tab.gitconfig')}
          </Tabs.Trigger>
          <Tabs.Trigger value="behavior" className={styles.trigger}>
            {t('prefs.tab.behavior')}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="appearance" className={styles.panel}>
          <AppearanceTab />
        </Tabs.Content>
        <Tabs.Content value="keybindings" className={styles.panel}>
          <KeybindingsTab />
        </Tabs.Content>
        <Tabs.Content value="tools" className={styles.panel}>
          <ToolsTab />
        </Tabs.Content>
        <Tabs.Content value="git" className={styles.panel}>
          <GitTab />
        </Tabs.Content>
        <Tabs.Content value="gitconfig" className={styles.panel}>
          <GitConfigTab />
        </Tabs.Content>
        <Tabs.Content value="behavior" className={styles.panel}>
          <BehaviorTab />
        </Tabs.Content>
      </Tabs.Root>
    </Dialog>
  );
}
