import type { ConfigEntry } from '../../ipc';
import type { MessageKey } from '../../i18n/i18n';

/**
 * Git lowercases the section and the variable name, not the subsection
 * (`branch.Feat/X.remote` → `branch.Feat/X.remote`, `User.Name` → `user.name`).
 */
export function normalizeConfigKey(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

/** Value of each key; the last one wins, as in Git. A bare key reads as `true`. */
export function configValues(entries: readonly ConfigEntry[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const entry of entries) values.set(normalizeConfigKey(entry.key), entry.value ?? 'true');
  return values;
}

/** Keys set several times (`remote.origin.fetch`): shown as they are, not editable in place. */
export function multiValuedKeys(entries: readonly ConfigEntry[]): Set<string> {
  const seen = new Set<string>();
  const multiple = new Set<string>();
  for (const entry of entries) {
    const key = normalizeConfigKey(entry.key);
    if (seen.has(key)) multiple.add(key);
    seen.add(key);
  }
  return multiple;
}

export interface TextField {
  kind: 'text';
  key: string;
  label: MessageKey;
  hint?: MessageKey;
}

export interface ChoiceField {
  kind: 'choice';
  key: string;
  label: MessageKey;
  hint?: MessageKey;
  /** Values Git accepts; the screen adds "not set". */
  values: readonly string[];
}

export type ConfigField = TextField | ChoiceField;

/** The keys most people touch (F-325): the rest goes through the raw editor. */
export const COMMON_FIELDS: readonly ConfigField[] = [
  { kind: 'text', key: 'user.name', label: 'gitconfig.field.userName' },
  { kind: 'text', key: 'user.email', label: 'gitconfig.field.userEmail' },
  {
    kind: 'choice',
    key: 'pull.rebase',
    label: 'gitconfig.field.pullRebase',
    hint: 'gitconfig.field.pullRebase.hint',
    values: ['false', 'true', 'merges', 'interactive'],
  },
  {
    kind: 'choice',
    key: 'core.autocrlf',
    label: 'gitconfig.field.autocrlf',
    hint: 'gitconfig.field.autocrlf.hint',
    values: ['false', 'true', 'input'],
  },
  {
    kind: 'text',
    key: 'init.defaultBranch',
    label: 'gitconfig.field.defaultBranch',
    hint: 'gitconfig.field.defaultBranch.hint',
  },
  {
    kind: 'choice',
    key: 'commit.gpgsign',
    label: 'gitconfig.field.gpgsign',
    hint: 'gitconfig.field.gpgsign.hint',
    values: ['true', 'false'],
  },
  {
    kind: 'choice',
    key: 'gpg.format',
    label: 'gitconfig.field.gpgFormat',
    values: ['openpgp', 'ssh', 'x509'],
  },
  {
    kind: 'text',
    key: 'user.signingkey',
    label: 'gitconfig.field.signingKey',
    hint: 'gitconfig.field.signingKey.hint',
  },
];

/** Entries matching a filter on the key or the value, in file order. */
export function filterEntries(
  entries: readonly ConfigEntry[],
  filter: string,
): readonly ConfigEntry[] {
  const query = filter.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter(
    (entry) =>
      entry.key.toLowerCase().includes(query) ||
      (entry.value?.toLowerCase().includes(query) ?? false),
  );
}
