import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { appendRule, mockIgnoreRule } from './commitTools';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

async function openYaggui(): Promise<number> {
  const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
  return id;
}

async function unstagedPaths(id: number): Promise<string[]> {
  const files = await unwrap(mock.changedFiles(id, { kind: 'unstaged' }));
  return files.files.map((f) => f.path);
}

describe('mock gitignore rules', () => {
  // Same cases as `git/ops/gitignore.rs`.
  it('builds the rules of the backend', () => {
    const line = (path: string, kind: 'file' | 'extension' | 'folder') => {
      const rule = mockIgnoreRule(path, kind);
      return 'ok' in rule ? rule.ok.line : null;
    };
    expect(line('logs/app.log', 'file')).toBe('/logs/app.log');
    expect(line('logs/app.log', 'extension')).toBe('*.log');
    expect(line('logs/app.log', 'folder')).toBe('/logs/');
    expect(line('a/b/c.tar.gz', 'extension')).toBe('*.gz');
    expect(line('.env', 'extension')).toBeNull();
    expect(line('top.txt', 'folder')).toBeNull();
    expect(line('a[1]*?.txt', 'file')).toBe('/a\\[1]\\*\\?.txt');
    expect(line('trail ', 'file')).toBe('/trail\\ ');
    expect(appendRule('a\nb', '/x/')).toBe('a\nb\n/x/\n');
    expect(appendRule('', '/x/')).toBe('/x/\n');
    expect(appendRule('a\r\nb', '/x/')).toBe('a\r\nb\r\n/x/\r\n');
  });

  it('previews, adds once and undoes a rule', async () => {
    const id = await openYaggui();
    const preview = await unwrap(mock.gitignorePreview(id, 'notes/todo.md', 'folder'));
    expect(preview).toEqual({
      rule: '/notes/',
      exists: false,
      matches: ['notes/todo.md'],
      matchCount: 1,
    });
    expect(await unwrap(mock.addToGitignore(id, 'notes/todo.md', 'folder'))).toBe('/notes/');
    let paths = await unstagedPaths(id);
    expect(paths).toContain('.gitignore');
    expect(paths).not.toContain('notes/todo.md');
    expect((await unwrap(mock.gitignorePreview(id, 'notes/todo.md', 'folder'))).exists).toBe(true);
    await unwrap(mock.addToGitignore(id, 'notes/todo.md', 'folder'));
    expect(await unwrap(mock.opHistory(id))).toHaveLength(1);

    const undone = await unwrap(mock.undo(id));
    expect(undone.op).toEqual({ kind: 'gitignore', rule: '/notes/' });
    paths = await unstagedPaths(id);
    expect(paths).toContain('notes/todo.md');
    expect(paths).not.toContain('.gitignore');
  });
});

describe('mock partial stash', () => {
  it('stashes only the selected files and undoes it', async () => {
    const id = await openYaggui();
    const before = await unstagedPaths(id);
    const entry = await unwrap(
      mock.stashPushPaths(id, {
        paths: ['README.md', 'notes/todo.md'],
        message: 'two files',
        includeUntracked: false,
      }),
    );
    expect(entry.message).toBe('On feat/graph-lanes: two files');
    const after = await unstagedPaths(id);
    expect(after).not.toContain('README.md');
    // Untracked without `includeUntracked`: left as is.
    expect(after).toContain('notes/todo.md');
    expect((await unwrap(mock.listRefs(id))).stashes[0]?.sha).toBe(entry.sha);

    const undone = await unwrap(mock.undo(id));
    expect(undone.op).toMatchObject({ kind: 'stashPush', count: 2 });
    expect(await unstagedPaths(id)).toEqual(before);
    expect((await unwrap(mock.listRefs(id))).stashes.some((s) => s.sha === entry.sha)).toBe(false);
  });

  it('refuses a selection with nothing to stash', async () => {
    const id = await openYaggui();
    const result = await mock.stashPushPaths(id, {
      paths: ['notes/todo.md'],
      message: null,
      includeUntracked: false,
    });
    expect(result.status === 'error' && result.error.code).toBe('nothingToStash');
  });
});

describe('mock commit store', () => {
  it('remembers committed messages, most recent first', async () => {
    const id = await openYaggui();
    await unwrap(mock.stagePaths(id, { kind: 'all' }));
    await unwrap(
      mock.commit(id, { summary: 'fix: a', description: 'Body', amend: false, skipHooks: true }),
    );
    const recent = await unwrap(mock.recentCommitMessages(id));
    expect(recent[0]?.message).toBe('fix: a\n\nBody');
  });

  it('validates profiles and template names like the store', async () => {
    const bad = await mock.saveIdentityProfile({
      id: null,
      label: 'x',
      name: 'A <b>',
      email: 'a@b',
    });
    expect(bad.status).toBe('error');
    const saved = await unwrap(
      mock.saveIdentityProfile({ id: null, label: ' OSS ', name: 'Ada', email: 'ada@oss.dev' }),
    );
    expect(saved.label).toBe('OSS');
    const clash = await mock.saveCommitTemplate({ id: null, name: 'bug FIX', body: 'x' });
    expect(clash.status).toBe('error');
  });
});
