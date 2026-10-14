import { create } from 'zustand';

import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc, unwrap, type KeybindingsFile } from '../../ipc';
import { toast } from '../../ui/toastStore';
import type { Overrides } from './resolve';

interface KeybindingsState {
  overrides: Overrides;
  /** Path of `keybindings.json`, to show it in the editor. */
  path: string | null;
  /** The file could not be read as a whole, or entries were skipped. */
  problem: string | null;
  /** Re-reads the file (startup, and each time the editor opens: it can be edited by hand). */
  load: () => Promise<void>;
  /** Binds `id` to `shortcut`; `null` leaves it without shortcut. */
  set: (id: string, shortcut: string | null) => Promise<void>;
  /** Several bindings in one write (reassigning a shortcut unbinds its previous owner). */
  setMany: (changes: Readonly<Record<string, string | null>>) => Promise<void>;
  /** Back to the default of `id`. */
  reset: (id: string) => Promise<void>;
  resetAll: () => Promise<void>;
}

function toOverrides(file: KeybindingsFile): Overrides {
  return Object.fromEntries(file.overrides.map((entry) => [entry.action, entry.shortcut]));
}

function toEntries(overrides: Overrides) {
  return Object.entries(overrides).map(([action, shortcut]) => ({ action, shortcut }));
}

export const useKeybindings = create<KeybindingsState>()((set, get) => {
  const apply = (file: KeybindingsFile) => {
    set({ overrides: toOverrides(file), path: file.path, problem: file.problem });
  };

  /** Applies at once, saves, and puts the previous bindings back if the backend refuses. */
  const save = async (next: Overrides) => {
    const previous = get().overrides;
    set({ overrides: next });
    try {
      apply(await unwrap(ipc.commands.setKeybindings(toEntries(next))));
    } catch (failure) {
      set({ overrides: previous });
      const locale = useI18nStore.getState().locale;
      toast({ variant: 'error', title: translate(locale, 'keybindings.saveFailed') });
      console.warn('Could not save keybindings.json', failure);
    }
  };

  return {
    overrides: {},
    path: null,
    problem: null,
    load: async () => {
      try {
        apply(await unwrap(ipc.commands.getKeybindings()));
      } catch (failure) {
        console.warn('Could not read keybindings.json', failure);
      }
    },
    set: (id, shortcut) => save({ ...get().overrides, [id]: shortcut }),
    setMany: (changes) => save({ ...get().overrides, ...changes }),
    reset: (id) => {
      const rest = Object.fromEntries(
        Object.entries(get().overrides).filter(([key]) => key !== id),
      );
      return save(rest);
    },
    resetAll: () => save({}),
  };
});
