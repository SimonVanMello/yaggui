import { create } from 'zustand';

import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc } from '../../ipc';
import {
  useToastStore,
  type ToastAction,
  type ToastItem,
  type ToastVariant,
} from '../../ui/toastStore';
import { repoDisplayName, useRepoSessions } from '../repo/repoSessions';

/** Entries kept: the session's last notifications, not a history. */
export const MAX_ACTIVITY = 20;

export interface ActivityEntry {
  /** Id of the toast it comes from. */
  id: number;
  tone: ToastVariant;
  title: string;
  description?: string;
  /** Repository it is about; `null` for the app itself. */
  repoId: number | null;
  /** Its display name when the notification was shown (the tab may be gone since). */
  repoName: string | null;
  /** Milliseconds since the epoch. */
  at: number;
  /** The toast's button ("Retry", "Pull then push"…), kept on the entry. */
  action?: ToastAction;
}

interface ActivityState {
  /** Newest first, at most `MAX_ACTIVITY`. */
  entries: ActivityEntry[];
  /** Entries added since the popover was last opened. */
  unread: number;
  open: boolean;
  /** Last failed Git commands, oldest first. */
  failures: FailedCommand[];
  record: (entry: ActivityEntry) => void;
  update: (id: number, patch: Partial<Omit<ActivityEntry, 'id'>>) => void;
  setOpen: (open: boolean) => void;
  clear: () => void;
  commandFailed: (failure: FailedCommand) => void;
}

export const useActivityStore = create<ActivityState>()((set) => ({
  entries: [],
  unread: 0,
  open: false,
  failures: [],
  record: (entry) => {
    set((state) => ({
      entries: [entry, ...state.entries].slice(0, MAX_ACTIVITY),
      // Seen at once when the popover is open; never more unread than entries listed.
      unread: state.open ? 0 : Math.min(state.unread + 1, MAX_ACTIVITY),
    }));
  },
  update: (id, patch) => {
    set((state) => ({
      entries: state.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    }));
  },
  setOpen: (open) => {
    set(open ? { open, unread: 0 } : { open });
  },
  clear: () => {
    set({ entries: [], unread: 0 });
  },
  commandFailed: (failure) => {
    set((state) => ({ failures: [...state.failures, failure].slice(-MAX_FAILURES) }));
  },
}));

/** The entry a toast becomes: its repository is the active tab's when it names none. */
export function activityFromToast(
  toast: ToastItem,
  at: number,
  activeRepoId: number | null,
  nameOf: (repoId: number) => string | null,
): ActivityEntry {
  const repoId = toast.repoId === undefined ? activeRepoId : toast.repoId;
  return {
    id: toast.id,
    tone: toast.variant,
    title: toast.title,
    description: toast.description,
    repoId,
    repoName: repoId === null ? null : nameOf(repoId),
    at,
    action: toast.action,
  };
}

function repoName(repoId: number): string | null {
  return repoDisplayName(useRepoSessions.getState().sessions[repoId], undefined);
}

let unsubscribe: (() => void) | undefined;

/**
 * Every toast shown becomes an activity entry, whether it is dismissed or not; a toast
 * changed while on screen (update progress) changes its entry. Failed Git commands are
 * remembered to open the command log from an error entry. Idempotent.
 */
export function startActivityFeed(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = useToastStore.subscribe((state, previous) => {
    const before = new Map(previous.toasts.map((toast) => [toast.id, toast]));
    const activity = useActivityStore.getState();
    for (const toast of state.toasts) {
      const old = before.get(toast.id);
      if (!old) {
        const repoId = selectActiveTab(useTabsStore.getState()).repoId;
        activity.record(activityFromToast(toast, Date.now(), repoId, repoName));
      } else if (old !== toast) {
        activity.update(toast.id, {
          tone: toast.variant,
          title: toast.title,
          description: toast.description,
          action: toast.action,
        });
      }
    }
  });
  const offLog = ipc.events.subscribe('commandLogged', ({ entry }) => {
    if (entry.status === 'success') return;
    useActivityStore
      .getState()
      .commandFailed({ id: entry.id, repoId: entry.repoId, at: Date.now() });
  });
  unsubscribe = () => {
    off();
    offLog();
    unsubscribe = undefined;
  };
  return unsubscribe;
}

/** A failed Git command, when the app heard of it (`command-logged`). */
export interface FailedCommand {
  /** Command log entry id. */
  id: number;
  repoId: number | null;
  /** Milliseconds since the epoch. */
  at: number;
}

/** Failed commands remembered to link the error entries to the command log. */
const MAX_FAILURES = 50;
/** How long before an error notification its failed command may have been logged. */
const FAILED_COMMAND_BEFORE_MS = 30_000;
/** And after: the log event and the command's result travel separately. */
const FAILED_COMMAND_AFTER_MS = 2_000;

/**
 * Failed Git command behind an error entry: the newest failure of its repository logged
 * shortly before (or just after) the notification. Matched on the time the app heard of it,
 * not the command's own clock, so a late `command-logged` still links.
 */
export function failedCommandOf(
  entry: Pick<ActivityEntry, 'tone' | 'repoId' | 'at'>,
  failures: readonly FailedCommand[],
): FailedCommand | undefined {
  if (entry.tone !== 'error') return undefined;
  return failures.findLast(
    (failure) =>
      (entry.repoId === null || failure.repoId === entry.repoId) &&
      failure.at >= entry.at - FAILED_COMMAND_BEFORE_MS &&
      failure.at <= entry.at + FAILED_COMMAND_AFTER_MS,
  );
}

export type ActivityTarget =
  | { kind: 'log'; entryId: number; tabId: string | null }
  | { kind: 'tab'; tabId: string }
  | { kind: 'none' };

/**
 * What clicking an entry does: an error with a failed command opens the command log on it
 * (and its repository's tab, when it is another one); an entry of another open repository
 * activates its tab.
 */
export function activityTarget(
  entry: ActivityEntry,
  failures: readonly FailedCommand[],
  tabs: { tabs: readonly { id: string; repoId: number | null }[]; activeTabId: string },
): ActivityTarget {
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  const tab =
    entry.repoId === null || active?.repoId === entry.repoId
      ? undefined
      : tabs.tabs.find((candidate) => candidate.repoId === entry.repoId);
  const command = failedCommandOf(entry, failures);
  if (command) return { kind: 'log', entryId: command.id, tabId: tab?.id ?? null };
  if (tab) return { kind: 'tab', tabId: tab.id };
  return { kind: 'none' };
}
