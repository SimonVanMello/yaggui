import { create } from 'zustand';

export type LogFilter = 'repo' | 'all';

/** App-wide UI state that is not per tab. */
interface ShellStore {
  logOpen: boolean;
  logHeight: number;
  logFilter: LogFilter;
  /** Entry to expand and scroll to when the log opens (e.g. from an error's action). */
  highlightedLogEntry: number | 'lastFailed' | null;
  /**
   * "Open repository" dialog, or `null` when closed. `targetTabId` is the welcome tab to reuse;
   * `null` opens the repository in a new tab.
   */
  openDialog: { targetTabId: string | null } | null;
  /** "Clone a repository" dialog; `targetTabId` as for `openDialog`. */
  cloneDialog: { targetTabId: string | null } | null;
  /** "Initialize a repository" dialog; `targetTabId` as for `openDialog`. */
  initDialog: { targetTabId: string | null } | null;
  preferencesOpen: boolean;
  /** Tab the preferences open on (`appearance` when `null`). */
  preferencesTab: string | null;
  /** Keyboard shortcut sheet (F-283). */
  shortcutsOpen: boolean;
  /** Terminal preference dialog (F-266). */
  terminalDialogOpen: boolean;
  setLogOpen: (open: boolean) => void;
  toggleLog: () => void;
  setLogHeight: (height: number) => void;
  setLogFilter: (filter: LogFilter) => void;
  /** Opens the log on an entry; `null` targets the most recent failed command. */
  showLogEntry: (entryId: number | null) => void;
  clearLogHighlight: () => void;
  showOpenDialog: (targetTabId: string | null) => void;
  closeOpenDialog: () => void;
  setTerminalDialogOpen: (open: boolean) => void;
  showCloneDialog: (targetTabId: string | null) => void;
  closeCloneDialog: () => void;
  showInitDialog: (targetTabId: string | null) => void;
  closeInitDialog: () => void;
  setPreferencesOpen: (open: boolean, tab?: string) => void;
  setShortcutsOpen: (open: boolean) => void;
}

export const LOG_HEIGHT = { min: 140, max: 640, default: 260 };

export const useShellStore = create<ShellStore>()((set) => ({
  logOpen: false,
  logHeight: LOG_HEIGHT.default,
  logFilter: 'repo',
  highlightedLogEntry: null,
  openDialog: null,
  terminalDialogOpen: false,
  cloneDialog: null,
  initDialog: null,
  preferencesOpen: false,
  preferencesTab: null,
  shortcutsOpen: false,
  setLogOpen: (logOpen) => {
    set({ logOpen });
  },
  toggleLog: () => {
    set((state) => ({ logOpen: !state.logOpen }));
  },
  setLogHeight: (height) => {
    set({ logHeight: Math.round(Math.min(LOG_HEIGHT.max, Math.max(LOG_HEIGHT.min, height))) });
  },
  setLogFilter: (logFilter) => {
    set({ logFilter });
  },
  showLogEntry: (entryId) => {
    set({ logOpen: true, highlightedLogEntry: entryId ?? 'lastFailed' });
  },
  clearLogHighlight: () => {
    set({ highlightedLogEntry: null });
  },
  showOpenDialog: (targetTabId) => {
    set({ openDialog: { targetTabId } });
  },
  closeOpenDialog: () => {
    set({ openDialog: null });
  },
  setTerminalDialogOpen: (terminalDialogOpen) => {
    set({ terminalDialogOpen });
  },
  showCloneDialog: (targetTabId) => {
    set({ cloneDialog: { targetTabId } });
  },
  closeCloneDialog: () => {
    set({ cloneDialog: null });
  },
  showInitDialog: (targetTabId) => {
    set({ initDialog: { targetTabId } });
  },
  closeInitDialog: () => {
    set({ initDialog: null });
  },
  setPreferencesOpen: (preferencesOpen, tab) => {
    set({ preferencesOpen, preferencesTab: preferencesOpen ? (tab ?? null) : null });
  },
  setShortcutsOpen: (shortcutsOpen) => {
    set({ shortcutsOpen });
  },
}));
