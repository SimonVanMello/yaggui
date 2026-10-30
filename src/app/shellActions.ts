import { openCreateBranchFromHead, openCreateTagFromHead } from '../features/refs/refCommands';
import { STASH_EVENT } from '../features/refs/refEvents';
import { popLatestStash } from '../features/refs/refOps';
import { useKeybindings } from '../features/keybindings/keybindingsStore';
import { effectiveShortcut } from '../features/keybindings/resolve';
import { activeRepoId, closeTabAndRepo } from '../features/repo/repoSessions';
import { pickAndOpenRepo } from '../features/welcome/openRepository';
import { openLogsFolder, reportBug } from '../features/diagnostics/diagnostics';
import { usePaletteStore } from '../features/palette/paletteStore';
import { useShellStore } from './shellStore';
import { openNewTab, selectActiveTab, useTabsStore } from './tabs/tabsStore';
import { fetchRepo, pullRepo, pushRepo } from '../features/network/networkOps';
import { OP_HISTORY_EVENT } from '../features/undo/undoEvents';
import { runUndo } from '../features/undo/undoOps';
import { isTextEntry } from '../ui/textEntry';

function togglePanel(panel: 'sidebar' | 'details'): void {
  const store = useTabsStore.getState();
  const tab = selectActiveTab(store);
  if (tab.repoId === null) return;
  store.setPanel(tab.id, panel, { collapsed: !tab.panels[panel].collapsed });
}

/** The active tab when it is a welcome tab (it receives the repository), else a new tab. */
function welcomeTabId(): string | null {
  const tab = selectActiveTab(useTabsStore.getState());
  return tab.repoId === null ? tab.id : null;
}

const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
type TabAction = `tab${(typeof TAB_NUMBERS)[number]}`;

function tabAction(n: (typeof TAB_NUMBERS)[number]): TabAction {
  return `tab${String(n)}` as TabAction;
}

export type ShellAction =
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'previousTab'
  | 'openRepo'
  | 'toggleLog'
  | 'toggleSidebar'
  | 'toggleDetails'
  | 'terminalSettings'
  | 'preferences'
  | 'shortcuts'
  | 'changelog'
  | 'reportBug'
  | 'openLogs'
  | 'cloneRepo'
  | 'initRepo'
  | 'commandPalette'
  | 'createBranch'
  | 'createTag'
  | 'stash'
  | 'stashPop'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'undo'
  | 'redo'
  | 'opHistory'
  | TabAction;

const tabActions = Object.fromEntries(
  TAB_NUMBERS.map((n) => [
    tabAction(n),
    () => {
      useTabsStore.getState().activateIndex(n - 1);
    },
  ]),
) as Record<TabAction, () => void>;

/** Shell commands, shared by keyboard shortcuts and the macOS menu. */
const ACTIONS: Record<ShellAction, () => void> = {
  newTab: openNewTab,
  closeTab: () => {
    closeTabAndRepo(useTabsStore.getState().activeTabId);
  },
  nextTab: () => {
    useTabsStore.getState().activateRelative(1);
  },
  previousTab: () => {
    useTabsStore.getState().activateRelative(-1);
  },
  openRepo: () => {
    const tab = selectActiveTab(useTabsStore.getState());
    // From a repo tab, the chosen repository opens in a new tab.
    void pickAndOpenRepo(tab.repoId === null ? tab.id : null);
  },
  preferences: () => {
    useShellStore.getState().setPreferencesOpen(true);
  },
  shortcuts: () => {
    useShellStore.getState().setShortcutsOpen(true);
  },
  changelog: () => {
    useShellStore.getState().setChangelogOpen(true);
  },
  reportBug: () => void reportBug(),
  openLogs: () => void openLogsFolder(),
  cloneRepo: () => {
    useShellStore.getState().showCloneDialog(welcomeTabId());
  },
  initRepo: () => {
    useShellStore.getState().showInitDialog(welcomeTabId());
  },
  toggleLog: () => {
    useShellStore.getState().toggleLog();
  },
  toggleSidebar: () => {
    togglePanel('sidebar');
  },
  toggleDetails: () => {
    togglePanel('details');
  },
  terminalSettings: () => {
    useShellStore.getState().setTerminalDialogOpen(true);
  },
  commandPalette: () => {
    usePaletteStore.getState().toggle();
  },
  createBranch: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void openCreateBranchFromHead(repoId);
  },
  createTag: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void openCreateTagFromHead(repoId);
  },
  stash: () => {
    if (activeRepoId() !== null) window.dispatchEvent(new Event(STASH_EVENT));
  },
  stashPop: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void popLatestStash(repoId);
  },
  fetch: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void fetchRepo(repoId);
  },
  pull: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void pullRepo(repoId, null);
  },
  push: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void pushRepo(repoId);
  },
  undo: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void runUndo(repoId, 'undo');
  },
  redo: () => {
    const repoId = activeRepoId();
    if (repoId !== null) void runUndo(repoId, 'redo');
  },
  opHistory: () => {
    if (activeRepoId() !== null) window.dispatchEvent(new Event(OP_HISTORY_EVENT));
  },
  ...tabActions,
};

/**
 * Actions whose keys belong to the focused text field (its own undo history): the shortcut
 * is left to the field and never reaches the app.
 */
const TEXT_FIELD_KEYS: ReadonlySet<ShellAction> = new Set(['undo', 'redo']);

/** Whether the shortcut of `action` applies when the key is pressed on `target`. */
export function shortcutApplies(action: ShellAction, target: EventTarget | null): boolean {
  return !TEXT_FIELD_KEYS.has(action) || !isTextEntry(target);
}

/** Like [`shortcutApplies`], for a binding id (`edit.redoAlt` is a second shortcut of redo). */
export function bindingApplies(bindingId: string, target: EventTarget | null): boolean {
  const guarded = [...TEXT_FIELD_KEYS].map((action) => BINDING_IDS[action]);
  return ![...guarded, 'edit.redoAlt'].includes(bindingId) || !isTextEntry(target);
}

export function isShellAction(id: string): id is ShellAction {
  return id in ACTIONS;
}

/**
 * Whether a modal dialog owns the keyboard (shortcuts and menu commands are ignored). Only
 * the modals carry `data-modal`: a Radix popover (branch selector, stashes) is a `dialog` too,
 * but the shortcuts must keep working while it is open.
 */
export function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-modal][data-state="open"]') !== null;
}

/** Runs a shell command unless a modal dialog is open. Returns whether it ran. */
export function runShellAction(action: ShellAction): boolean {
  if (modalOpen()) return false;
  ACTIONS[action]();
  return true;
}

/** Runs a shell command without the modal guard: for the palette, itself a dialog. */
export function execShellAction(action: ShellAction): void {
  ACTIONS[action]();
}

/** Default keyboard shortcuts of the shell (spec §5.15). */
export const SHORTCUTS: { shortcut: string; action: ShellAction }[] = [
  { shortcut: 'Mod+T', action: 'newTab' },
  { shortcut: 'Mod+W', action: 'closeTab' },
  { shortcut: 'Ctrl+Tab', action: 'nextTab' },
  { shortcut: 'Ctrl+Shift+Tab', action: 'previousTab' },
  ...TAB_NUMBERS.map((n) => ({ shortcut: `Mod+${String(n)}`, action: tabAction(n) })),
  { shortcut: 'Mod+O', action: 'openRepo' },
  { shortcut: 'Mod+,', action: 'preferences' },
  { shortcut: 'Mod+/', action: 'shortcuts' },
  { shortcut: 'Mod+K', action: 'commandPalette' },
  { shortcut: 'Mod+J', action: 'toggleLog' },
  { shortcut: 'Mod+Alt+B', action: 'toggleSidebar' },
  { shortcut: 'Mod+Alt+I', action: 'toggleDetails' },
  { shortcut: 'Mod+B', action: 'createBranch' },
  { shortcut: 'Mod+Shift+S', action: 'stash' },
  { shortcut: 'Mod+Shift+Alt+S', action: 'stashPop' },
  { shortcut: 'Mod+Shift+F', action: 'fetch' },
  { shortcut: 'Mod+Shift+L', action: 'pull' },
  { shortcut: 'Mod+Shift+P', action: 'push' },
  { shortcut: 'Mod+Z', action: 'undo' },
  { shortcut: 'Mod+Shift+Z', action: 'redo' },
];

/** Id of the rebindable command (F-281) a shell action stands for. */
const BINDING_IDS: Record<ShellAction, string> = {
  newTab: 'tab.new',
  closeTab: 'tab.close',
  nextTab: 'tab.next',
  previousTab: 'tab.previous',
  openRepo: 'repo.open',
  toggleLog: 'view.log',
  toggleSidebar: 'view.sidebar',
  toggleDetails: 'view.details',
  terminalSettings: 'app.terminalSettings',
  preferences: 'app.preferences',
  shortcuts: 'app.shortcuts',
  changelog: 'app.changelog',
  reportBug: 'app.reportBug',
  openLogs: 'app.openLogs',
  undo: 'edit.undo',
  redo: 'edit.redo',
  opHistory: 'edit.history',
  cloneRepo: 'repo.clone',
  initRepo: 'repo.init',
  commandPalette: 'app.palette',
  createBranch: 'git.branch.create',
  createTag: 'git.tag.create',
  stash: 'git.stash',
  stashPop: 'git.stash.pop',
  fetch: 'git.fetch',
  pull: 'git.pull',
  push: 'git.push',
  ...(Object.fromEntries(TAB_NUMBERS.map((n) => [tabAction(n), `tab.goto.${String(n)}`])) as Record<
    TabAction,
    string
  >),
};

export function bindingIdOf(action: ShellAction): string {
  return BINDING_IDS[action];
}

/** Default shortcut, before the user's changes. */
export function defaultShortcutOf(action: ShellAction): string | undefined {
  return SHORTCUTS.find((binding) => binding.action === action)?.shortcut;
}

/** The shortcut now: the user's if they rebound the action, else the default. */
export function shortcutOf(action: ShellAction): string | undefined {
  const overrides = useKeybindings.getState().overrides;
  return (
    effectiveShortcut(BINDING_IDS[action], defaultShortcutOf(action) ?? null, overrides) ??
    undefined
  );
}
