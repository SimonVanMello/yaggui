import { beforeEach, describe, expect, it } from 'vitest';

import { MockSettings, isToolName, isValidConfigKey, isValidShortcut } from './settings';

describe('validators mirror the backend', () => {
  it('shortcut syntax', () => {
    for (const ok of ['Mod+T', 'Mod+Shift+Alt+S', 'F5', 'Mod+,'])
      expect(isValidShortcut(ok)).toBe(true);
    for (const bad of ['', 'Mod+', 'Mod+Mod+T', 'Cmd+T', 'Mod+T+Y', 'Mod+ T'])
      expect(isValidShortcut(bad)).toBe(false);
  });

  it('config keys', () => {
    for (const ok of ['user.name', 'branch.feat/x.remote', 'gpg.ssh.program'])
      expect(isValidConfigKey(ok)).toBe(true);
    for (const bad of ['', 'nodot', '-c.x', 'user.na me', 'a.1', 'user.'])
      expect(isValidConfigKey(bad)).toBe(false);
  });

  it('tool names', () => {
    expect(isToolName('meld')).toBe(true);
    expect(isToolName('--evil')).toBe(false);
    expect(isToolName('a b')).toBe(false);
  });
});

describe('MockSettings', () => {
  let settings: MockSettings;
  beforeEach(() => {
    settings = new MockSettings();
    settings.reset();
  });

  it('sets, replaces and removes config keys per scope', () => {
    expect(settings.configSet('global', null, 'pull.rebase', 'true')).toBeNull();
    expect(settings.configSet('global', null, 'Pull.Rebase', 'false')).toBeNull();
    const list = settings.configList('global', null);
    expect(list).toEqual(expect.arrayContaining([{ key: 'pull.rebase', value: 'false' }]));
    expect(Array.isArray(list) && list.filter((e) => e.key === 'pull.rebase')).toHaveLength(1);
    settings.configSet('global', null, 'pull.rebase', null);
    expect(JSON.stringify(settings.configList('global', null))).not.toContain('pull.rebase');
  });

  it('refuses the repository scope without a repository and bad keys', () => {
    expect(settings.configSet('repo', null, 'a.b', 'x')).toMatchObject({ code: 'invalidArgument' });
    expect(settings.configSet('global', null, 'nodot', 'x')).toMatchObject({
      code: 'invalidArgument',
    });
  });

  it('looks tools up like git --tool-help', () => {
    expect(settings.check('diffTool', 'meld', null)).toMatchObject({ ok: true });
    expect(settings.check('diffTool', 'kdiff3', null)).toMatchObject({
      ok: false,
      issue: 'notInstalled',
    });
    expect(settings.check('mergeTool', 'nope', null)).toMatchObject({
      ok: false,
      issue: 'unknown',
    });
    expect(settings.check('mergeTool', null, null)).toMatchObject({
      ok: false,
      issue: 'notConfigured',
    });
    settings.configSet('global', null, 'mergetool.nope.cmd', 'true');
    expect(settings.check('mergeTool', 'nope', null)).toMatchObject({ ok: true });
  });

  it('simulates a missing editor', () => {
    expect(settings.check('editor', 'missing-editor', null)).toMatchObject({
      code: 'editorNotFound',
    });
    expect(settings.check('editor', 'code', null)).toMatchObject({ ok: true, tool: 'code' });
  });
});
