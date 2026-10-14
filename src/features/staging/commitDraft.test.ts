import { describe, expect, it } from 'vitest';

import {
  commitBlock,
  EMPTY_DRAFT,
  SUMMARY_LIMIT,
  summaryLength,
  summaryLevel,
  withAmend,
  type CommitDraft,
} from './commitDraft';

const draft = (patch: Partial<CommitDraft>): CommitDraft => ({ ...EMPTY_DRAFT, ...patch });
const last = { summary: 'fix: previous', description: 'details' };

describe('summary counter', () => {
  it('counts characters, not UTF-16 units', () => {
    expect(summaryLength('abc')).toBe(3);
    expect(summaryLength('a😀b')).toBe(3);
  });

  it('warns past 72 characters only', () => {
    expect(summaryLevel('x'.repeat(SUMMARY_LIMIT))).toBe('ok');
    expect(summaryLevel('x'.repeat(SUMMARY_LIMIT + 1))).toBe('over');
  });
});

describe('commit button state', () => {
  const ready = { stagedCount: 2, busy: false };

  it('needs a summary and staged changes', () => {
    expect(commitBlock(draft({ summary: 'feat: x' }), ready)).toBeNull();
    expect(commitBlock(draft({ summary: '   ' }), ready)).toBe('noSummary');
    expect(commitBlock(draft({ summary: 'x' }), { ...ready, stagedCount: 0 })).toBe(
      'nothingStaged',
    );
  });

  it('lets an amend through with nothing staged (message-only amend)', () => {
    expect(
      commitBlock(draft({ summary: 'x', amend: true }), { ...ready, stagedCount: 0 }),
    ).toBeNull();
  });

  it('blocks while a commit is running', () => {
    expect(commitBlock(draft({ summary: 'x' }), { ...ready, busy: true })).toBe('busy');
  });
});

describe('amend', () => {
  it('pre-fills an empty message with the last commit', () => {
    const next = withAmend(EMPTY_DRAFT, true, last);
    expect(next).toMatchObject({
      amend: true,
      summary: last.summary,
      description: last.description,
    });
  });

  it('keeps a message the user already typed', () => {
    const typed = draft({ summary: 'my message' });
    expect(withAmend(typed, true, last)).toMatchObject({ amend: true, summary: 'my message' });
  });

  it('removes an untouched pre-fill when amend is turned off', () => {
    const on = withAmend(EMPTY_DRAFT, true, last);
    expect(withAmend(on, false, last)).toEqual(EMPTY_DRAFT);
  });

  it('keeps an edited message when amend is turned off', () => {
    const on = withAmend(EMPTY_DRAFT, true, last);
    const off = withAmend({ ...on, summary: 'fix: edited' }, false, last);
    expect(off).toMatchObject({ amend: false, summary: 'fix: edited', prefilled: null });
  });

  it('only flags amend on an unborn branch (no last commit)', () => {
    expect(withAmend(EMPTY_DRAFT, true, null)).toMatchObject({ amend: true, summary: '' });
  });
});
