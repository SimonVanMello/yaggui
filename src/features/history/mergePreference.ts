import type { MergeMode } from '../../ipc';

const KEY = 'yaggui.history.mergeMode';
const MODES: readonly MergeMode[] = ['fastForward', 'noFastForward', 'squash'];

/** `fastForwardOnly` is the "Fast-forward" gesture, not a choice of the merge dialog. */
export type MergeChoice = Exclude<MergeMode, 'fastForwardOnly'>;

/** The merge mode chosen last time (F-140: configurable per action), `fastForward` at first. */
export function rememberedMergeMode(): MergeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    const found = MODES.find((mode) => mode === value);
    if (found && found !== 'fastForwardOnly') return found;
  } catch {
    // Storage can be blocked: the default applies.
  }
  return 'fastForward';
}

export function rememberMergeMode(mode: MergeChoice): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    // Not remembered, not an error.
  }
}
