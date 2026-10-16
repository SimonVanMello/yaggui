import { useEffect, useState } from 'react';

import { registerBuiltinBindings } from '../features/keybindings/builtinBindings';
import { registerBuiltinActions } from '../features/palette/builtinActions';
import { CommandPalette } from '../features/palette/CommandPalette';
import { CommandLogPanel } from '../features/command-log/CommandLogPanel';
import { StatusBar } from '../features/statusbar/StatusBar';
import { TerminalDialog } from '../features/terminal/TerminalDialog';
import { UpgradeDialog } from '../features/updates/UpgradeDialog';
import { CloneDialog } from '../features/clone/CloneDialog';
import { InitDialog } from '../features/clone/InitDialog';
import { ShortcutsDialog } from '../features/keybindings/ShortcutsDialog';
import { PreferencesDialog } from '../features/preferences/PreferencesDialog';
import { OpenRepoDialog } from '../features/welcome/OpenRepoDialog';
import { WorkspaceDialogs } from '../features/workspaces/WorkspaceDialogs';
import { ModuleDialogs } from '../features/worktrees/ModuleDialogs';
import { nativeWindow } from '../ipc';
import { DropOverlay } from './DropOverlay';
import styles from './Shell.module.css';
import { useShellStore } from './shellStore';
import { startup } from './startup';
import { TabContent } from './tabs/TabContent';
import { TitleBar } from './titlebar/TitleBar';
import { useBackendEvents } from './useBackendEvents';
import { useShortcuts } from './useShortcuts';

/** Longest wait for the restored session before showing the (hidden) window anyway. */
const SHOW_WINDOW_TIMEOUT_MS = 1500;

function useStartup(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      // The window starts hidden (tauri.conf.json) so it never flashes an unstyled frame.
      void nativeWindow.show().catch((error: unknown) => {
        console.warn('Could not show the window', error);
      });
    };
    const timer = setTimeout(show, SHOW_WINDOW_TIMEOUT_MS);
    void startup().finally(() => {
      setReady(true);
      clearTimeout(timer);
      // Let React commit the restored tabs before the first visible frame.
      setTimeout(show, 0);
    });
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return ready;
}

/** Main window: title bar with tabs, active tab content, command log and status bar. */
export function Shell() {
  useBackendEvents();
  useShortcuts();
  useEffect(registerBuiltinActions, []);
  useEffect(registerBuiltinBindings, []);
  const ready = useStartup();
  const logOpen = useShellStore((state) => state.logOpen);

  return (
    <div className={styles.shell}>
      <TitleBar />
      <div className={styles.content}>{ready && <TabContent />}</div>
      {logOpen && <CommandLogPanel />}
      <StatusBar />
      <DropOverlay />
      <OpenRepoDialog />
      <CloneDialog />
      <InitDialog />
      <PreferencesDialog />
      <ShortcutsDialog />
      <TerminalDialog />
      <UpgradeDialog />
      <WorkspaceDialogs />
      <ModuleDialogs />
      <CommandPalette />
    </div>
  );
}
