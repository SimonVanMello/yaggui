import { useSyncExternalStore } from 'react';

import type { MessageKey, MessageParams } from '../../i18n/i18n';
import { matchShortcut } from '../../ui/shortcuts';
import {
  ACTION_GROUPS,
  isActionEnabled,
  listActions,
  runAction,
  type ActionGroup,
} from '../palette/actionRegistry';
import { useKeybindings } from './keybindingsStore';
import { effectiveShortcut, findConflicts } from './resolve';

export type BindingGroup = ActionGroup | 'graph';

/** Display order of the groups in the editor and the shortcut sheet. */
export const BINDING_GROUPS: readonly BindingGroup[] = [...ACTION_GROUPS, 'graph'];

/** A command a shortcut can be bound to. */
export interface BindingInfo {
  /** Stable id: the key of `keybindings.json`. Palette actions use their own id. */
  id: string;
  title: MessageKey;
  titleParams?: MessageParams;
  group: BindingGroup;
  defaultShortcut: string | null;
}

/**
 * Commands that exist only as a shortcut (no palette entry). With `run`, the global keyboard
 * handler runs them; without, the component that owns the context reads them with
 * [`matchBinding`] (graph, tab strip).
 */
interface ExtraBinding extends BindingInfo {
  run?: () => void;
}

const extras = new Map<string, ExtraBinding>();

export function registerBinding(binding: ExtraBinding): () => void {
  extras.set(binding.id, binding);
  return () => {
    if (extras.get(binding.id) === binding) extras.delete(binding.id);
  };
}

/** Every rebindable command: the palette actions (F-281), then the shortcut-only ones. */
export function listBindings(): BindingInfo[] {
  const actions: BindingInfo[] = listActions().map((action) => ({
    id: action.id,
    title: action.title,
    group: action.group,
    defaultShortcut: action.shortcut ?? null,
  }));
  return [...actions, ...extras.values()];
}

export function defaultShortcutOf(id: string): string | null {
  const action = listActions().find((candidate) => candidate.id === id);
  return action ? (action.shortcut ?? null) : (extras.get(id)?.defaultShortcut ?? null);
}

/** The shortcut of `id` now: the user's, else the default; `null` when it has none. */
export function resolvedShortcut(id: string): string | null {
  return effectiveShortcut(id, defaultShortcutOf(id), useKeybindings.getState().overrides);
}

/** Like [`resolvedShortcut`], re-rendering when the user rebinds. */
export function useShortcut(id: string): string | undefined {
  const overrides = useSyncExternalStore(
    useKeybindings.subscribe,
    () => useKeybindings.getState().overrides,
  );
  return effectiveShortcut(id, defaultShortcutOf(id), overrides) ?? undefined;
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** Whether `event` is the shortcut of `id`. For handlers bound to a context (a focused list). */
export function matchBinding(event: KeyEvent, id: string): boolean {
  const shortcut = resolvedShortcut(id);
  return shortcut !== null && matchShortcut(event, shortcut);
}

/** The effective shortcut of every command. */
export function effectiveBindings(
  overrides = useKeybindings.getState().overrides,
): Map<string, string | null> {
  return new Map(
    listBindings().map((b) => [b.id, effectiveShortcut(b.id, b.defaultShortcut, overrides)]),
  );
}

/** Shortcuts shared by several commands (`keybindings.json` edited by hand, a new default). */
export function bindingConflicts(overrides = useKeybindings.getState().overrides) {
  return findConflicts(effectiveBindings(overrides));
}

/** The command the global keyboard handler runs for `event`, if any. */
export function findGlobalBinding(event: KeyEvent): string | null {
  const { overrides } = useKeybindings.getState();
  for (const action of listActions()) {
    const shortcut = effectiveShortcut(action.id, action.shortcut ?? null, overrides);
    if (shortcut && matchShortcut(event, shortcut)) return action.id;
  }
  for (const extra of extras.values()) {
    if (!extra.run) continue;
    const shortcut = effectiveShortcut(extra.id, extra.defaultShortcut, overrides);
    if (shortcut && matchShortcut(event, shortcut)) return extra.id;
  }
  return null;
}

/** Runs a command by id: a palette action (if enabled) or a shortcut-only command. */
export function runBinding(id: string): boolean {
  const extra = extras.get(id);
  if (extra?.run) {
    extra.run();
    return true;
  }
  const action = listActions().find((candidate) => candidate.id === id);
  if (action?.runWhenDisabled) {
    action.run();
    return true;
  }
  return action !== undefined && isActionEnabled(action) && runAction(id);
}
