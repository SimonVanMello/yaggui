import { describe, expect, it } from 'vitest';

import { joinMessage, rewordBlock, splitMessage } from './rewordDraft';

describe('splitMessage', () => {
  it('separates the summary from the description', () => {
    expect(splitMessage('Fix\n\nBody line\n  indented\n', 'Fix')).toEqual({
      summary: 'Fix',
      description: 'Body line\n  indented',
    });
  });

  it('has an empty description for a one-line message', () => {
    expect(splitMessage('Fix', 'Fix')).toEqual({ summary: 'Fix', description: '' });
  });
});

describe('joinMessage', () => {
  it('puts a blank line between summary and description', () => {
    expect(joinMessage({ summary: ' Fix ', description: '\n\nBody\n' })).toBe('Fix\n\nBody');
  });

  it('drops an empty description', () => {
    expect(joinMessage({ summary: 'Fix', description: ' \n ' })).toBe('Fix');
  });
});

describe('rewordBlock', () => {
  const original = { summary: 'Fix', description: 'Body' };

  it('refuses an empty summary', () => {
    expect(rewordBlock({ summary: '  ', description: 'Body' }, original)).toBe('empty');
  });

  it('refuses a message that only differs by whitespace', () => {
    expect(rewordBlock({ summary: 'Fix ', description: 'Body\n' }, original)).toBe('unchanged');
  });

  it('accepts a new message', () => {
    expect(rewordBlock({ summary: 'Fix', description: 'Other' }, original)).toBeNull();
  });
});
