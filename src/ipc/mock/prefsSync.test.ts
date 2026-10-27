import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../app/preferences';
import { normalizePreferences } from './create';
import {
  exportPreferencesText,
  keybindingChanges,
  parsePreferencesFile,
  preferenceChanges,
  sampleImportFile,
} from './prefsSync';

const parse = (text: string) =>
  parsePreferencesFile(text, DEFAULT_PREFERENCES, normalizePreferences);

describe('mock preferences file', () => {
  it('exports every portable setting and no machine-specific one', () => {
    const file = JSON.parse(
      exportPreferencesText(
        { ...DEFAULT_PREFERENCES, gitPath: '/usr/bin/git', editor: 'code' },
        [],
      ),
    ) as { preferences: Record<string, unknown> };
    expect(Object.keys(file.preferences)).toHaveLength(20);
    for (const key of [
      'gitPath',
      'editor',
      'terminal',
      'diffTool',
      'mergeTool',
      'checkUpdates',
      'aiEnabled',
      'claudePath',
    ]) {
      expect(file.preferences).not.toHaveProperty(key);
    }
  });

  it('round-trips an export', () => {
    const wanted = { ...DEFAULT_PREFERENCES, theme: 'dark' as const, fontSize: 16 };
    const parsed = parse(exportPreferencesText(wanted, [{ action: 'tab.new', shortcut: 'Mod+N' }]));
    expect('code' in parsed).toBe(false);
    if ('code' in parsed) return;
    expect(parsed.preferences).toEqual(wanted);
    expect(parsed.keybindings).toEqual([{ action: 'tab.new', shortcut: 'Mod+N' }]);
    expect(preferenceChanges(DEFAULT_PREFERENCES, parsed.preferences).map((c) => c.key)).toEqual([
      'theme',
      'fontSize',
    ]);
  });

  it('merges a partial AI section over the current settings and ignores the consent', () => {
    const parsed = parse(
      JSON.stringify({
        format: 'yaggui-preferences',
        version: 1,
        preferences: {
          ai: { provider: 'claudeCode', claudeCode: { skill: 'commit' } },
          aiEnabled: true,
        },
      }),
    );
    if ('code' in parsed) throw new Error(parsed.code);
    expect(parsed.preferences.ai).toMatchObject({
      provider: 'claudeCode',
      claudeCode: { model: null, skill: 'commit' },
      maxDiffBytes: 60_000,
    });
    expect(parsed.preferences.aiEnabled).toBe(false);
    expect(parsed.ignored).toEqual([{ key: 'aiEnabled', reason: 'machineSpecific' }]);
  });

  it('lists machine-specific and unknown keys as ignored', () => {
    const parsed = parse(sampleImportFile());
    if ('code' in parsed) throw new Error(parsed.code);
    expect(parsed.ignored).toEqual([
      { key: 'editor', reason: 'machineSpecific' },
      { key: 'gitPath', reason: 'machineSpecific' },
      { key: 'commitGraphStyle', reason: 'unknown' },
    ]);
    expect(parsed.preferences.editor).toBeNull();
  });

  it('rejects invalid files and newer versions with typed errors', () => {
    for (const text of [
      'nope',
      '{"format":"x","version":1}',
      '{"format":"yaggui-preferences","version":"1"}',
      '{"format":"yaggui-preferences","version":1,"preferences":{"theme":"neon"}}',
      '{"format":"yaggui-preferences","version":1,"preferences":{"fontSize":99}}',
      '{"format":"yaggui-preferences","version":1,"keybindings":[{"action":"a","shortcut":"Hyper+A"}]}',
    ]) {
      const parsed = parse(text);
      expect('code' in parsed && parsed.code).toBe('preferencesFileInvalid');
    }
    const newer = parse('{"format":"yaggui-preferences","version":2}');
    expect('code' in newer && newer.code).toBe('preferencesFileTooNew');
  });

  it('diffs shortcuts both ways, the default counting as "not custom"', () => {
    const changes = keybindingChanges(
      [{ action: 'tab.close', shortcut: 'Mod+Q' }],
      [{ action: 'tab.new', shortcut: null }],
    );
    expect(changes).toEqual([
      {
        action: 'tab.close',
        before: { custom: true, shortcut: 'Mod+Q' },
        after: { custom: false, shortcut: null },
      },
      {
        action: 'tab.new',
        before: { custom: false, shortcut: null },
        after: { custom: true, shortcut: null },
      },
    ]);
  });
});
