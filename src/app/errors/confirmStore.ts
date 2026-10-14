import { create } from 'zustand';

import type { ConfirmationKind } from '../../ipc';
import { currentPreferences } from '../preferences';

export interface ConfirmRequest {
  /**
   * Which preference can turn this confirmation off (F-324). Leave it out for confirmations
   * that protect the user from a risk they cannot see (safe.directory, a lock removal).
   */
  kind?: ConfirmationKind;
  title: string;
  description: string;
  /** Exact Git command that will run, shown for transparency (spec §6.6). */
  command?: string;
  confirmLabel: string;
  danger?: boolean;
  /** Nothing to confirm, only to read: no Cancel button, the confirm label closes it. */
  informational?: boolean;
  /** Concrete effect of the action (e.g. the files that will be discarded). */
  items?: ConfirmItem[];
  /** Entries left out of `items` because the list is capped. */
  moreItems?: number;
}

export interface ConfirmItem {
  label: string;
  /** What happens to this entry ("will be deleted"), shown after the label. */
  note?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmStore {
  pending: PendingConfirm | null;
  settle: (confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmStore>()((set, get) => ({
  pending: null,
  settle: (confirmed) => {
    get().pending?.resolve(confirmed);
    set({ pending: null });
  },
}));

/** Whether the user turned this confirmation off. The force push one cannot be. */
export function isConfirmationDisabled(kind: ConfirmationKind | undefined): boolean {
  return (
    kind !== undefined &&
    kind !== 'forcePush' &&
    currentPreferences().disabledConfirmations.includes(kind)
  );
}

/**
 * Asks for confirmation in a modal dialog; resolves `false` if dismissed, and `true` at
 * once when the request's `kind` is turned off in the preferences.
 */
export function confirm(request: ConfirmRequest): Promise<boolean> {
  if (isConfirmationDisabled(request.kind)) return Promise.resolve(true);
  useConfirmStore.getState().settle(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({ pending: { ...request, resolve } });
  });
}
