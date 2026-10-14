import { currentPreferences } from '../../app/preferences';
import { terminalHasFocus } from './terminalFocus';
import { hideTerminalPanel, repoTerminals, useTerminalStore } from './terminalStore';
import { openTerminal } from './openTerminal';

function integrated(): boolean {
  return currentPreferences().terminalMode === 'integrated';
}

/** The emulator (xterm) is only loaded once a terminal is opened: it stays out of startup. */
function sessions() {
  return import('./terminalSessions');
}

/**
 * Terminal button: shows or hides the panel (F-267), or opens the external terminal when
 * that is the preference (F-266).
 */
export async function toggleTerminalPanel(repoId: number): Promise<void> {
  if (!integrated()) return openTerminal(repoId);
  if (repoTerminals(repoId).open) hideTerminalPanel(repoId);
  else (await sessions()).showTerminalPanel(repoId);
}

/**
 * `terminal.toggle` shortcut: opens the panel, or gives the keyboard to the terminal if the
 * panel is open but not focused, or hides it from the terminal (as in most IDEs).
 */
export async function toggleTerminalFromKeyboard(repoId: number): Promise<void> {
  if (!integrated()) return openTerminal(repoId);
  const repo = repoTerminals(repoId);
  if (repo.open && terminalHasFocus(repoId)) hideTerminalPanel(repoId);
  else if (repo.open && repo.activeId) (await sessions()).focusTerminal(repo.activeId);
  else (await sessions()).showTerminalPanel(repoId);
}

/** `terminal.new`: one more integrated terminal, or the external one. */
export async function openNewTerminal(repoId: number): Promise<void> {
  if (!integrated()) return openTerminal(repoId);
  (await sessions()).newTerminal(repoId);
}

/** Ends the terminals of a repository whose last tab closed. */
export function disposeRepoTerminals(repoId: number): void {
  const started = repoTerminals(repoId).tabs.length > 0;
  useTerminalStore.getState().forgetRepo(repoId);
  if (started) {
    void sessions().then((module) => {
      module.disposeRepoTerminals(repoId);
    });
  }
}
