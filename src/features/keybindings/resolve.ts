import { eventKey } from '../../ui/shortcuts';
import type { Platform } from '../../ui/platform';

/** User changes: a shortcut rebinds the action, `null` leaves it without one. */
export type Overrides = Readonly<Record<string, string | null>>;

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

/** `Mod+Shift+K` with modifiers in a fixed order and an upper-case letter. */
export function canonicalShortcut(shortcut: string): string {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** Two shortcuts that press the same keys compare equal. */
export function shortcutKey(shortcut: string): string {
  return canonicalShortcut(shortcut).toLowerCase();
}

export function effectiveShortcut(
  id: string,
  defaultShortcut: string | null,
  overrides: Overrides,
): string | null {
  return id in overrides ? (overrides[id] ?? null) : defaultShortcut;
}

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'OS', 'Hyper']);

export type Capture =
  | { kind: 'shortcut'; shortcut: string }
  /** Only modifiers are down: keep waiting. */
  | { kind: 'pending' }
  | { kind: 'cancel' }
  /** A combination that cannot be a shortcut (no modifier, `+`, the Windows key…). */
  | { kind: 'invalid' };

type CaptureEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

/**
 * Turns the key press of a "press the shortcut" field into a shortcut string. `Mod` is ⌘ on
 * macOS and Ctrl elsewhere; the other of the two stays `Ctrl` on macOS and is refused elsewhere
 * (⊞ Win is the OS's).
 */
export function captureShortcut(event: CaptureEvent, target: Platform): Capture {
  if (MODIFIER_KEYS.has(event.key)) return { kind: 'pending' };
  if (event.key === 'Escape') return { kind: 'cancel' };
  const mac = target === 'mac';
  if (!mac && event.metaKey) return { kind: 'invalid' };
  const key = eventKey(event);
  if (key === '+' || key === 'Dead' || key === 'Unidentified') return { kind: 'invalid' };
  const modifiers: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
  if (mac && event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  const withoutShift = modifiers.filter((m) => m !== 'Shift');
  // A bare key (or Shift + key) would take over typing and list navigation.
  if (withoutShift.length === 0 && !FUNCTION_KEY.test(key)) return { kind: 'invalid' };
  return { kind: 'shortcut', shortcut: canonicalShortcut([...modifiers, key].join('+')) };
}

/** Groups of ids that share a shortcut, by canonical shortcut. Only groups of 2+ are kept. */
export function findConflicts(
  effective: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const byShortcut = new Map<string, string[]>();
  for (const [id, shortcut] of effective) {
    if (!shortcut) continue;
    const key = shortcutKey(shortcut);
    byShortcut.set(key, [...(byShortcut.get(key) ?? []), id]);
  }
  for (const [key, ids] of byShortcut) if (ids.length < 2) byShortcut.delete(key);
  return byShortcut;
}
