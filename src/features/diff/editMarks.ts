import { myers } from './myers';

/** What the file editor marks against the index version, by line of the edited text. */
export interface EditMarks {
  /** 1 for a line that is new or changed since the index version, 0 otherwise. */
  added: Uint8Array;
  /** Line indexes before which index lines were removed (`lines.length`: at the end). */
  removedBefore: ReadonlySet<number>;
}

/** Lines of an index version, as the editor splits them (CRLF or LF, final break dropped). */
export function originalLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Marks of `current` against `original`. Both sides end with an empty line when the text
 * ends with a break: the edited text always does (CodeMirror), so a final empty line is not
 * counted as added.
 */
export function editMarks(original: readonly string[], current: readonly string[]): EditMarks {
  const lines = current.at(-1) === '' ? current.slice(0, -1) : current;
  const added = new Uint8Array(current.length);
  const removedBefore = new Set<number>();
  for (const edit of myers(original, lines)) {
    if (edit.bStart === edit.bEnd) removedBefore.add(edit.bStart);
    else added.fill(1, edit.bStart, edit.bEnd);
  }
  return { added, removedBefore };
}
