import { describe, expect, it } from 'vitest';

import { formatBytes, modeOctal, shortSha } from './format';

describe('diff formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(49_356, 'en')).toBe('48.2 KB');
    expect(formatBytes(49_356, 'fr')).toBe('48,2 KB');
    expect(formatBytes(3_412_880, 'en')).toBe('3.3 MB');
    expect(formatBytes(200 * 1024, 'en')).toBe('200 KB');
  });

  it('formats modes and ids', () => {
    expect(modeOctal('executable')).toBe('100755');
    expect(shortSha('a3f9c2e81b7d')).toBe('a3f9c2e');
  });
});
