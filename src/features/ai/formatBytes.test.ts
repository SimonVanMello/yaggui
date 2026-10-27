import { describe, expect, it } from 'vitest';

import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  it('uses decimal units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 kB');
    expect(formatBytes(60_000)).toBe('60 kB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
  });
});
