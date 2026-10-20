/** Summary and description of a commit message, as the inline editor shows them. */
export interface RewordDraft {
  summary: string;
  description: string;
}

const LEADING_BLANK_LINES = /^(?:[^\S\n]*\n)+/;

/** Splits a full message; `summary` is the first line as `commitDetail` reports it. */
export function splitMessage(message: string, summary: string): RewordDraft {
  const rest = message.startsWith(summary) ? message.slice(summary.length) : '';
  return { summary, description: rest.replace(LEADING_BLANK_LINES, '').trimEnd() };
}

/** Message sent to `rewordCommit`: summary, blank line, description (dropped when empty). */
export function joinMessage(draft: RewordDraft): string {
  const summary = draft.summary.trim();
  const description = draft.description.replace(LEADING_BLANK_LINES, '').trimEnd();
  return description === '' ? summary : `${summary}\n\n${description}`;
}

/** Why the new message cannot be saved, `null` when it can. */
export function rewordBlock(
  draft: RewordDraft,
  original: RewordDraft,
): 'empty' | 'unchanged' | null {
  if (draft.summary.trim() === '') return 'empty';
  if (joinMessage(draft) === joinMessage(original)) return 'unchanged';
  return null;
}
