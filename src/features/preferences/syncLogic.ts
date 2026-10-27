import type { MessageKey } from '../../i18n/i18n';
import type { IgnoredKey, PreferencesImportPreview } from '../../ipc';

/** Label of each setting that can be in a preferences file (`PORTABLE` in `prefs_sync.rs`). */
const PREF_LABELS: Record<string, MessageKey> = {
  theme: 'prefs.sync.key.theme',
  style: 'prefs.sync.key.style',
  locale: 'prefs.sync.key.locale',
  terminalMode: 'prefs.sync.key.terminalMode',
  diffView: 'prefs.sync.key.diffView',
  diffOptions: 'prefs.sync.key.diffOptions',
  highContrast: 'prefs.sync.key.highContrast',
  density: 'prefs.sync.key.density',
  uiFont: 'prefs.sync.key.uiFont',
  codeFont: 'prefs.sync.key.codeFont',
  fontSize: 'prefs.sync.key.fontSize',
  autoFetch: 'prefs.sync.key.autoFetch',
  autoFetchMinutes: 'prefs.sync.key.autoFetchMinutes',
  prune: 'prefs.sync.key.prune',
  pullStrategy: 'prefs.sync.key.pullStrategy',
  protectedBranches: 'prefs.sync.key.protectedBranches',
  disabledConfirmations: 'prefs.sync.key.disabledConfirmations',
  gravatar: 'prefs.sync.key.gravatar',
  remoteTags: 'prefs.sync.key.remoteTags',
};

/** The label of a setting, or `null` for a key this version does not know. */
export function preferenceLabel(key: string): MessageKey | null {
  return PREF_LABELS[key] ?? null;
}

/** Words used to show a value; the caller translates them. */
export interface ValueWords {
  none: string;
  yes: string;
  no: string;
  empty: string;
}

/** A JSON value from the backend, in words a person reads. */
export function formatPrefValue(json: string, words: ValueWords): string {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return json;
  }
  return formatValue(value, words);
}

function formatValue(value: unknown, words: ValueWords): string {
  if (value === null || value === undefined) return words.none;
  if (typeof value === 'boolean') return value ? words.yes : words.no;
  if (typeof value === 'string') return value === '' ? words.empty : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? words.empty : value.map((v) => formatValue(v, words)).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, v]) => `${key}: ${formatValue(v, words)}`)
      .join(', ');
  }
  return JSON.stringify(value);
}

/** Left-out keys of one kind, in file order. */
export function ignoredKeys(preview: PreferencesImportPreview, reason: IgnoredKey['reason']) {
  return preview.ignored.filter((entry) => entry.reason === reason).map((entry) => entry.key);
}

/** Whether applying the file would change anything. */
export function hasChanges(preview: PreferencesImportPreview): boolean {
  return preview.changes.length > 0 || preview.keybindingChanges.length > 0;
}
