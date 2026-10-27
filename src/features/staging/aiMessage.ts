import { create } from 'zustand';

import type { CommitDraft } from './commitDraft';

/** The message fields a generation replaces and a restore puts back. */
export interface MessageText {
  summary: string;
  description: string;
}

/** Draft after a generation: the message is replaced, the amend state is kept. */
export function withGenerated(draft: CommitDraft, generated: MessageText): CommitDraft {
  return {
    ...draft,
    summary: generated.summary,
    description: generated.description,
    // The message is no longer HEAD's: turning amend off must not wipe it.
    prefilled: null,
  };
}

function isBlank(message: MessageText): boolean {
  return message.summary.trim() === '' && message.description.trim() === '';
}

/** Draft with the message `restore` replaced; `null` when there is nothing to put back. */
export function withRestored(
  draft: CommitDraft,
  restore: AiRestore | undefined,
): CommitDraft | null {
  if (!restore) return null;
  return { ...draft, summary: restore.previous.summary, description: restore.previous.description };
}

/**
 * What a generation replaced. It is offered only while the draft still holds the generated
 * text, so a restore never overwrites what the user typed afterwards.
 */
export interface AiRestore {
  previous: MessageText;
  generated: MessageText;
}

export function canRestore(draft: MessageText, restore: AiRestore | undefined): boolean {
  return (
    restore !== undefined &&
    draft.summary === restore.generated.summary &&
    draft.description === restore.generated.description
  );
}

/** A generation worth undoing: it replaced a message the user had written. */
export function shouldOfferRestore(previous: MessageText, generated: MessageText): boolean {
  return (
    !isBlank(previous) &&
    (previous.summary !== generated.summary || previous.description !== generated.description)
  );
}

export type AiPhase = 'idle' | 'generating';

interface AiUi {
  /** Repositories with a generation running, with the id that cancels it. */
  generating: Record<number, { requestId: string } | undefined>;
  restore: Record<number, AiRestore | undefined>;
  start: (repoId: number, requestId: string) => void;
  finish: (repoId: number) => void;
  setRestore: (repoId: number, restore: AiRestore | null) => void;
}

export const useAiUi = create<AiUi>()((set) => ({
  generating: {},
  restore: {},
  start: (repoId, requestId) => {
    set((state) => ({ generating: { ...state.generating, [repoId]: { requestId } } }));
  },
  finish: (repoId) => {
    set((state) => ({ generating: { ...state.generating, [repoId]: undefined } }));
  },
  setRestore: (repoId, restore) => {
    set((state) => ({ restore: { ...state.restore, [repoId]: restore ?? undefined } }));
  },
}));
