import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useTabsStore } from '../../app/tabs/tabsStore';
import { mockBackend } from '../../ipc/mockClient';
import { toast, useToastStore } from '../../ui/toastStore';
import {
  MAX_ACTIVITY,
  activityTarget,
  failedCommandOf,
  startActivityFeed,
  useActivityStore,
  type ActivityEntry,
} from './activityStore';

function entry(patch: Partial<ActivityEntry> = {}): ActivityEntry {
  return { id: 1, tone: 'info', title: 'Done', repoId: 1, repoName: 'yaggui', at: 0, ...patch };
}

const TABS = {
  tabs: [
    { id: 'a', repoId: 1 },
    { id: 'b', repoId: 2 },
    { id: 'w', repoId: null },
  ],
  activeTabId: 'a',
};

describe('activity store', () => {
  beforeEach(() => {
    useActivityStore.setState({ entries: [], unread: 0, open: false, failures: [] });
  });

  it('keeps the newest entries first, at most 20', () => {
    for (let id = 1; id <= MAX_ACTIVITY + 5; id++) {
      useActivityStore.getState().record(entry({ id }));
    }
    const { entries, unread } = useActivityStore.getState();
    expect(entries).toHaveLength(MAX_ACTIVITY);
    expect(entries[0]?.id).toBe(MAX_ACTIVITY + 5);
    expect(entries.at(-1)?.id).toBe(6);
    expect(unread).toBe(MAX_ACTIVITY);
  });

  it('counts the entries added since the popover was last opened', () => {
    const store = useActivityStore.getState();
    store.record(entry({ id: 1 }));
    store.record(entry({ id: 2 }));
    expect(useActivityStore.getState().unread).toBe(2);
    store.setOpen(true);
    expect(useActivityStore.getState().unread).toBe(0);
    // Seen as it arrives while open.
    store.record(entry({ id: 3 }));
    expect(useActivityStore.getState().unread).toBe(0);
    store.setOpen(false);
    store.record(entry({ id: 4 }));
    expect(useActivityStore.getState().unread).toBe(1);
    store.clear();
    expect(useActivityStore.getState()).toMatchObject({ entries: [], unread: 0 });
  });
});

describe('activity feed', () => {
  const initialTabs = useTabsStore.getState();
  let stop: () => void;

  beforeEach(() => {
    useActivityStore.setState({ entries: [], unread: 0, open: false, failures: [] });
    useToastStore.setState({ toasts: [] });
    stop = startActivityFeed();
  });

  afterEach(() => {
    stop();
    useTabsStore.setState({ tabs: initialTabs.tabs, activeTabId: initialTabs.activeTabId });
  });

  it('turns every toast into an entry that outlives its dismissal', () => {
    const retry = { label: 'Retry', onClick: () => undefined };
    const id = toast({ variant: 'error', title: 'Fetch failed', action: retry, repoId: 7 });
    toast({ variant: 'success', title: 'Copied', repoId: null });
    useToastStore.getState().dismiss(id);
    const { entries } = useActivityStore.getState();
    expect(entries.map((e) => [e.title, e.tone, e.repoId])).toEqual([
      ['Copied', 'success', null],
      ['Fetch failed', 'error', 7],
    ]);
    expect(entries[1]?.action).toBe(retry);
  });

  it('attributes a toast without a repository to the active tab', () => {
    const [first] = initialTabs.tabs;
    if (!first) throw new Error('no initial tab');
    useTabsStore.setState({ tabs: [{ ...first, repoId: 3 }], activeTabId: first.id });
    toast({ title: 'Undone: commit' });
    expect(useActivityStore.getState().entries[0]?.repoId).toBe(3);
  });

  it('follows a toast changed while on screen', () => {
    const id = toast({ title: 'Downloading…' });
    useToastStore.getState().update(id, { title: 'Update ready', variant: 'success' });
    expect(useActivityStore.getState().entries).toMatchObject([
      { id, title: 'Update ready', tone: 'success' },
    ]);
  });

  it('remembers the failed commands it hears of', () => {
    mockBackend.logCommand({
      repoId: 1,
      args: ['fetch'],
      cwd: null,
      startedAt: 0,
      durationMs: 1,
      exitCode: 128,
      status: 'failed',
      stdout: '',
      stderr: 'fatal',
      truncated: false,
    });
    expect(useActivityStore.getState().failures).toMatchObject([{ repoId: 1 }]);
  });
});

describe('click targets', () => {
  const failure = { id: 42, repoId: 1, at: 10_000 };

  it('links an error to the failure of its repository logged around it', () => {
    const error = entry({ tone: 'error', at: 11_000 });
    expect(failedCommandOf(error, [failure])).toBe(failure);
    // Logged just after the toast: still its command.
    expect(failedCommandOf({ ...error, at: 9_000 }, [failure])).toBe(failure);
    // Too old, another repository, or not an error.
    expect(failedCommandOf({ ...error, at: 60_000 }, [failure])).toBeUndefined();
    expect(failedCommandOf({ ...error, repoId: 2 }, [failure])).toBeUndefined();
    expect(failedCommandOf({ ...error, tone: 'warning' }, [failure])).toBeUndefined();
    // The newest one wins.
    const newer = { id: 43, repoId: 1, at: 10_500 };
    expect(failedCommandOf(error, [failure, newer])).toBe(newer);
  });

  it('opens the log on the failed command, in its tab when it is another one', () => {
    expect(activityTarget(entry({ tone: 'error', at: 10_000 }), [failure], TABS)).toEqual({
      kind: 'log',
      entryId: 42,
      tabId: null,
    });
    const other = { ...failure, repoId: 2 };
    expect(activityTarget(entry({ tone: 'error', at: 10_000, repoId: 2 }), [other], TABS)).toEqual({
      kind: 'log',
      entryId: 42,
      tabId: 'b',
    });
  });

  it('activates the tab of another repository, and does nothing otherwise', () => {
    expect(activityTarget(entry({ repoId: 2 }), [], TABS)).toEqual({ kind: 'tab', tabId: 'b' });
    expect(activityTarget(entry({ repoId: 1 }), [], TABS)).toEqual({ kind: 'none' });
    expect(activityTarget(entry({ repoId: null }), [], TABS)).toEqual({ kind: 'none' });
    // Its repository has no tab any more.
    expect(activityTarget(entry({ repoId: 9 }), [], TABS)).toEqual({ kind: 'none' });
  });
});
