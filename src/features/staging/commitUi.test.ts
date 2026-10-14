import { describe, expect, it } from 'vitest';

import { hookOutputText } from './commitUi';

describe('hook output', () => {
  it('keeps every line, however long the output is', () => {
    const stderr = Array.from({ length: 5000 }, (_, i) => `error ${String(i)}`).join('\n');
    const text = hookOutputText({ stdout: '', stderr });
    expect(text.split('\n')).toHaveLength(5000);
    expect(text.endsWith('error 4999')).toBe(true);
  });

  it('labels stderr when both streams have content', () => {
    expect(hookOutputText({ stdout: 'lint ok\n', stderr: 'test failed\n' })).toBe(
      'lint ok\n\n--- stderr ---\ntest failed',
    );
  });

  it('shows the one stream that has content as is', () => {
    expect(hookOutputText({ stdout: 'only out\n', stderr: '' })).toBe('only out');
  });
});
