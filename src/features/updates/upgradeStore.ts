import { create } from 'zustand';

import { ipc, unwrap, type UpdateInfo, type YagguiError } from '../../ipc';
import { disposeTerminal, newProgramTerminal } from '../terminal/terminalSessions';

/** Where the upgrade by a package manager stands. */
export type UpgradePhase =
  /** Downloading the package (`percent` once its size is known), then starting the command. */
  | { kind: 'preparing'; percent: number | null }
  /** The package manager runs in the terminal: it may ask for the password. */
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null }
  /** The download or the start failed: nothing ran. */
  | { kind: 'failed'; error: YagguiError };

interface UpgradeState {
  /** The version being installed; `null` when the dialog is closed. */
  update: UpdateInfo | null;
  terminalId: string | null;
  phase: UpgradePhase;
}

const PREPARING: UpgradePhase = { kind: 'preparing', percent: null };

export const useUpgradeStore = create<UpgradeState>(() => ({
  update: null,
  terminalId: null,
  phase: PREPARING,
}));

let offProgress: (() => void) | null = null;

/** While the package manager may be writing to the system, the dialog cannot be closed. */
export function upgradeBusy(phase: UpgradePhase): boolean {
  return phase.kind === 'preparing' || phase.kind === 'running';
}

function setPhase(terminalId: string, phase: UpgradePhase): void {
  // A late event of a terminal already replaced (retry) or closed is ignored.
  if (useUpgradeStore.getState().terminalId === terminalId) useUpgradeStore.setState({ phase });
}

function endTerminal(): void {
  offProgress?.();
  offProgress = null;
  const { terminalId } = useUpgradeStore.getState();
  if (terminalId) disposeTerminal(terminalId);
}

/**
 * Upgrades a copy owned by a package manager (AUR, `.deb`, `.rpm`): the backend chooses and
 * starts the command in a terminal, shown by `UpgradeDialog`. The terminal lives outside React
 * so that a remount does not start a second upgrade.
 */
export function startUpgrade(update: UpdateInfo): void {
  endTerminal();
  const terminalId = newProgramTerminal(
    (cols, rows) => unwrap(ipc.commands.updateInTerminal(cols, rows)),
    {
      started: () => {
        setPhase(terminalId, { kind: 'running' });
      },
      failed: (error) => {
        setPhase(terminalId, { kind: 'failed', error });
      },
      exited: (exitCode) => {
        setPhase(terminalId, { kind: 'exited', exitCode });
      },
    },
  );
  offProgress = ipc.events.subscribe('updateProgress', ({ percent }) => {
    if (useUpgradeStore.getState().phase.kind === 'preparing') {
      setPhase(terminalId, { kind: 'preparing', percent });
    }
  });
  useUpgradeStore.setState({ update, terminalId, phase: PREPARING });
}

/** Closes the dialog and its terminal. */
export function closeUpgrade(): void {
  endTerminal();
  useUpgradeStore.setState({ update: null, terminalId: null, phase: PREPARING });
}

/** Restarts on the version the package manager installed. */
export function restartAfterUpgrade(): void {
  void ipc.commands.restartApp();
}
