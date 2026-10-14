import type { MessageKey } from '../../i18n/i18n';

export type ActionGroup = 'tabs' | 'view' | 'repo' | 'git' | 'app';

/** Display order of the groups when the palette lists actions without a query. */
export const ACTION_GROUPS: readonly ActionGroup[] = ['repo', 'tabs', 'view', 'app', 'git'];

/**
 * A command reachable from the palette. `id` is a stable public identifier (`tab.new`,
 * `git.push`…): recents, future rebindable shortcuts (F-281) and other features refer to it, so
 * it never changes once shipped.
 */
export interface PaletteAction {
  id: string;
  title: MessageKey;
  /**
   * Default shortcut, in `Mod+Shift+R` notation. The user can rebind it (F-281): what the
   * palette shows and the keyboard runs is `resolvedShortcut(id)`.
   */
  shortcut?: string;
  group: ActionGroup;
  /** Evaluated each time the palette opens. A disabled action is listed greyed out. */
  enabled?: () => boolean;
  run: () => void;
  /**
   * The keyboard shortcut runs the action even while it is disabled: it answers (undo explains
   * why it cannot) instead of doing nothing. The palette still lists it greyed out.
   */
  runWhenDisabled?: boolean;
}

const actions = new Map<string, PaletteAction>();

/**
 * Registers an action and returns the function that removes it. Registering an id again
 * replaces the previous action (hot reload, tests), so a feature can re-register freely.
 */
export function registerAction(action: PaletteAction): () => void {
  actions.set(action.id, action);
  return () => {
    if (actions.get(action.id) === action) actions.delete(action.id);
  };
}

export function registerActions(list: readonly PaletteAction[]): () => void {
  const unregister = list.map(registerAction);
  return () => {
    for (const off of unregister) off();
  };
}

export function listActions(): PaletteAction[] {
  return [...actions.values()];
}

export function getAction(id: string): PaletteAction | undefined {
  return actions.get(id);
}

export function isActionEnabled(action: PaletteAction): boolean {
  return action.enabled ? action.enabled() : true;
}

/** Runs an action by id. Returns `false` when it does not exist or is disabled. */
export function runAction(id: string): boolean {
  const action = actions.get(id);
  if (!action || !isActionEnabled(action)) return false;
  action.run();
  return true;
}
