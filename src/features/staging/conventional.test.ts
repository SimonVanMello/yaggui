import { describe, expect, it } from 'vitest';

import {
  formatConventional,
  parseConventional,
  recentScopes,
  subjectLength,
  withHeader,
} from './conventional';

describe('conventional commits', () => {
  it('parses headers with and without scope', () => {
    expect(parseConventional('feat(graph): lanes')).toEqual({
      type: 'feat',
      scope: 'graph',
      breaking: false,
      subject: 'lanes',
    });
    expect(parseConventional('fix!: crash')).toMatchObject({ type: 'fix', breaking: true });
    expect(parseConventional('Fix the crash')).toBeNull();
    expect(parseConventional('feat:')).toMatchObject({ subject: '' });
  });

  it('changes the type or the scope and keeps the subject', () => {
    expect(withHeader('fix(ui): button', { type: 'feat' })).toBe('feat(ui): button');
    expect(withHeader('fix(ui): button', { scope: '' })).toBe('fix: button');
    expect(withHeader('Update readme', { type: 'docs' })).toBe('docs: Update readme');
    expect(withHeader('', { type: 'chore' })).toBe('chore: ');
    expect(formatConventional({ type: 'feat', scope: ' api ', breaking: true, subject: 'x' })).toBe(
      'feat(api)!: x',
    );
  });

  it('lists recent scopes by use', () => {
    expect(
      recentScopes(['fix(ui): a', 'feat(graph): b\n\nbody', 'feat(ui): c', 'plain', 'chore: d']),
    ).toEqual(['ui', 'graph']);
  });

  it('measures the subject alone', () => {
    expect(subjectLength('feat(graph): 12345')).toBe(5);
    expect(subjectLength('plain')).toBe(5);
  });
});
