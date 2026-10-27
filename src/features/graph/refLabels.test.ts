import { describe, expect, it } from 'vitest';

import type { RefLabel } from '../../ipc';
import { avatarColor, initials } from './avatarStyle';
import { displayRefs, splitOverflow } from './refLabels';

const local = (name: string, upstream: string | null = null, isHead = false): RefLabel => ({
  kind: 'localBranch',
  name,
  fullName: `refs/heads/${name}`,
  isHead,
  upstream,
});
const remote = (name: string): RefLabel => ({
  kind: 'remoteBranch',
  name,
  fullName: `refs/remotes/${name}`,
  isHead: false,
  upstream: null,
});
const tag = (name: string): RefLabel => ({
  kind: 'tag',
  name,
  fullName: `refs/tags/${name}`,
  isHead: false,
  upstream: null,
});
const stash = (n: number): RefLabel => ({
  kind: 'stash',
  name: `stash@{${String(n)}}`,
  fullName: 'refs/stash',
  isHead: false,
  upstream: null,
});
const head: RefLabel = {
  kind: 'head',
  name: 'HEAD',
  fullName: 'HEAD',
  isHead: true,
  upstream: null,
};

describe('displayRefs', () => {
  it('merges a local branch with its upstream at the same commit', () => {
    const refs = displayRefs([remote('origin/main'), local('main', 'origin/main')]);
    expect(refs).toEqual([
      expect.objectContaining({ kind: 'local', name: 'main', remote: 'origin/main' }),
    ]);
  });

  it('merges a remote with the same short name when no upstream is set', () => {
    const refs = displayRefs([local('feat/x'), remote('origin/feat/x')]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.remote).toBe('origin/feat/x');
  });

  it('keeps a remote that points elsewhere than the upstream', () => {
    const refs = displayRefs([local('main', 'origin/main'), remote('upstream/dev')]);
    expect(refs.map((r) => [r.kind, r.name, r.remote])).toEqual([
      ['local', 'main', null],
      ['remote', 'upstream/dev', null],
    ]);
  });

  it('orders HEAD, current branch, branches, remotes, tags, stashes', () => {
    const refs = displayRefs([
      stash(0),
      tag('v1.0.0'),
      remote('origin/other'),
      local('a'),
      local('current', null, true),
      head,
    ]);
    expect(refs.map((r) => r.name)).toEqual([
      'HEAD',
      'current',
      'a',
      'origin/other',
      'v1.0.0',
      'stash@{0}',
    ]);
    expect(refs[0]?.isHead).toBe(true);
    expect(refs[1]?.isHead).toBe(true);
    expect(refs.find((r) => r.kind === 'tag')?.branch).toBeNull();
  });

  it('shows a stash by its message, without the Git prefix', () => {
    const [named, bare] = displayRefs([{ ...stash(0), message: 'On main: my changes' }, stash(1)]);
    expect(named).toMatchObject({ name: 'stash@{0}', text: 'my changes' });
    expect(bare).toMatchObject({ name: 'stash@{1}', text: 'stash@{1}' });
  });

  it('keeps distinct keys for several stashes on one commit', () => {
    const keys = displayRefs([stash(0), stash(1)]).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('displayRefs with the remote tags', () => {
  it('gives a cloud to the tags on a remote, named after the remotes', () => {
    const refs = displayRefs([tag('v1'), tag('v2')], new Map([['v1', ['mirror', 'origin']]]));
    expect(refs).toEqual([
      expect.objectContaining({ kind: 'tag', name: 'v1', remote: 'mirror, origin' }),
      expect.objectContaining({ kind: 'tag', name: 'v2', remote: null }),
    ]);
    expect(displayRefs([tag('v1')])[0]?.remote).toBeNull();
  });
});

describe('splitOverflow', () => {
  const refs = displayRefs([local('a'), local('b'), local('c'), tag('t')]);

  it('shows everything when it fits', () => {
    expect(splitOverflow(refs, 4).hidden).toEqual([]);
  });

  it('leaves a slot for the +N chip', () => {
    const { shown, hidden } = splitOverflow(refs, 3);
    expect(shown.map((r) => r.name)).toEqual(['a', 'b']);
    expect(hidden.map((r) => r.name)).toEqual(['c', 't']);
  });

  it('always shows at least one label', () => {
    expect(splitOverflow(refs, 1).shown).toHaveLength(1);
  });
});

describe('avatar', () => {
  it('derives initials from names', () => {
    expect(initials('Alex Martin')).toBe('AM');
    expect(initials('linus')).toBe('LI');
    expect(initials('Aïcha Benali')).toBe('AB');
    expect(initials('kenji.watanabe')).toBe('KW');
    expect(initials('  ')).toBe('?');
    expect(initials('李 小龙')).toBe('李小');
  });

  it('gives an author a stable color whatever the case', () => {
    expect(avatarColor('Alex@example.com')).toBe(avatarColor('alex@example.com'));
    expect(avatarColor('a@x')).toBeGreaterThanOrEqual(0);
    expect(avatarColor('a@x')).toBeLessThan(8);
    const colors = new Set(['a@x', 'b@x', 'c@x', 'd@x', 'e@x', 'f@x'].map(avatarColor));
    expect(colors.size).toBeGreaterThan(2);
  });
});
