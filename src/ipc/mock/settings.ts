import type {
  ConfigEntry,
  ConfigScope,
  ExternalToolCheck,
  ExternalToolKind,
  YagguiError,
  KeybindingOverride,
  KeybindingsFile,
} from '../bindings';

function error(code: YagguiError['code'], en: string, fr: string, detail?: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: detail ?? null, payload: null };
}

function invalid(en: string, fr: string): YagguiError {
  return error('invalidArgument', en, fr);
}

/** `keybindings::is_valid_shortcut` in Rust. */
export function isValidShortcut(shortcut: string): boolean {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const keyOk = key !== '' && Array.from(key).length <= 16 && !/[\s\p{Cc}]/u.test(key);
  const modifiers = parts.every(
    (m, i) => ['Mod', 'Ctrl', 'Alt', 'Shift'].includes(m) && parts.indexOf(m) === i,
  );
  return keyOk && modifiers;
}

/** `validate_key` in `git/ops/config.rs`. */
export function isValidConfigKey(key: string): boolean {
  const dot = key.indexOf('.');
  if (dot <= 0 || key.length > 200) return false;
  const section = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  const name = rest.slice(rest.lastIndexOf('.') + 1);
  const subsection = rest.slice(0, rest.length - name.length);
  return (
    /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(section) &&
    /^[A-Za-z][A-Za-z0-9-]*$/.test(name) &&
    !/\p{Cc}/u.test(subsection)
  );
}

/** `is_tool_name` in `store/types.rs`. */
export function isToolName(name: string): boolean {
  return /^[A-Za-z0-9_+][A-Za-z0-9_.+-]*$/.test(name) && name.length <= 100;
}

/** Tools `git difftool --tool-help` finds installed in the mock, and the ones it knows without. */
const INSTALLED = ['meld', 'vimdiff'];
const MISSING = ['kdiff3', 'opendiff', 'bc'];

/** Keybindings file, Git config files and external tools of the mock backend (M4-6). */
export class MockSettings {
  private overrides: KeybindingOverride[] = [];
  /** `~/.gitconfig` of the mock user. */
  private global: ConfigEntry[] = [
    { key: 'user.name', value: 'Alex Martin' },
    { key: 'user.email', value: 'alex@example.com' },
    { key: 'init.defaultbranch', value: 'main' },
  ];
  private local = new Map<number, ConfigEntry[]>();
  /** Files opened by `openInEditor`, for tests. */
  readonly openedInEditor: { repoId: number; path: string | null; program: string }[] = [];

  /** Called after each write to `keybindings.json`, so the mock store can keep it. */
  onChange: (() => void) | null = null;

  /** The overrides, for the persisted mock store. */
  overridesSnapshot(): KeybindingOverride[] {
    return structuredClone(this.overrides);
  }

  restore(overrides: KeybindingOverride[]): void {
    this.overrides = structuredClone(overrides);
  }

  reset(): void {
    this.overrides = [];
    this.global = [
      { key: 'user.name', value: 'Alex Martin' },
      { key: 'user.email', value: 'alex@example.com' },
      { key: 'init.defaultbranch', value: 'main' },
    ];
    this.local.clear();
    this.openedInEditor.length = 0;
  }

  keybindings(): KeybindingsFile {
    return {
      path: '~/.config/dev.tropico.yaggui/keybindings.json',
      overrides: structuredClone(this.overrides),
      problem: null,
    };
  }

  setKeybindings(overrides: KeybindingOverride[]): KeybindingsFile | YagguiError {
    for (const entry of overrides) {
      const shortcutOk = entry.shortcut === null || isValidShortcut(entry.shortcut);
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry.action) || !shortcutOk) {
        return invalid(
          `"${entry.action}" cannot be bound like this.`,
          `« ${entry.action} » ne peut pas être associé ainsi.`,
        );
      }
    }
    this.overrides = structuredClone(overrides);
    this.onChange?.();
    return this.keybindings();
  }

  private entries(scope: ConfigScope, repoId: number | null): ConfigEntry[] | YagguiError {
    if (scope === 'global') return this.global;
    if (repoId === null) {
      return invalid(
        'The repository configuration needs an open repository.',
        'La configuration du dépôt demande un dépôt ouvert.',
      );
    }
    let list = this.local.get(repoId);
    if (!list) {
      list = [{ key: 'core.bare', value: 'false' }];
      this.local.set(repoId, list);
    }
    return list;
  }

  configList(scope: ConfigScope, repoId: number | null): ConfigEntry[] | YagguiError {
    const list = this.entries(scope, repoId);
    return 'code' in list ? list : structuredClone(list);
  }

  configSet(
    scope: ConfigScope,
    repoId: number | null,
    key: string,
    value: string | null,
  ): YagguiError | null {
    if (!isValidConfigKey(key)) {
      return invalid(
        `"${key}" is not a valid Git configuration key (section.name or section.subsection.name).`,
        `« ${key} » n'est pas une clé de configuration Git valide (section.nom ou section.sous-section.nom).`,
      );
    }
    if (value !== null && (value.includes('\0') || value.length > 16 * 1024)) {
      return invalid(
        'The value is too long or contains a NUL character.',
        'La valeur est trop longue ou contient un caractère NUL.',
      );
    }
    const list = this.entries(scope, repoId);
    if ('code' in list) return list;
    // Git lowercases the section and the variable name, not the subsection.
    const normalized = key
      .replace(/^[^.]+/, (s) => s.toLowerCase())
      .replace(/[^.]+$/, (s) => s.toLowerCase());
    const kept = list.filter((e) => e.key !== normalized);
    if (value !== null) kept.push({ key: normalized, value });
    list.splice(0, list.length, ...kept);
    return null;
  }

  /** Value of `key` in the configuration of a repository, local first (what Git resolves). */
  resolve(repoId: number | null, key: string): string | null {
    const find = (list: ConfigEntry[] | undefined) => list?.find((e) => e.key === key)?.value;
    return (
      (repoId === null ? undefined : find(this.local.get(repoId))) ?? find(this.global) ?? null
    );
  }

  checkGitTool(
    family: 'diff' | 'merge',
    name: string | null,
    repoId: number | null,
  ): ExternalToolCheck | YagguiError {
    const tool = name ?? this.resolve(repoId, `${family}.tool`);
    if (!tool) return { tool: '', ok: false, issue: 'notConfigured' };
    if (!isToolName(tool)) {
      return invalid(
        `"${tool}" is not a valid tool name.`,
        `« ${tool} » n'est pas un nom d'outil valide.`,
      );
    }
    const custom = this.resolve(repoId, `${family}tool.${tool}.cmd`) !== null;
    if (INSTALLED.includes(tool) || custom) return { tool, ok: true, issue: null };
    return { tool, ok: false, issue: MISSING.includes(tool) ? 'notInstalled' : 'unknown' };
  }

  checkEditor(name: string | null): ExternalToolCheck | YagguiError {
    // A name containing `missing` simulates an editor that is not installed.
    if (name !== null && /missing/.test(name)) return this.editorNotFound(name);
    return { tool: name ?? 'xdg-open', ok: true, issue: null };
  }

  editorNotFound(name: string | null): YagguiError {
    return name
      ? error(
          'editorNotFound',
          `The editor "${name}" could not be started. Check its name in the preferences.`,
          `L'éditeur « ${name} » n'a pas pu être lancé. Vérifie son nom dans les préférences.`,
        )
      : error(
          'editorNotFound',
          'No application could open the file. Choose an editor in the preferences.',
          "Aucune application n'a pu ouvrir le fichier. Choisis un éditeur dans les préférences.",
        );
  }

  check(
    kind: Exclude<ExternalToolKind, 'terminal'>,
    name: string | null,
    repoId: number | null,
  ): ExternalToolCheck | YagguiError {
    if (kind === 'editor') return this.checkEditor(name);
    return this.checkGitTool(kind === 'diffTool' ? 'diff' : 'merge', name, repoId);
  }
}
