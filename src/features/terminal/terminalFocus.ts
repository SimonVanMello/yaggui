/** Marks the element holding an emulator: its value is the terminal id. */
export const TERMINAL_ATTRIBUTE = 'data-terminal';
/** Repository of the terminal, on the same element. */
export const TERMINAL_REPO_ATTRIBUTE = 'data-terminal-repo';

/** Shortcuts the app keeps while a terminal has the focus; every other key goes to the shell. */
export const TERMINAL_PASSTHROUGH: readonly string[] = [
  'app.palette',
  'terminal.toggle',
  'terminal.new',
];

/** Whether `target` is inside an emulator (its hidden input or its screen). */
export function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${TERMINAL_ATTRIBUTE}]`) !== null;
}

/** Whether the keyboard focus is in one of the terminals of `repoId`. */
export function terminalHasFocus(repoId: number): boolean {
  const active = document.activeElement;
  if (!(active instanceof Element)) return false;
  const host = active.closest(`[${TERMINAL_REPO_ATTRIBUTE}]`);
  return host?.getAttribute(TERMINAL_REPO_ATTRIBUTE) === String(repoId);
}
