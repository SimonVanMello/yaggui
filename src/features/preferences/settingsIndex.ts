import { translate, type Locale, type MessageKey } from '../../i18n/i18n';
import type { IconName } from '../../ui/Icon';

export type SectionId =
  'general' | 'appearance' | 'display' | 'keybindings' | 'tools' | 'sync' | 'safety' | 'gitconfig';

export interface SectionInfo {
  id: SectionId;
  group: 'app' | 'git';
  icon: IconName;
  label: MessageKey;
  description: MessageKey;
}

/** The sections of the Preferences dialog, in display order. */
export const SECTIONS: readonly SectionInfo[] = [
  {
    id: 'general',
    group: 'app',
    icon: 'settings',
    label: 'prefs.section.general',
    description: 'prefs.section.general.description',
  },
  {
    id: 'appearance',
    group: 'app',
    icon: 'palette',
    label: 'prefs.section.appearance',
    description: 'prefs.section.appearance.description',
  },
  {
    id: 'display',
    group: 'app',
    icon: 'type',
    label: 'prefs.section.display',
    description: 'prefs.section.display.description',
  },
  {
    id: 'keybindings',
    group: 'app',
    icon: 'keyboard',
    label: 'prefs.section.keybindings',
    description: 'prefs.section.keybindings.description',
  },
  {
    id: 'tools',
    group: 'app',
    icon: 'tool',
    label: 'prefs.section.tools',
    description: 'prefs.section.tools.description',
  },
  {
    id: 'sync',
    group: 'git',
    icon: 'fetch',
    label: 'prefs.section.sync',
    description: 'prefs.section.sync.description',
  },
  {
    id: 'safety',
    group: 'git',
    icon: 'shield',
    label: 'prefs.section.safety',
    description: 'prefs.section.safety.description',
  },
  {
    id: 'gitconfig',
    group: 'git',
    icon: 'branch',
    label: 'prefs.section.gitconfig',
    description: 'prefs.section.gitconfig.description',
  },
];

export function isSectionId(value: string | null): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}

/**
 * A setting the search can find. `id` is what the section wraps the setting's row with
 * (`<Setting id>`); `keywords` are extra words, in no particular language (Git keys, synonyms).
 */
export interface SettingEntry {
  id: string;
  section: SectionId;
  label: MessageKey;
  hint?: MessageKey;
  keywords?: string;
}

export const SETTINGS: readonly SettingEntry[] = [
  {
    id: 'language',
    section: 'general',
    label: 'settings.language',
    keywords: 'locale english français',
  },
  {
    id: 'checkUpdates',
    section: 'general',
    label: 'prefs.checkUpdates',
    hint: 'prefs.checkUpdates.hint',
    keywords: 'release',
  },
  {
    id: 'checkUpdatesNow',
    section: 'general',
    label: 'prefs.checkUpdates.now',
    keywords: 'update release',
  },
  { id: 'version', section: 'general', label: 'prefs.version', keywords: 'changelog' },
  {
    id: 'backup',
    section: 'general',
    label: 'prefs.backup',
    hint: 'prefs.backup.hint',
    keywords: 'json sync',
  },

  {
    id: 'followSystem',
    section: 'appearance',
    label: 'prefs.followSystem',
    hint: 'prefs.followSystem.hint',
    keywords: 'os auto',
  },
  {
    id: 'theme',
    section: 'appearance',
    label: 'settings.theme',
    keywords: 'color colour couleur palette',
  },
  {
    id: 'style',
    section: 'appearance',
    label: 'prefs.style',
    hint: 'prefs.style.hint',
    keywords: 'monospace',
  },
  {
    id: 'contrast',
    section: 'appearance',
    label: 'prefs.contrast',
    hint: 'prefs.contrast.hint',
    keywords: 'accessibility a11y',
  },

  { id: 'uiFont', section: 'display', label: 'prefs.uiFont', hint: 'prefs.font.hint' },
  { id: 'codeFont', section: 'display', label: 'prefs.codeFont', keywords: 'monospace' },
  { id: 'fontSize', section: 'display', label: 'prefs.fontSize', keywords: 'zoom' },
  { id: 'density', section: 'display', label: 'prefs.density', keywords: 'compact' },
  { id: 'gravatar', section: 'display', label: 'prefs.gravatar', hint: 'prefs.gravatar.hint' },
  {
    id: 'gravatarCache',
    section: 'display',
    label: 'prefs.gravatar.clear',
    hint: 'prefs.gravatar.clear.hint',
  },

  {
    id: 'keybindings',
    section: 'keybindings',
    label: 'prefs.section.keybindings',
    keywords: 'keybinding keyboard clavier',
  },

  {
    id: 'gitPath',
    section: 'tools',
    label: 'prefs.git.path',
    keywords: 'binary executable version',
  },
  { id: 'editor', section: 'tools', label: 'tools.editor', hint: 'tools.editor.hint' },
  { id: 'terminalMode', section: 'tools', label: 'prefs.terminalMode', keywords: 'shell console' },
  {
    id: 'terminal',
    section: 'tools',
    label: 'prefs.terminal.external',
    keywords: 'shell console iterm',
  },
  {
    id: 'diffTool',
    section: 'tools',
    label: 'tools.diff',
    hint: 'tools.diff.hint',
    keywords: 'difftool',
  },
  {
    id: 'mergeTool',
    section: 'tools',
    label: 'tools.merge',
    hint: 'tools.merge.hint',
    keywords: 'mergetool conflict',
  },

  { id: 'autoFetch', section: 'sync', label: 'prefs.autoFetch', hint: 'prefs.autoFetch.hint' },
  {
    id: 'autoFetchMinutes',
    section: 'sync',
    label: 'prefs.autoFetchMinutes',
    keywords: 'fetch interval',
  },
  {
    id: 'prune',
    section: 'sync',
    label: 'prefs.prune',
    hint: 'prefs.prune.hint',
    keywords: 'prune fetch',
  },
  { id: 'remoteTags', section: 'sync', label: 'prefs.remoteTags', hint: 'prefs.remoteTags.hint' },
  {
    id: 'pullStrategy',
    section: 'sync',
    label: 'prefs.pull',
    hint: 'prefs.pull.hint',
    keywords: 'rebase merge fast-forward',
  },

  {
    id: 'protectedBranches',
    section: 'safety',
    label: 'prefs.protected',
    hint: 'prefs.protected.hint',
    keywords: 'main master release',
  },
  {
    id: 'confirmations',
    section: 'safety',
    label: 'prefs.confirmations',
    hint: 'prefs.confirmations.hint',
    keywords: 'discard stash tag force push',
  },

  {
    id: 'configScope',
    section: 'gitconfig',
    label: 'gitconfig.scope',
    keywords: 'global local gitconfig',
  },
  {
    id: 'user.name',
    section: 'gitconfig',
    label: 'gitconfig.field.userName',
    keywords: 'identity',
  },
  {
    id: 'user.email',
    section: 'gitconfig',
    label: 'gitconfig.field.userEmail',
    keywords: 'identity',
  },
  {
    id: 'commit.gpgsign',
    section: 'gitconfig',
    label: 'gitconfig.field.gpgsign',
    hint: 'gitconfig.field.gpgsign.hint',
    keywords: 'gpg signature',
  },
  {
    id: 'gpg.format',
    section: 'gitconfig',
    label: 'gitconfig.field.gpgFormat',
    keywords: 'gpg ssh x509 signature',
  },
  {
    id: 'user.signingkey',
    section: 'gitconfig',
    label: 'gitconfig.field.signingKey',
    hint: 'gitconfig.field.signingKey.hint',
    keywords: 'gpg ssh signature',
  },
  {
    id: 'pull.rebase',
    section: 'gitconfig',
    label: 'gitconfig.field.pullRebase',
    hint: 'gitconfig.field.pullRebase.hint',
  },
  {
    id: 'core.autocrlf',
    section: 'gitconfig',
    label: 'gitconfig.field.autocrlf',
    hint: 'gitconfig.field.autocrlf.hint',
    keywords: 'crlf line endings',
  },
  {
    id: 'init.defaultBranch',
    section: 'gitconfig',
    label: 'gitconfig.field.defaultBranch',
    hint: 'gitconfig.field.defaultBranch.hint',
  },
  { id: 'rawConfig', section: 'gitconfig', label: 'gitconfig.raw', keywords: 'alias core raw' },
];

/** Lowercase without accents: « Thème » and "theme" match. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Words found by the search beyond the labels, computed by the caller: the names of the
 * color themes for `theme`, the command titles for `keybindings`.
 */
export type ExtraWords = Partial<Record<string, string>>;

/**
 * Ids of the settings matching `query`, in both languages and through their keywords; `null`
 * when the query is empty (everything is shown).
 */
export function searchSettings(query: string, extra: ExtraWords = {}): Set<string> | null {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const found = new Set<string>();
  for (const entry of SETTINGS) {
    const text = foldText(
      [
        ...(['en', 'fr'] as const satisfies readonly Locale[]).flatMap((locale) => [
          translate(locale, entry.label),
          entry.hint ? translate(locale, entry.hint) : '',
        ]),
        entry.id,
        entry.keywords ?? '',
        extra[entry.id] ?? '',
      ].join(' '),
    );
    if (words.every((word) => text.includes(word))) found.add(entry.id);
  }
  return found;
}

/** Number of matches per section, for the badges of the navigation. */
export function countBySection(found: ReadonlySet<string>): Map<SectionId, number> {
  const counts = new Map<SectionId, number>();
  for (const entry of SETTINGS) {
    if (found.has(entry.id)) counts.set(entry.section, (counts.get(entry.section) ?? 0) + 1);
  }
  return counts;
}

/** Whether `query` names some of `names` (theme names, command titles). */
export function namesMatch(query: string, names: readonly string[]): boolean {
  const folded = foldText(query.trim());
  return folded !== '' && names.some((name) => foldText(name).includes(folded));
}
