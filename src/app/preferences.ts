import { applyAppearance } from './appearance';
import {
  ipc,
  unwrap,
  type YagguiClient,
  type LegacyPreferences,
  type Locale,
  type Preferences,
  type ThemePreference,
  type ThemeStyle,
} from '../ipc';

/** Keys used by M0-1, before preferences moved to the SQLite store. */
export const LEGACY_THEME_KEY = 'yaggui.theme';
export const LEGACY_LOCALE_KEY = 'yaggui.locale';

/**
 * Theme preference cached for `public/boot-theme.js`, which sets the theme before the first
 * paint (the backend store is only reachable once the app has loaded). Not a source of truth.
 */
export const THEME_CACHE_KEY = 'yaggui.themeCache';
export const STYLE_CACHE_KEY = 'yaggui.styleCache';
export const LIGHT_THEME_CACHE_KEY = 'yaggui.lightThemeCache';
export const DARK_THEME_CACHE_KEY = 'yaggui.darkThemeCache';

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  lightTheme: 'paper',
  darkTheme: 'graphite',
  style: 'standard',
  locale: null,
  terminal: null,
  terminalMode: 'integrated',
  editor: null,
  diffTool: null,
  mergeTool: null,
  diffView: 'split',
  diffOptions: {
    wrap: false,
    ignoreWhitespace: false,
    contextLines: 3,
    fullFile: false,
    markdownPreview: false,
  },
  highContrast: false,
  density: 'comfortable',
  uiFont: null,
  codeFont: null,
  fontSize: 13,
  gitPath: null,
  autoFetch: true,
  autoFetchMinutes: 10,
  prune: true,
  pullStrategy: null,
  protectedBranches: ['main', 'master', 'develop', 'release/*'],
  disabledConfirmations: [],
  gravatar: false,
  remoteTags: false,
  checkUpdates: null,
};

let current: Preferences = DEFAULT_PREFERENCES;
const listeners = new Set<() => void>();

function setCurrent(next: Preferences): void {
  current = next;
  applyAppearance(next);
  listeners.forEach((listener) => {
    listener();
  });
}

/** Calls `listener` whenever the preferences change (for `useSyncExternalStore`). */
export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isTheme(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'fr';
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Values left in `localStorage` by M0-1, or `null` if there are none. */
export function readLegacyPreferences(storage: Storage | null): LegacyPreferences | null {
  if (!storage) return null;
  const theme = storage.getItem(LEGACY_THEME_KEY);
  const locale = storage.getItem(LEGACY_LOCALE_KEY);
  if (theme === null && locale === null) return null;
  return { theme: isTheme(theme) ? theme : null, locale: isLocale(locale) ? locale : null };
}

/**
 * Loads the stored preferences. On the first launch after M0-1, imports the `localStorage`
 * values once (the backend ignores later imports), then removes them.
 * Falls back to defaults if the backend is unreachable, so the UI always starts.
 */
export async function loadPreferences(
  client: YagguiClient = ipc,
  storage: Storage | null = safeStorage(),
): Promise<Preferences> {
  try {
    const legacy = readLegacyPreferences(storage);
    if (legacy) {
      setCurrent(await unwrap(client.commands.migrateLegacyPreferences(legacy)));
      storage?.removeItem(LEGACY_THEME_KEY);
      storage?.removeItem(LEGACY_LOCALE_KEY);
    } else {
      setCurrent(await unwrap(client.commands.getPreferences()));
    }
  } catch (error) {
    console.warn('Could not load preferences, using defaults', error);
    setCurrent(DEFAULT_PREFERENCES);
  }
  return current;
}

export function cacheThemeSelection(
  selection: {
    preference: ThemePreference;
    lightTheme: string;
    darkTheme: string;
    style: ThemeStyle;
  },
  storage: Storage | null = safeStorage(),
): void {
  try {
    storage?.setItem(THEME_CACHE_KEY, selection.preference);
    storage?.setItem(LIGHT_THEME_CACHE_KEY, selection.lightTheme);
    storage?.setItem(DARK_THEME_CACHE_KEY, selection.darkTheme);
    storage?.setItem(STYLE_CACHE_KEY, selection.style);
  } catch {
    // Storage full or blocked: only the first paint of the next launch is affected.
  }
}

/** Last loaded or saved preferences. */
export function currentPreferences(): Preferences {
  return current;
}

/**
 * Saves run one after the other: every save sends the whole object, so two in flight at once
 * could commit in either order and leave the store (or the screen) with the older value.
 */
let pendingSave: Promise<void> | null = null;
/** Number of saves enqueued so far: a response is final only for the last one. */
let saveSeq = 0;

/**
 * Sends the preferences now when no save is in flight, else once the previous one settles,
 * as they are at that moment (later edits included: the last write wins). Resolves to what
 * the backend stored, with the sequence number of this save.
 */
function enqueueSave(client: YagguiClient): { seq: number; save: Promise<Preferences> } {
  const send = () => unwrap(client.commands.setPreferences(current));
  const save = pendingSave ? pendingSave.then(send) : send();
  const settled: Promise<void> = save.then(
    () => {
      if (pendingSave === settled) pendingSave = null;
    },
    () => {
      if (pendingSave === settled) pendingSave = null;
    },
  );
  pendingSave = settled;
  saveSeq += 1;
  return { seq: saveSeq, save };
}

/** Persists a change; the UI has already applied it, so failures are only logged. */
export function savePreferences(patch: Partial<Preferences>, client: YagguiClient = ipc): void {
  setCurrent({ ...current, ...patch });
  void enqueueSave(client).save.catch((error: unknown) => {
    console.warn('Could not save preferences', error);
  });
}

/**
 * Applies a change at once, then saves it and waits for the backend, which validates it (a Git
 * path that does not work is refused). On failure the previous preferences come back and the
 * error is thrown (`YagguiIpcError`). Changes made meanwhile build on the optimistic value, so
 * two quick edits of different settings never overwrite each other.
 */
export async function updatePreferences(
  patch: Partial<Preferences>,
  client: YagguiClient = ipc,
): Promise<Preferences> {
  const previous = current;
  const keys = Object.keys(patch) as (keyof Preferences)[];
  setCurrent({ ...current, ...patch });
  const { seq, save } = enqueueSave(client);
  try {
    const stored = await save;
    // Keep what was typed meanwhile; the backend only normalizes the fields of this call. A
    // save enqueued since carries the newer values: its own response will settle them.
    if (seq === saveSeq) setCurrent({ ...current, ...pick(stored, keys) });
    return current;
  } catch (error) {
    setCurrent({ ...current, ...pick(previous, keys) });
    throw error;
  }
}

function pick<K extends keyof Preferences>(source: Preferences, keys: K[]): Pick<Preferences, K> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<Preferences, K>;
}

/** Saves the terminal preference and waits for the backend, which validates it. */
export async function saveTerminalPreference(
  terminal: string | null,
  client: YagguiClient = ipc,
): Promise<Preferences> {
  return updatePreferences({ terminal }, client);
}
