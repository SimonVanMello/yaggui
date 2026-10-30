import type {
  IgnoredKey,
  KeybindingChange,
  KeybindingOverride,
  PreferenceChange,
  Preferences,
  PreferencesImportPreview,
  ShortcutState,
  YagguiError,
} from '../bindings';
import { isValidShortcut } from './settings';

/** `store/prefs_sync.rs` in Rust: the same file format, keys and checks. */
export const PREFERENCES_FORMAT = 'yaggui-preferences';
export const PREFERENCES_FORMAT_VERSION = 1;
/** Like `MAX_KEYBINDINGS` in `store/prefs_sync.rs`. */
const MAX_KEYBINDINGS = 1000;

const PORTABLE = [
  'theme',
  'lightTheme',
  'darkTheme',
  'style',
  'locale',
  'terminalMode',
  'diffView',
  'diffOptions',
  'highContrast',
  'density',
  'uiFont',
  'codeFont',
  'fontSize',
  'autoFetch',
  'autoFetchMinutes',
  'prune',
  'pullStrategy',
  'protectedBranches',
  'disabledConfirmations',
  'gravatar',
  'remoteTags',
] as const satisfies readonly (keyof Preferences)[];

const MACHINE_SPECIFIC = [
  'gitPath',
  'terminal',
  'editor',
  'diffTool',
  'mergeTool',
  'checkUpdates',
] as const satisfies readonly (keyof Preferences)[];

type Json = Record<string, unknown>;

const isString = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const oneOf =
  (...values: string[]) =>
  (v: unknown) =>
    isString(v) && values.includes(v);
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);
const listOf = (check: (v: unknown) => boolean) => (v: unknown) =>
  Array.isArray(v) && v.every(check);

/** What serde accepts for each portable setting (type and enum variants, not ranges). */
const SHAPES: Record<(typeof PORTABLE)[number], (v: unknown) => boolean> = {
  theme: oneOf('light', 'dark', 'system'),
  lightTheme: isString,
  darkTheme: isString,
  style: oneOf('standard', 'terminal'),
  locale: orNull(oneOf('en', 'fr')),
  terminalMode: oneOf('integrated', 'external'),
  diffView: oneOf('unified', 'split'),
  diffOptions: (v) => {
    const o = v as Json | null;
    return (
      typeof o === 'object' &&
      o !== null &&
      isBool(o.wrap) &&
      isBool(o.ignoreWhitespace) &&
      isInt(o.contextLines) &&
      o.contextLines >= 0 &&
      o.contextLines <= 0xffffffff &&
      isBool(o.fullFile) &&
      (o.markdownPreview === undefined || isBool(o.markdownPreview))
    );
  },
  highContrast: isBool,
  density: oneOf('comfortable', 'compact'),
  uiFont: orNull(isString),
  codeFont: orNull(isString),
  fontSize: isInt,
  autoFetch: isBool,
  autoFetchMinutes: isInt,
  prune: isBool,
  pullStrategy: orNull(oneOf('ffOnly', 'merge', 'rebase')),
  protectedBranches: listOf(isString),
  disabledConfirmations: listOf(oneOf('discardChanges', 'deleteTag', 'dropStash', 'forcePush')),
  gravatar: isBool,
  remoteTags: isBool,
};

function invalidFile(detail: string): YagguiError {
  return {
    code: 'preferencesFileInvalid',
    message: {
      en: 'This is not a valid yaggui preferences file. Nothing was changed.',
      fr: "Ce n'est pas un fichier de préférences yaggui valide. Rien n'a été modifié. Vérifie que tu as choisi le bon fichier.",
    },
    action: null,
    detail,
    payload: null,
  };
}

function tooNew(found: number): YagguiError {
  const supported = PREFERENCES_FORMAT_VERSION;
  return {
    code: 'preferencesFileTooNew',
    message: {
      en: `This file uses format version ${String(found)}, but this yaggui reads up to version ${String(supported)}. Update yaggui to import it.`,
      fr: `Ce fichier utilise la version ${String(found)} du format, mais cette version de yaggui lit jusqu'à la version ${String(supported)}. Mets yaggui à jour pour l'importer.`,
    },
    action: null,
    detail: null,
    payload: null,
  };
}

export function exportPreferencesText(
  prefs: Preferences,
  overrides: readonly KeybindingOverride[],
): string {
  const preferences = Object.fromEntries(PORTABLE.map((key) => [key, prefs[key]]));
  const file = {
    format: PREFERENCES_FORMAT,
    version: PREFERENCES_FORMAT_VERSION,
    preferences,
    keybindings: overrides,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

interface Parsed {
  preferences: Preferences;
  keybindings: KeybindingOverride[];
  ignored: IgnoredKey[];
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseKeybindings(value: unknown): KeybindingOverride[] | YagguiError {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return invalidFile('"keybindings" must be a list of { "action", "shortcut" }');
  }
  if (value.length > MAX_KEYBINDINGS) {
    return invalidFile(
      `"keybindings" holds ${String(value.length)} entries, at most ${String(MAX_KEYBINDINGS)} are supported`,
    );
  }
  const byAction = new Map<string, KeybindingOverride>();
  for (const entry of value as unknown[]) {
    if (
      !isObject(entry) ||
      !isString(entry.action) ||
      // A missing shortcut is `None` for serde: the shortcut is removed.
      !(entry.shortcut === undefined || entry.shortcut === null || isString(entry.shortcut))
    ) {
      return invalidFile('"keybindings" must be a list of { "action", "shortcut" }');
    }
    const shortcut = entry.shortcut ?? null;
    const shortcutOk = shortcut === null || isValidShortcut(shortcut);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry.action) || !shortcutOk) {
      return invalidFile(`"keybindings": "${entry.action}" cannot be bound like this`);
    }
    byAction.set(entry.action, { action: entry.action, shortcut });
  }
  return [...byAction.values()].sort((a, b) => (a.action < b.action ? -1 : 1));
}

/** The value as serde reads it into its Rust type: struct fields only, defaults filled in. */
function typed(key: string, value: unknown): unknown {
  if (key !== 'diffOptions') return value;
  const o = value as Json;
  return {
    wrap: o.wrap,
    ignoreWhitespace: o.ignoreWhitespace,
    contextLines: o.contextLines,
    fullFile: o.fullFile,
    markdownPreview: o.markdownPreview ?? false,
  };
}

/** Parses and validates `text` against the current preferences; `normalize` is the mock's. */
export function parsePreferencesFile(
  text: string,
  current: Preferences,
  normalize: (prefs: Preferences) => { ok: Preferences } | { error: YagguiError },
): Parsed | YagguiError {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (failure) {
    return invalidFile(`not valid JSON: ${String(failure)}`);
  }
  if (!isObject(root)) return invalidFile('the top level must be an object');
  if (root.format !== PREFERENCES_FORMAT) {
    return invalidFile(`"format" must be "${PREFERENCES_FORMAT}"`);
  }
  if (typeof root.version !== 'number' || !Number.isInteger(root.version) || root.version < 1) {
    return invalidFile('"version" must be a positive integer');
  }
  if (root.version > PREFERENCES_FORMAT_VERSION) return tooNew(root.version);
  if (root.preferences !== undefined && !isObject(root.preferences)) {
    return invalidFile('"preferences" must be an object');
  }
  const keybindings = parseKeybindings(root.keybindings);
  if ('code' in keybindings) return keybindings;

  const incoming: Json = isObject(root.preferences) ? { ...root.preferences } : {};
  // Exported before the color themes: the Terminal style brought its own dark colors.
  if (incoming.style === 'terminal' && !('darkTheme' in incoming)) {
    incoming.darkTheme = 'terminal';
    incoming.theme = 'dark';
  }
  let working = current;
  const ignored: IgnoredKey[] = [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if ((MACHINE_SPECIFIC as readonly string[]).includes(key)) {
      ignored.push({ key, reason: 'machineSpecific' });
    } else if (!(PORTABLE as readonly string[]).includes(key)) {
      ignored.push({ key, reason: 'unknown' });
    } else if (!SHAPES[key as (typeof PORTABLE)[number]](value)) {
      problems.push(`${key}: invalid value`);
    } else {
      const checked = normalize({ ...working, [key]: typed(key, value) });
      if ('error' in checked) problems.push(`${key}: ${checked.error.message.en}`);
      else working = checked.ok;
    }
  }
  if (problems.length > 0) return invalidFile(problems.join('; '));
  return { preferences: working, keybindings, ignored };
}

export function preferenceChanges(before: Preferences, after: Preferences): PreferenceChange[] {
  return PORTABLE.flatMap((key) => {
    const [b, a] = [JSON.stringify(before[key]), JSON.stringify(after[key])];
    return b === a ? [] : [{ key, before: b, after: a }];
  });
}

export function keybindingChanges(
  current: readonly KeybindingOverride[],
  incoming: readonly KeybindingOverride[],
): KeybindingChange[] {
  const state = (list: readonly KeybindingOverride[], action: string): ShortcutState => {
    const found = list.find((entry) => entry.action === action);
    return found ? { custom: true, shortcut: found.shortcut } : { custom: false, shortcut: null };
  };
  const actions = [...new Set([...current, ...incoming].map((entry) => entry.action))].sort();
  return actions.flatMap((action) => {
    const [before, after] = [state(current, action), state(incoming, action)];
    return before.custom === after.custom && before.shortcut === after.shortcut
      ? []
      : [{ action, before, after }];
  });
}

export function previewOf(
  path: string,
  parsed: Parsed,
  current: Preferences,
  overrides: readonly KeybindingOverride[],
): PreferencesImportPreview {
  return {
    path,
    changes: preferenceChanges(current, parsed.preferences),
    keybindingChanges: keybindingChanges(overrides, parsed.keybindings),
    ignored: parsed.ignored,
  };
}

/** The file the mock "picker" opens when none was queued: an export from another machine. */
export function sampleImportFile(): string {
  const file = {
    format: PREFERENCES_FORMAT,
    version: PREFERENCES_FORMAT_VERSION,
    preferences: {
      theme: 'dark',
      density: 'compact',
      fontSize: 15,
      diffView: 'unified',
      autoFetchMinutes: 5,
      protectedBranches: ['main', 'release/*', 'hotfix/*'],
      editor: 'code',
      gitPath: 'C:\\Program Files\\Git\\bin\\git.exe',
      commitGraphStyle: 'lanes',
    },
    keybindings: [
      { action: 'tab.new', shortcut: 'Mod+Alt+N' },
      { action: 'git.push', shortcut: null },
    ],
  };
  return JSON.stringify(file, null, 2);
}
