import { create } from 'zustand';

/** Length from which the summary gets a warning (spec F-064). */
export const SUMMARY_LIMIT = 72;

export interface CommitDraft {
  summary: string;
  description: string;
  amend: boolean;
  /** Message pre-filled by "Amend", to undo it when amend is turned off untouched. */
  prefilled: { summary: string; description: string } | null;
}

export const EMPTY_DRAFT: CommitDraft = {
  summary: '',
  description: '',
  amend: false,
  prefilled: null,
};

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as the user counts them: an emoji or a letter with combining accents is one. */
export function summaryLength(summary: string): number {
  return Array.from(GRAPHEMES.segment(summary)).length;
}

export type SummaryLevel = 'ok' | 'over';

export function summaryLevel(summary: string): SummaryLevel {
  return summaryLength(summary) > SUMMARY_LIMIT ? 'over' : 'ok';
}

export interface CommitContext {
  stagedCount: number;
  /** A commit is already running. */
  busy: boolean;
}

/** Why the commit button is disabled, `null` when it can run. */
export type CommitBlock = 'busy' | 'noSummary' | 'nothingStaged';

export function commitBlock(draft: CommitDraft, context: CommitContext): CommitBlock | null {
  if (context.busy) return 'busy';
  if (draft.summary.trim() === '') return 'noSummary';
  if (context.stagedCount === 0 && !draft.amend) return 'nothingStaged';
  return null;
}

/**
 * Draft after turning amend on or off. Turning it on pre-fills the message of the HEAD commit
 * unless the user already typed one; turning it off removes a pre-filled message that was not
 * edited.
 */
export function withAmend(
  draft: CommitDraft,
  amend: boolean,
  last: { summary: string; description: string } | null,
): CommitDraft {
  if (amend) {
    const empty = draft.summary.trim() === '' && draft.description.trim() === '';
    if (!last || !empty) return { ...draft, amend: true };
    return {
      ...draft,
      amend: true,
      summary: last.summary,
      description: last.description,
      prefilled: last,
    };
  }
  const untouched =
    draft.prefilled !== null &&
    draft.prefilled.summary === draft.summary &&
    draft.prefilled.description === draft.description;
  return untouched ? { ...EMPTY_DRAFT } : { ...draft, amend: false, prefilled: null };
}

interface CommitDrafts {
  drafts: Record<number, CommitDraft | undefined>;
  update: (repoId: number, patch: Partial<CommitDraft>) => void;
  set: (repoId: number, draft: CommitDraft) => void;
  clear: (repoId: number) => void;
}

/** Drafts live per repository: switching tabs keeps what was typed. */
export const useCommitDrafts = create<CommitDrafts>()((set) => ({
  drafts: {},
  update: (repoId, patch) => {
    set((state) => ({
      drafts: { ...state.drafts, [repoId]: { ...(state.drafts[repoId] ?? EMPTY_DRAFT), ...patch } },
    }));
  },
  set: (repoId, draft) => {
    set((state) => ({ drafts: { ...state.drafts, [repoId]: draft } }));
  },
  clear: (repoId) => {
    set((state) => ({ drafts: { ...state.drafts, [repoId]: undefined } }));
  },
}));

export function useCommitDraft(repoId: number): CommitDraft {
  return useCommitDrafts((state) => state.drafts[repoId]) ?? EMPTY_DRAFT;
}
