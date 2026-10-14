import { create } from 'zustand';

import type { ErrorPayload } from '../../ipc';

/** Dispatched on `window` by the palette: commit the active repository. */
export const COMMIT_EVENT = 'yaggui:commit';

export type HookFailure = Extract<ErrorPayload, { kind: 'hook' }> & {
  /** Localized one-line summary from the error. */
  message: string;
};

interface CommitUi {
  /** Last hook rejection per repository, until dismissed or the next attempt. */
  hook: Record<number, HookFailure | undefined>;
  /** Repositories whose "who are you?" form is open. */
  identity: Record<number, true | undefined>;
  setHook: (repoId: number, failure: HookFailure | null) => void;
  setIdentity: (repoId: number, open: boolean) => void;
}

export const useCommitUi = create<CommitUi>()((set) => ({
  hook: {},
  identity: {},
  setHook: (repoId, failure) => {
    set((state) => ({ hook: { ...state.hook, [repoId]: failure ?? undefined } }));
  },
  setIdentity: (repoId, open) => {
    set((state) => ({ identity: { ...state.identity, [repoId]: open ? true : undefined } }));
  },
}));

/**
 * The whole output of a failed hook as text to read or copy: nothing is dropped, and when both
 * streams have content they are labelled.
 */
export function hookOutputText(failure: Pick<HookFailure, 'stdout' | 'stderr'>): string {
  const { stdout, stderr } = failure;
  if (stdout && stderr) return `${stdout.trimEnd()}\n\n--- stderr ---\n${stderr.trimEnd()}`;
  return (stdout || stderr).trimEnd();
}
