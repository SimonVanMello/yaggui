import { describe, expect, it } from 'vitest';

import { canResetTo, reflogSelector, splitReflogMessage } from './reflogModel';

describe('reflog model', () => {
  it('splits the action from the detail', () => {
    expect(splitReflogMessage('checkout: moving from main to feat')).toEqual({
      action: 'checkout',
      detail: 'moving from main to feat',
    });
    expect(splitReflogMessage('commit (amend): fix: a: b')).toEqual({
      action: 'commit (amend)',
      detail: 'fix: a: b',
    });
    expect(splitReflogMessage('odd line')).toEqual({ action: '', detail: 'odd line' });
  });

  it('names entries like Git', () => {
    expect(reflogSelector('HEAD', 3)).toBe('HEAD@{3}');
    expect(reflogSelector('refs/heads/feat/x', 0)).toBe('feat/x@{0}');
    expect(reflogSelector('refs/remotes/origin/main', 1)).toBe('origin/main@{1}');
  });

  it('resets only HEAD or the checked-out branch', () => {
    expect(canResetTo('HEAD', null)).toBe(true);
    expect(canResetTo('refs/heads/main', 'main')).toBe(true);
    expect(canResetTo('refs/heads/feat', 'main')).toBe(false);
    expect(canResetTo('refs/heads/', null)).toBe(false);
  });
});
