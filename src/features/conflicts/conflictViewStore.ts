import { create } from 'zustand';

/**
 * The conflicted file open in the 3-way merge editor (M3-3), per tab. The editor replaces the
 * graph, like a diff does; its view id is `conflict:<path>` (`conflictViewId`).
 */
export interface ConflictViewSelection {
  repoId: number;
  path: string;
}

interface ConflictViewState {
  open: Record<string, ConflictViewSelection | undefined>;
}

export const useConflictViewStore = create<ConflictViewState>(() => ({ open: {} }));

export function conflictViewId(path: string): string {
  return `conflict:${path}`;
}

/** Inverse of `conflictViewId`; `null` for any other view id. */
export function conflictPathOf(viewId: string): string | null {
  return viewId.startsWith('conflict:') ? viewId.slice('conflict:'.length) : null;
}

/** Asks whether the file on screen may be left (unsaved edits); `true` to go on. */
export type ConflictLeaveGuard = () => Promise<boolean>;

const guards = new Map<string, ConflictLeaveGuard>();

/** Set by the editor of `tabId` while it holds unsaved choices; `null` once there are none. */
export function setConflictLeaveGuard(tabId: string, guard: ConflictLeaveGuard | null): void {
  if (guard) guards.set(tabId, guard);
  else guards.delete(tabId);
}

/**
 * "Resolve…": opens the conflict editor on `path` in place of the graph of `tabId`. Leaving a
 * file with unsaved edits asks first, unless `force` (the editor itself, after saving). Returns
 * whether the file was opened.
 */
export async function openConflictView(
  tabId: string,
  selection: ConflictViewSelection,
  { force = false }: { force?: boolean } = {},
): Promise<boolean> {
  const current = useConflictViewStore.getState().open[tabId];
  const other =
    current !== undefined &&
    (current.repoId !== selection.repoId || current.path !== selection.path);
  const guard = guards.get(tabId);
  if (other && !force && guard && !(await guard())) return false;
  useConflictViewStore.setState((state) => ({ open: { ...state.open, [tabId]: selection } }));
  return true;
}

export function closeConflictView(tabId: string): void {
  if (useConflictViewStore.getState().open[tabId] === undefined) return;
  useConflictViewStore.setState((state) => ({ open: { ...state.open, [tabId]: undefined } }));
}

export function useConflictView(tabId: string): ConflictViewSelection | undefined {
  return useConflictViewStore((state) => state.open[tabId]);
}
