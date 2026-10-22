import { describe, expect, it } from 'vitest';

import type { BisectCommit, BisectState } from '../../ipc';
import { bisectMarks, bisectPhase, canMarkCurrent } from './bisectModel';

function commit(sha: string): BisectCommit {
  return { sha, summary: `commit ${sha}`, authorName: 'Alex', authorTime: 0 };
}

function state(partial: Partial<BisectState>): BisectState {
  return {
    bad: null,
    good: [],
    skipped: [],
    current: commit('head'),
    awaitingCheckout: false,
    remaining: null,
    steps: null,
    result: null,
    original: 'main',
    ...partial,
  };
}

describe('bisect banner state', () => {
  it('asks for the missing kind of mark first', () => {
    expect(bisectPhase(state({}))).toEqual({ kind: 'needBad' });
    expect(bisectPhase(state({ bad: 'head' }))).toEqual({ kind: 'needGood' });
    expect(bisectPhase(state({ good: ['old'] }))).toEqual({ kind: 'needBad' });
  });

  it('shows the commit under test and the steps left', () => {
    const phase = bisectPhase(
      state({ bad: 'tip', good: ['old'], current: commit('mid'), remaining: 8, steps: 2 }),
    );
    expect(phase).toEqual({ kind: 'testing', current: commit('mid'), remaining: 8, steps: 2 });
    expect(canMarkCurrent(phase)).toBe(true);
  });

  it('offers the next checkout when a step could not check it out', () => {
    const phase = bisectPhase(
      state({ bad: 'tip', good: ['old'], remaining: 3, steps: 1, awaitingCheckout: true }),
    );
    expect(phase).toEqual({ kind: 'awaitingCheckout' });
    expect(canMarkCurrent(phase)).toBe(false);
  });

  it('ends on the first bad commit or the skipped candidates', () => {
    const found = bisectPhase(
      state({
        bad: 'x',
        good: ['old'],
        remaining: 0,
        result: { kind: 'found', commit: commit('x') },
      }),
    );
    expect(found).toEqual({ kind: 'found', commit: commit('x') });
    expect(canMarkCurrent(found)).toBe(false);
    const candidates = [commit('x'), commit('s')];
    expect(
      bisectPhase(state({ bad: 'x', good: ['old'], result: { kind: 'inconclusive', candidates } })),
    ).toEqual({ kind: 'inconclusive', candidates });
  });
});

describe('bisect graph marks', () => {
  it('marks good, bad, skipped and the commit under test', () => {
    const marks = bisectMarks(
      state({ bad: 'b', good: ['g1', 'g2'], skipped: ['s'], current: commit('c'), remaining: 4 }),
    );
    expect([...marks]).toEqual([
      ['g1', 'good'],
      ['g2', 'good'],
      ['s', 'skip'],
      ['b', 'bad'],
      ['c', 'current'],
    ]);
  });

  it('keeps the mark of a commit under test that is already marked', () => {
    expect(bisectMarks(state({ bad: 'head' })).get('head')).toBe('bad');
  });

  it('shows the first bad commit instead of its bad mark, and no commit under test', () => {
    const marks = bisectMarks(
      state({
        bad: 'x',
        good: ['g'],
        current: commit('g'),
        result: { kind: 'found', commit: commit('x') },
      }),
    );
    expect(marks.get('x')).toBe('found');
    expect(marks.get('g')).toBe('good');
    expect(bisectMarks(null).size).toBe(0);
  });
});
