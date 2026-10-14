import type { UndoState, UndoStep } from '../../ipc';

export type UndoDirection = 'undo' | 'redo';

/** What a toolbar button shows for one direction. */
export type ButtonState =
  /** Nothing in the journal for this direction. */
  { kind: 'empty' } | { kind: 'ready'; step: UndoStep } | { kind: 'blocked'; step: UndoStep };

export function buttonState(state: UndoState | undefined, direction: UndoDirection): ButtonState {
  const step = state?.[direction] ?? null;
  if (!step) return { kind: 'empty' };
  return step.blocked ? { kind: 'blocked', step } : { kind: 'ready', step };
}

/**
 * Whether the shortcut or palette action may run. While the state is unknown (not loaded
 * yet) the command is attempted: the backend answers `nothingToUndo` with a toast.
 */
export function canRun(state: UndoState | undefined, direction: UndoDirection): boolean {
  if (!state) return true;
  return buttonState(state, direction).kind === 'ready';
}
