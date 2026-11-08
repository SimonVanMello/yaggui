import { describe, expect, it } from 'vitest';

import { checkRepoName, MAX_REPO_NAME_LENGTH } from './repoName';

describe('checkRepoName', () => {
  it('trims the name and accepts an empty one (back to the folder name)', () => {
    expect(checkRepoName('  Backend ')).toEqual({ ok: true, name: 'Backend' });
    expect(checkRepoName('   ')).toEqual({ ok: true, name: '' });
  });

  it('counts characters, not UTF-16 units, up to the bound', () => {
    expect(checkRepoName('é'.repeat(MAX_REPO_NAME_LENGTH)).ok).toBe(true);
    expect(checkRepoName('🦀'.repeat(MAX_REPO_NAME_LENGTH)).ok).toBe(true);
    expect(checkRepoName('a'.repeat(MAX_REPO_NAME_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'tooLong',
    });
    // Spaces around the name do not count.
    expect(checkRepoName(` ${'a'.repeat(MAX_REPO_NAME_LENGTH)} `).ok).toBe(true);
  });
});

describe('folderName', () => {
  it('takes the last component of Unix and Windows paths', async () => {
    const { folderName } = await import('./repoName');
    expect(folderName('/home/me/api-server')).toBe('api-server');
    expect(folderName('C:\\work\\front\\')).toBe('front');
    expect(folderName('/')).toBe('/');
  });
});
