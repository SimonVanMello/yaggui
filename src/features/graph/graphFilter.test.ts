import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTER,
  folderFilterName,
  hiddenByFolder,
  isFilterActive,
  isHidden,
  shortName,
  toggleHidden,
  toggleSolo,
} from './graphFilter';

describe('graph filter helpers', () => {
  it('hides and shows a ref again', () => {
    const hidden = toggleHidden(EMPTY_FILTER, 'refs/heads/a');
    expect(hidden.hidden).toEqual(['refs/heads/a']);
    expect(isHidden(hidden, 'refs/heads/a')).toBe(true);
    expect(isFilterActive(hidden)).toBe(true);
    expect(toggleHidden(hidden, 'refs/heads/a')).toEqual(EMPTY_FILTER);
  });

  it('solo replaces hiding the same ref, and toggles off', () => {
    const solo = toggleSolo(toggleHidden(EMPTY_FILTER, 'refs/heads/a'), 'refs/heads/a');
    expect(solo).toEqual({ ...EMPTY_FILTER, solo: 'refs/heads/a' });
    expect(toggleSolo(solo, 'refs/heads/a')).toEqual(EMPTY_FILTER);
    // Hiding the soloed ref leaves solo mode.
    expect(toggleHidden(solo, 'refs/heads/a').solo).toBeNull();
  });

  it('hides a folder of branches, including later ones, and nothing beside it', () => {
    const backup = folderFilterName('local', 'backup');
    expect(backup).toBe('refs/heads/backup/');
    expect(folderFilterName('remote', 'origin/feat')).toBe('refs/remotes/origin/feat/');
    const filter = toggleHidden(
      { ...EMPTY_FILTER, hidden: ['refs/heads/backup/old', 'refs/heads/main'] },
      backup,
    );
    // The entries the folder covers are dropped, the others kept.
    expect(filter.hidden).toEqual(['refs/heads/main', backup]);
    expect(isHidden(filter, 'refs/heads/backup/new')).toBe(true);
    expect(isHidden(filter, 'refs/heads/backup/2026/x')).toBe(true);
    expect(isHidden(filter, folderFilterName('local', 'backup/2026'))).toBe(true);
    expect(isHidden(filter, 'refs/heads/backups')).toBe(false);
    expect(isHidden(filter, 'refs/remotes/origin/backup/new')).toBe(false);
    // A branch hidden with its folder is shown again from the folder only.
    expect(hiddenByFolder(filter, 'refs/heads/backup/new')).toBe(backup);
    expect(hiddenByFolder(filter, backup)).toBeNull();
    expect(hiddenByFolder(filter, 'refs/heads/main')).toBeNull();
    expect(toggleHidden(filter, backup).hidden).toEqual(['refs/heads/main']);
  });

  it('hiding the folder of the soloed branch leaves solo mode', () => {
    const solo = toggleSolo(EMPTY_FILTER, 'refs/heads/backup/a');
    expect(toggleHidden(solo, 'refs/heads/backup/').solo).toBeNull();
    expect(toggleHidden(solo, 'refs/heads/other/').solo).toBe('refs/heads/backup/a');
  });

  it('hides every remote branch at once', () => {
    const filter = { ...EMPTY_FILTER, hideRemotes: true };
    expect(isHidden(filter, 'refs/remotes/origin/main')).toBe(true);
    expect(isHidden(filter, 'refs/heads/main')).toBe(false);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it('shortens names', () => {
    expect(shortName('refs/remotes/origin/x')).toBe('origin/x');
    expect(shortName('refs/heads/feat/y')).toBe('feat/y');
    expect(shortName('HEAD')).toBe('HEAD');
  });
});
