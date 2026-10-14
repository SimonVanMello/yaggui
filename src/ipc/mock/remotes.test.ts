import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { checkRemoteName, checkRemoteUrl } from './remotes';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

async function openYaggui(): Promise<number> {
  return (await unwrap(mock.openRepo('/Users/alex/dev/yaggui'))).id;
}

describe('mock remotes and tags (M4-7c)', () => {
  it('checks names and URLs like the backend', () => {
    for (const name of ['origin', 'my-fork', 'team/mirror'])
      expect(checkRemoteName(name)).toBeNull();
    for (const name of ['', '-x', 'a b', 'a..b', 'a:b', 'a~b']) {
      expect(checkRemoteName(name)?.code).toBe('invalidRemoteName');
    }
    expect(checkRemoteUrl('  git@h:a/b.git ')).toEqual({ ok: 'git@h:a/b.git' });
    for (const url of ['', '--upload-pack=x', 'a\nb']) {
      expect(checkRemoteUrl(url)).toMatchObject({ error: { code: 'invalidArgument' } });
    }
  });

  it('adds, edits, renames and removes a remote', async () => {
    const id = await openYaggui();
    await unwrap(mock.addRemote(id, 'fork', 'git@h:me/yaggui.git', 'git@h:me/push.git'));
    expect(await mock.addRemote(id, 'fork', 'x', null)).toMatchObject({
      status: 'error',
      error: { code: 'remoteExists' },
    });
    expect(await mock.validateRemoteName(id, 'origin')).toMatchObject({
      status: 'error',
      error: { code: 'remoteExists' },
    });
    let refs = await unwrap(mock.listRefs(id));
    expect(refs.remotes.find((r) => r.name === 'fork')).toMatchObject({
      url: 'git@h:me/yaggui.git',
      pushUrl: 'git@h:me/push.git',
    });

    await unwrap(mock.setRemoteUrls(id, 'fork', 'git@h:me/new.git', null));
    await unwrap(mock.renameRemote(id, 'fork', 'mine'));
    refs = await unwrap(mock.listRefs(id));
    expect(refs.remotes.find((r) => r.name === 'mine')).toMatchObject({
      url: 'git@h:me/new.git',
      pushUrl: null,
    });
    expect(await unwrap(mock.listRemotes(id))).toEqual(['origin', 'mine']);

    const removed = await unwrap(mock.removeRemote(id, 'mine'));
    expect(removed).toMatchObject({ name: 'mine', url: 'git@h:me/new.git', tracking: [] });
    expect(await mock.removeRemote(id, 'mine')).toMatchObject({
      status: 'error',
      error: { code: 'remoteNotFound' },
    });
  });

  it('previews and removes tracking branches and upstreams with the remote', async () => {
    const id = await openYaggui();
    const before = await unwrap(mock.listRefs(id));
    const origin = before.remotes.find((r) => r.name === 'origin');
    const preview = await unwrap(mock.remoteRemovalPreview(id, 'origin'));
    expect(preview.tracking).toEqual(origin?.branches.map((b) => b.name).sort());
    expect(preview.upstreamOf.length).toBeGreaterThan(0);

    await unwrap(mock.renameRemote(id, 'origin', 'upstream'));
    const renamed = await unwrap(mock.listRefs(id));
    const tracked = renamed.local.filter((b) => b.upstream !== null);
    expect(tracked.every((b) => b.upstream?.name.startsWith('upstream/'))).toBe(true);

    const removed = await unwrap(mock.removeRemote(id, 'upstream'));
    expect(removed.tracking).toHaveLength(preview.tracking.length);
    const after = await unwrap(mock.listRefs(id));
    expect(after.remotes).toEqual([]);
    expect(after.local.every((b) => b.upstream === null)).toBe(true);
  });

  // The mock network commands take ~1 s each, like a real round trip.
  it('pushes all tags once, then refuses a moved one', { timeout: 20_000 }, async () => {
    const id = await openYaggui();
    const tags = (await unwrap(mock.listRefs(id))).tags.map((t) => t.name).sort();
    expect(tags.length).toBeGreaterThan(0);
    expect(await unwrap(mock.pushAllTags(id, 'origin'))).toEqual({ pushed: tags, upToDate: 0 });
    expect(await unwrap(mock.pushAllTags(id, 'origin'))).toEqual({
      pushed: [],
      upToDate: tags.length,
    });
    const [first] = tags;
    if (first === undefined) return;
    await unwrap(mock.deleteTag(id, first));
    const head = (await unwrap(mock.repoState(id))).head;
    const target = head.kind === 'unborn' ? '' : head.oid;
    await unwrap(mock.createTag(id, { name: first, target, message: null, sign: false }));
    expect(await mock.pushTag(id, 'origin', first)).toMatchObject({
      status: 'error',
      error: { code: 'tagRejected' },
    });
    await unwrap(mock.deleteRemoteTag(id, 'origin', first));
    expect(await unwrap(mock.pushTag(id, 'origin', first))).toEqual({
      pushed: [first],
      upToDate: 0,
    });
    await unwrap(mock.fetchTags(id, { kind: 'all' }));
    expect(await mock.fetchTags(id, { kind: 'remote', name: 'nope' })).toMatchObject({
      status: 'error',
      error: { code: 'remoteNotFound' },
    });
  });
});

describe('mock undo of remotes and tags (M4-7c)', () => {
  it('undoes and redoes remote and local tag operations', async () => {
    const id = await openYaggui();
    const before = await unwrap(mock.listRefs(id));
    await unwrap(mock.removeRemote(id, 'origin'));
    expect((await unwrap(mock.listRefs(id))).remotes).toEqual([]);
    const undone = await unwrap(mock.undo(id));
    expect(undone.op).toEqual({ kind: 'removeRemote', name: 'origin' });
    const back = await unwrap(mock.listRefs(id));
    expect(back.remotes).toEqual(before.remotes);
    expect(back.local.map((b) => b.upstream?.name ?? null)).toEqual(
      before.local.map((b) => b.upstream?.name ?? null),
    );
    await unwrap(mock.redo(id));
    expect((await unwrap(mock.listRefs(id))).remotes).toEqual([]);
    await unwrap(mock.undo(id));

    await unwrap(mock.renameRemote(id, 'origin', 'upstream'));
    await unwrap(mock.undo(id));
    expect(await unwrap(mock.listRemotes(id))).toEqual(['origin']);

    await unwrap(mock.addRemote(id, 'fork', 'git@h:me/yaggui.git', null));
    await unwrap(mock.undo(id));
    expect(await unwrap(mock.listRemotes(id))).toEqual(['origin']);

    const tag = before.tags[0]?.name ?? '';
    await unwrap(mock.deleteTag(id, tag));
    expect((await unwrap(mock.undo(id))).op).toEqual({ kind: 'deleteTag', name: tag });
    expect((await unwrap(mock.listRefs(id))).tags.map((t) => t.name)).toContain(tag);
  });

  it('journals a change of URLs like the backend (M4-8): undone, and skipped when unchanged', async () => {
    const id = await openYaggui();
    const urlOf = async () =>
      (await unwrap(mock.listRefs(id))).remotes.find((r) => r.name === 'origin')?.url;
    const before = await urlOf();
    await unwrap(mock.setRemoteUrls(id, 'origin', before ?? '', null));
    expect(await unwrap(mock.opHistory(id))).toEqual([]);

    await unwrap(mock.setRemoteUrls(id, 'origin', 'git@h:me/elsewhere.git', null));
    expect((await unwrap(mock.opHistory(id)))[0]?.op).toEqual({
      kind: 'setRemoteUrls',
      name: 'origin',
    });
    await unwrap(mock.undo(id));
    expect(await urlOf()).toBe(before);
    await unwrap(mock.redo(id));
    expect(await urlOf()).toBe('git@h:me/elsewhere.git');
  });
});
