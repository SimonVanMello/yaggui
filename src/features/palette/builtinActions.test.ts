import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useShellStore } from '../../app/shellStore';
import { getAction, isActionEnabled, runAction } from './actionRegistry';
import { registerBuiltinActions } from './builtinActions';

let off: () => void;
beforeEach(() => {
  off = registerBuiltinActions();
});
afterEach(() => {
  off();
  useShellStore.setState({ logOpen: false });
});

describe('built-in actions', () => {
  it('runs a shell action by id', () => {
    expect(runAction('view.log')).toBe(true);
    expect(useShellStore.getState().logOpen).toBe(true);
  });

  it('lists the M2 Git actions as disabled', () => {
    for (const id of ['git.fetch', 'git.pull', 'git.push', 'git.commit']) {
      const action = getAction(id);
      expect(action).toBeDefined();
      if (action) expect(isActionEnabled(action)).toBe(false);
      expect(runAction(id)).toBe(false);
    }
  });

  it('disables repository actions on a welcome tab', () => {
    for (const id of ['repo.terminal', 'git.rebaseInteractive']) {
      const action = getAction(id);
      expect(action).toBeDefined();
      if (action) expect(isActionEnabled(action)).toBe(false);
    }
  });

  it('registers the history actions; continue, skip and abort need an operation', () => {
    for (const id of ['git.merge', 'git.rebase', 'git.cherryPick', 'git.revert', 'git.reset']) {
      expect(getAction(id)).toBeDefined();
    }
    for (const id of ['git.continue', 'git.skip', 'git.abort']) {
      const action = getAction(id);
      expect(action).toBeDefined();
      if (action) expect(isActionEnabled(action)).toBe(false);
    }
  });

  it('registers the remote and tag actions, disabled without a repository', () => {
    for (const id of [
      'git.remote.add',
      'git.remote.manage',
      'git.tags.fetch',
      'git.tags.pushAll',
    ]) {
      const action = getAction(id);
      expect(action).toBeDefined();
      if (action) expect(isActionEnabled(action)).toBe(false);
    }
  });

  it('removes everything it registered', () => {
    off();
    expect(getAction('tab.new')).toBeUndefined();
  });
});

describe('undo actions', () => {
  it('registers undo, redo and history with stable ids and their shortcuts', () => {
    expect(getAction('edit.undo')?.shortcut).toBe('Mod+Z');
    expect(getAction('edit.redo')?.shortcut).toBe('Mod+Shift+Z');
    expect(getAction('edit.history')).toBeDefined();
  });

  it('needs a repository', () => {
    for (const id of ['edit.undo', 'edit.redo', 'edit.history']) {
      const action = getAction(id);
      if (action) expect(isActionEnabled(action)).toBe(false);
    }
  });
});
