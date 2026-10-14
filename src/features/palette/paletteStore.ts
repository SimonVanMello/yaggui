import { create } from 'zustand';

const RECENTS_KEY = 'yaggui.palette.recents';
export const MAX_RECENTS = 8;

function loadRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string').slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

function saveRecents(recents: readonly string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Recents are a convenience: private mode or a full quota must not break the palette.
  }
}

/** Puts `key` first, without duplicates, capped at `MAX_RECENTS`. */
export function pushRecentKey(recents: readonly string[], key: string): string[] {
  return [key, ...recents.filter((existing) => existing !== key)].slice(0, MAX_RECENTS);
}

interface PaletteStore {
  open: boolean;
  /** Item keys (`action:tab.new`, `ref:main`…), most recent first. */
  recents: string[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  remember: (key: string) => void;
}

export const usePaletteStore = create<PaletteStore>()((set) => ({
  open: false,
  recents: loadRecents(),
  setOpen: (open) => {
    set({ open });
  },
  toggle: () => {
    set((state) => ({ open: !state.open }));
  },
  remember: (key) => {
    set((state) => {
      const recents = pushRecentKey(state.recents, key);
      saveRecents(recents);
      return { recents };
    });
  },
}));
