import type { BlameChunk, BlameCommit } from '../../ipc';

/** Number of age shades: the gutter color of a line steps from oldest to newest. */
export const AGE_STEPS = 8;

export interface BlameRows {
  /** Index in `commits` of each line. */
  commitOf: Uint32Array;
  /** 1 on the first line of a chunk: the row that shows the commit. */
  chunkStart: Uint8Array;
  /** Shade of each commit, 0 (oldest) to `AGE_STEPS - 1` (newest). */
  ageStep: Uint8Array;
}

/**
 * Per-line lookup tables of a blame, computed once: rows read them while scrolling. Ages are
 * ranks of the author dates, so a file edited over ten years and one edited over a week both
 * use every shade.
 */
export function blameRows(
  lineCount: number,
  commits: readonly BlameCommit[],
  chunks: readonly BlameChunk[],
): BlameRows {
  const commitOf = new Uint32Array(lineCount);
  const chunkStart = new Uint8Array(lineCount);
  for (const chunk of chunks) {
    const end = Math.min(lineCount, chunk.start + chunk.count);
    commitOf.fill(chunk.commit, chunk.start, end);
    if (chunk.start < lineCount) chunkStart[chunk.start] = 1;
  }
  const times = [
    ...new Set(commits.filter((c) => !c.uncommitted).map((c) => c.authorTime ?? 0)),
  ].sort((a, b) => a - b);
  const rank = new Map(times.map((time, index) => [time, index]));
  const ageStep = new Uint8Array(commits.length);
  commits.forEach((commit, index) => {
    if (commit.uncommitted || times.length <= 1) {
      ageStep[index] = AGE_STEPS - 1;
      return;
    }
    const r = (rank.get(commit.authorTime ?? 0) ?? 0) / (times.length - 1);
    ageStep[index] = Math.round(r * (AGE_STEPS - 1));
  });
  return { commitOf, chunkStart, ageStep };
}

/** First and last line (inclusive) of the chunk containing `line`. */
export function chunkBounds(rows: BlameRows, line: number): [number, number] {
  const commit = rows.commitOf[line];
  let first = line;
  while (first > 0 && rows.chunkStart[first] !== 1 && rows.commitOf[first - 1] === commit) first--;
  let last = line;
  while (last + 1 < rows.commitOf.length && rows.chunkStart[last + 1] !== 1) last++;
  return [first, last];
}
