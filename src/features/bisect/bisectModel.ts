import type { BisectCommit, BisectState } from '../../ipc';

/** How a graph row is marked during a bisect. `found` is the first bad commit. */
export type BisectRowMark = 'good' | 'bad' | 'skip' | 'current' | 'found';

/**
 * Mark of each commit the bisect names, by full SHA. Built once per bisect state, so a graph
 * row only does a map lookup (P-04).
 */
export function bisectMarks(
  state: BisectState | null | undefined,
): ReadonlyMap<string, BisectRowMark> {
  const marks = new Map<string, BisectRowMark>();
  if (!state) return marks;
  for (const sha of state.good) marks.set(sha, 'good');
  for (const sha of state.skipped) marks.set(sha, 'skip');
  if (state.bad) marks.set(state.bad, 'bad');
  if (state.result?.kind === 'found') {
    marks.set(state.result.commit.sha, 'found');
  } else if (state.current && !marks.has(state.current.sha) && state.result === null) {
    marks.set(state.current.sha, 'current');
  }
  return marks;
}

/** What the bisect banner shows. */
export type BisectPhase =
  /** Started from a mark: the other kind of mark is still needed. */
  | { kind: 'needGood' }
  | { kind: 'needBad' }
  | {
      kind: 'testing';
      current: BisectCommit | null;
      remaining: number;
      steps: number;
    }
  /** The commit under test already has a mark: the next one could not be checked out. */
  | { kind: 'awaitingCheckout' }
  | { kind: 'found'; commit: BisectCommit }
  | { kind: 'inconclusive'; candidates: BisectCommit[] }
  /** The bad commit is an ancestor of a good one: nothing can be tested until a mark changes. */
  | { kind: 'inconsistent' };

export function bisectPhase(state: BisectState): BisectPhase {
  if (state.result?.kind === 'found') return { kind: 'found', commit: state.result.commit };
  if (state.result?.kind === 'inconclusive') {
    return { kind: 'inconclusive', candidates: state.result.candidates };
  }
  if (state.result?.kind === 'inconsistentMarks') return { kind: 'inconsistent' };
  if (state.bad === null) return { kind: 'needBad' };
  if (state.good.length === 0) return { kind: 'needGood' };
  if (state.awaitingCheckout) return { kind: 'awaitingCheckout' };
  return {
    kind: 'testing',
    current: state.current,
    remaining: state.remaining ?? 0,
    steps: state.steps ?? 0,
  };
}

/** Whether marking HEAD from the banner makes sense: a commit is under test. */
export function canMarkCurrent(phase: BisectPhase): boolean {
  return phase.kind === 'testing' || phase.kind === 'needGood' || phase.kind === 'needBad';
}
