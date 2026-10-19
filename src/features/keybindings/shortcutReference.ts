import { translate, type Locale } from '../../i18n/i18n';
import { formatShortcut, type Platform } from '../../ui/platform';
import { BINDING_GROUPS, listBindings, type BindingGroup } from './registry';

/** Commands only registered on some platforms (see `builtinBindings.ts`). */
const NOT_ON_MAC: ReadonlySet<string> = new Set(['edit.redoAlt']);

type Localized = Record<Locale, string>;

export interface ShortcutEntry {
  /** Stable id of the command, as in `keybindings.json`. */
  id: string;
  title: Localized;
  /** Keycaps on macOS (`['⌘', 'K']`), `null` where the command does not exist. */
  mac: string[] | null;
  /** Keycaps on Windows and Linux (`['Ctrl', 'K']`). */
  other: string[] | null;
}

export interface ShortcutGroup {
  id: BindingGroup;
  title: Localized;
  shortcuts: ShortcutEntry[];
}

export interface ShortcutReference {
  groups: ShortcutGroup[];
}

function both(translateFor: (locale: Locale) => string): Localized {
  return { en: translateFor('en'), fr: translateFor('fr') };
}

function keys(shortcut: string, platform: Platform): string[] {
  return formatShortcut(shortcut, platform);
}

/**
 * The default shortcuts of every command registered in the action registry and the shortcut-only
 * bindings, with their labels in both languages. Feeds the docs (`pnpm docs:shortcuts`).
 */
export function buildShortcutReference(): ShortcutReference {
  const bindings = listBindings();
  const groups: ShortcutGroup[] = [];
  for (const group of BINDING_GROUPS) {
    const shortcuts = bindings
      .filter((binding) => binding.group === group && binding.defaultShortcut !== null)
      .map((binding): ShortcutEntry => {
        const shortcut = binding.defaultShortcut ?? '';
        return {
          id: binding.id,
          title: both((locale) => translate(locale, binding.title, binding.titleParams)),
          mac: NOT_ON_MAC.has(binding.id) ? null : keys(shortcut, 'mac'),
          other: keys(shortcut, 'linux'),
        };
      });
    if (shortcuts.length === 0) continue;
    groups.push({
      id: group,
      title: both((locale) => translate(locale, `keybindings.group.${group}`)),
      shortcuts,
    });
  }
  return { groups };
}
