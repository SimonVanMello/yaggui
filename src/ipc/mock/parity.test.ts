import { beforeEach, describe, expect, it } from 'vitest';

import type { RebaseAction } from '../bindings';
import { MockBackend, mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { mapToHead } from './inspect';
import { MockWip } from './wip';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/**
 * Where the M3-5 audit found the mock and the real backend apart. The reference is the real
 * backend (`src-tauri/tests/conflict_scenarios.rs`, `history.rs`, `interactive_rebase.rs`).
 */
describe('mock / backend parity (M3)', () => {
  it('a diverged pull stops with `conflicts` and resolves like a merge', async () => {
    // `blog` is behind origin/main: a local commit makes it diverge.
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    mockBackend.simulateCommit(id, 'local work');
    mockBackend.simulatePullConflict(id);

    const stopped = await mock.pull(id, 'merge');
    expect(stopped).toMatchObject({
      status: 'error',
      error: {
        code: 'conflicts',
        payload: { kind: 'conflicts', operation: { kind: 'merge', squash: false } },
      },
    });
    if (stopped.status !== 'error') return;
    expect(stopped.error.message.en).toMatch(/^The pull stopped on conflicts/);
    expect((await unwrap(mock.repoState(id))).operation).toEqual({ kind: 'merge', squash: false });

    const { files } = await unwrap(mock.listConflicts(id));
    await unwrap(
      mock.resolveConflicts(
        id,
        files.map((f) => f.path),
        { kind: 'ours' },
      ),
    );
    const done = await unwrap(mock.continueOperation(id, null));
    expect(done.effect).toBe('commits');
    expect((await unwrap(mock.commitDetail(id, done.head))).parents).toHaveLength(2);
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
  });

  it('a diverged rebase pull stops as a rebase of the branch onto its upstream', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    mockBackend.simulateCommit(id, 'local work');
    mockBackend.simulatePullConflict(id);
    const stopped = await mock.pull(id, 'rebase');
    expect(stopped).toMatchObject({
      status: 'error',
      error: { code: 'conflicts', payload: { operation: { kind: 'rebase', headName: 'main' } } },
    });
    const state = await unwrap(mock.repoState(id));
    expect(state.head.kind).toBe('detached');
    const detail = await unwrap(mock.operationDetail(id));
    expect(detail?.labels.ours.branch).toBe('origin/main');
    expect(detail?.labels.theirs.commit?.summary).toBe('local work');
  });

  it('an interactive rebase halts on each `edit`, continue after continue', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const plan = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~4'));
    const actions: RebaseAction[] = ['pick', 'edit', 'pick', 'edit'];
    const result = await unwrap(
      mock.interactiveRebase(
        id,
        'HEAD~4',
        plan.commits.map((c, i) => ({ sha: c.sha, action: actions[i] ?? 'pick', message: null })),
      ),
    );
    expect(result.stopped).toMatchObject({ step: 2, total: 4 });
    const first = await unwrap(mock.operationDetail(id));
    expect(first?.labels.ours.commit?.sha).toBe(plan.base.sha);
    expect(first?.message).toContain(plan.commits[1]?.summary ?? '?');

    await unwrap(mock.continueOperation(id, null));
    expect((await unwrap(mock.repoState(id))).operation).toMatchObject({
      kind: 'rebase',
      step: 4,
      total: 4,
    });
    await unwrap(mock.continueOperation(id, null));
    const state = await unwrap(mock.repoState(id));
    expect(state.operation).toBeNull();
    expect(state.head).toMatchObject({ kind: 'branch', name: 'main' });
  });

  it('a rebase stopped on conflicts shows HEAD detached', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/conflict-demo'));
    const refs = await unwrap(mock.listRefs(id));
    const head = refs.local.find((b) => b.isHead);
    const other = refs.local.find((b) => !b.isHead && b.sha !== head?.sha);
    await mock.rebase(id, { branch: null, onto: other?.sha ?? '' });
    expect((await unwrap(mock.repoState(id))).head.kind).toBe('detached');
  });

  it('validates the parent of a cherry-pick or revert like `check_mainline`', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const plan = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~4'));
    const head = { sha: plan.commits[2]?.sha ?? '' };
    const pick = (mainline: number) => mock.cherryPick(id, { commits: [head.sha], mainline });
    expect(await pick(0)).toMatchObject({ error: { code: 'invalidArgument' } });
    expect(await pick(2)).toMatchObject({
      error: { message: { en: `Parent 2 does not exist for ${head.sha.slice(0, 7)}.` } },
    });
    expect(await mock.revert(id, { commit: head.sha, mainline: 1 })).toMatchObject({
      error: { code: 'invalidArgument' },
    });
  });

  it('a commit already applied stops empty: continue needs a change, skip ends it', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/empty-pick'));
    const plan = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~2'));
    const head = { sha: plan.commits[0]?.sha ?? '' };
    expect(await mock.cherryPick(id, { commits: [head.sha], mainline: null })).toMatchObject({
      error: { code: 'emptyCommit' },
    });
    expect((await unwrap(mock.repoState(id))).operation).toEqual({ kind: 'cherryPick' });
    expect(await mock.continueOperation(id, null)).toMatchObject({
      error: { code: 'emptyCommit' },
    });
    const skipped = await unwrap(mock.skipOperation(id));
    expect(skipped.effect).toBe('upToDate');
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
  });

  it('a rebase with nothing to replay fast-forwards', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const result = await unwrap(mock.rebase(id, { branch: null, onto: 'origin/main' }));
    expect(result.effect).toBe('fastForward');
  });

  it('a resolved binary conflict is no longer reported as binary', async () => {
    const { id, other } = await openWithOther('/Users/alex/dev/conflict-demo');
    await mock.merge(id, { source: other, mode: 'noFastForward', message: null });
    await unwrap(mock.resolveConflicts(id, ['assets/logo.png'], { kind: 'theirs' }));
    const logo = (await unwrap(mock.listConflicts(id))).files.find(
      (f) => f.path === 'assets/logo.png',
    );
    expect(logo).toEqual({ path: 'assets/logo.png', kind: null, binary: false, resolved: true });
  });
});

async function openWithOther(path: string): Promise<{ id: number; other: string }> {
  const { id } = await unwrap(mock.openRepo(path));
  const refs = await unwrap(mock.listRefs(id));
  const head = refs.local.find((b) => b.isHead)?.sha;
  return { id, other: refs.local.find((b) => !b.isHead && b.sha !== head)?.name ?? '' };
}

/**
 * Where the M4-8 audit found the mock and the real backend apart (reference: the Rust tests
 * named in each case).
 */
describe('mock / backend parity (M4)', () => {
  it('an undo that would overwrite files changed since is refused (`undo.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    await unwrap(mock.discardPaths(id, { kind: 'paths', paths: ['README.md'] }, true));
    expect(mockBackend.simulateEdit(id, 'README.md', 'edited since\n')).toBe(true);
    expect(await mock.undo(id)).toMatchObject({
      status: 'error',
      error: { code: 'undoWouldOverwrite', payload: { kind: 'undoChanges', paths: ['README.md'] } },
    });
  });

  it('a reset during an operation follows Git (`history.rs`, reset_during_…)', async () => {
    const merge = await openWithOther('/Users/alex/dev/conflict-reset');
    await mock.merge(merge.id, { source: merge.other, mode: 'noFastForward', message: null });
    const reset = (id: number, mode: 'soft' | 'mixed' | 'hard') =>
      mock.reset(id, { target: 'HEAD', mode });
    expect(await reset(merge.id, 'soft')).toMatchObject({
      error: { code: 'operationInProgress' },
    });
    expect((await unwrap(mock.repoState(merge.id))).operation?.kind).toBe('merge');
    await unwrap(reset(merge.id, 'mixed'));
    expect((await unwrap(mock.repoState(merge.id))).operation).toBeNull();

    // A cherry-pick of several commits stays in progress after a hard reset.
    const pick = await unwrap(mock.openRepo('/Users/alex/dev/conflict-picks'));
    const plan = await unwrap(mock.interactiveRebasePlan(pick.id, 'HEAD~3'));
    const shas = plan.commits.slice(0, 2).map((c) => c.sha);
    expect(await mock.cherryPick(pick.id, { commits: shas, mainline: null })).toMatchObject({
      error: { code: 'conflicts' },
    });
    await unwrap(reset(pick.id, 'hard'));
    expect((await unwrap(mock.repoState(pick.id))).operation).toEqual({ kind: 'cherryPick' });
  });

  it('the hard reset preview lists untracked files the target tracks', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    // Commits made by the mock touch `README.md`.
    mockBackend.simulateCommit(id, 'tracks README');
    mockBackend.simulateEdit(id, 'README.md', 'untracked copy\n');
    const preview = await unwrap(mock.resetPreview(id, 'HEAD'));
    expect(preview.hardLost).toContainEqual({ path: 'README.md', change: 'untracked' });
  });

  it('the external merge tool can fail or be closed without saving (`history.rs`)', async () => {
    for (const [path, expected] of [
      ['/Users/alex/dev/conflict-mergetool-fails', { error: { code: 'mergeToolFailed' } }],
      ['/Users/alex/dev/conflict-mergetool-unsaved', { data: { resolved: false } }],
    ] as const) {
      const { id, other } = await openWithOther(path);
      await mock.merge(id, { source: other, mode: 'noFastForward', message: null });
      expect(await mock.runMergeTool(id, 'src/app/App.tsx')).toMatchObject(expected);
      expect((await unwrap(mock.listConflicts(id))).unresolved).toBe(4);
    }
  });
});

/**
 * Where the M7-10 audit found the mock and the real backend apart (reference: the Rust code
 * and tests named in each case).
 */
describe('mock / backend parity (M7)', () => {
  it('forgetting a repository drops its graph filter (`store/tests.rs`, cascade)', async () => {
    const path = '/Users/alex/dev/blog';
    const { id } = await unwrap(mock.openRepo(path));
    const filter = await unwrap(mock.graphFilter(id));
    await unwrap(mock.setGraphFilter(id, { ...filter, firstParent: true }));
    await unwrap(mock.closeRepo(id));
    await unwrap(mock.forgetRepo(id));
    const again = await unwrap(mock.openRepo(path));
    expect((await unwrap(mock.graphFilter(again.id))).firstParent ?? false).toBe(false);
  });

  it('an imported `diffOptions` is read like the Rust struct (`prefs_sync.rs`)', async () => {
    const file = (diffOptions: unknown) =>
      JSON.stringify({ format: 'yaggui-preferences', version: 1, preferences: { diffOptions } });
    // Same options without `markdownPreview`, keys in another order, an unknown field: no change.
    const { diffOptions } = await unwrap(mock.getPreferences());
    const rest: Partial<typeof diffOptions> = { ...diffOptions };
    delete rest.markdownPreview;
    mockBackend.setPickedPreferencesFile(
      file({ extra: 1, ...Object.fromEntries(Object.entries(rest).reverse()) }),
    );
    expect((await unwrap(mock.previewPreferencesImport('')))?.changes).toEqual([]);

    mockBackend.setPickedPreferencesFile(file({ ...diffOptions, contextLines: -1 }));
    expect(await mock.previewPreferencesImport('')).toMatchObject({
      error: { code: 'preferencesFileInvalid' },
    });
  });

  it('imported shortcuts: a missing `shortcut` removes it, at most 1000 entries', async () => {
    const file = (keybindings: unknown) =>
      JSON.stringify({ format: 'yaggui-preferences', version: 1, keybindings });
    mockBackend.setPickedPreferencesFile(file([{ action: 'tab.new' }]));
    const preview = await unwrap(mock.previewPreferencesImport(''));
    expect(preview?.keybindingChanges).toEqual([
      expect.objectContaining({ action: 'tab.new', after: { custom: true, shortcut: null } }),
    ]);

    const many = Array.from({ length: 1001 }, (_, i) => ({
      action: `a${String(i)}`,
      shortcut: null,
    }));
    mockBackend.setPickedPreferencesFile(file(many));
    expect(await mock.previewPreferencesImport('')).toMatchObject({
      error: { code: 'preferencesFileInvalid' },
    });
  });

  it('cancelling the export dialog writes nothing (`commands/settings.rs`)', async () => {
    mockBackend.setPickedExportPath(null);
    expect(await unwrap(mock.exportPreferences(''))).toBeNull();
    expect(mockBackend.exportedPreferences()).toBeNull();
    mockBackend.setPickedExportPath('/tmp/prefs.json');
    expect(await unwrap(mock.exportPreferences(''))).toBe('/tmp/prefs.json');
    expect(mockBackend.exportedPreferences('/tmp/prefs.json')).toContain('yaggui-preferences');
  });

  it('a tree lists names in code point order and decodes a non-UTF-8 file (`tree.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const page = await unwrap(mock.treeList(id, 'HEAD', 'docs', 0, 500));
    const names = page.entries.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    const legacy = await unwrap(mock.treeFile(id, 'HEAD', 'docs/legacy-notes.txt', false));
    expect(legacy.content).toMatchObject({ kind: 'text', encoding: 'windows1252' });
  });

  /** The yaggui showcase stashed with its untracked file, which is then applied alone. */
  async function applyUntrackedFromStash() {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const untracked = async () =>
      (await unwrap(mock.changedFiles(id, { kind: 'unstaged' }))).files
        .filter((f) => f.status === 'untracked')
        .map((f) => f.path);
    const [path = ''] = await untracked();
    const pushed = await unwrap(
      mock.stashPush(id, { message: 'wip', includeUntracked: true, keepIndex: false }),
    );
    const stash = { index: 0, sha: pushed.sha };
    await unwrap(mock.stashApplyFile(id, { stash, path, untracked: true }));
    return { id, path, stash, untracked };
  }

  it('a file undo only checks its own files and runs during an operation (`journal.rs`)', async () => {
    const { id, untracked } = await applyUntrackedFromStash();
    // An unrelated edit, then a merge stopped on conflicts: `Mode::Files` ignores both.
    mockBackend.simulateEdit(id, 'README.md', 'edited elsewhere\n');
    mockBackend.simulateOperation(id, 'merge');
    await unwrap(mock.undo(id));
    expect(await untracked()).toEqual([]);
    expect((await unwrap(mock.repoState(id))).operation?.kind).toBe('merge');
  });

  it('an untracked file must come from the stash third parent (`not_in_stash`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const pushed = await unwrap(
      mock.stashPush(id, { message: 'tracked only', includeUntracked: false, keepIndex: false }),
    );
    const stash = { index: 0, sha: pushed.sha };
    const missing = await mock.stashApplyFile(id, { stash, path: 'nope.txt', untracked: true });
    expect(missing).toMatchObject({
      error: {
        code: 'invalidArgument',
        message: { en: '"nope.txt" is not a file of this stash.' },
      },
    });
  });

  it('a file the stash deletes is deleted, unstaged (`stash_file.rs`)', () => {
    const wip = MockWip.fromChanges(
      [],
      [
        {
          path: 'f.txt',
          status: 'deleted',
          oldMode: 'regular',
          newMode: null,
          old: 'x\n',
          new: null,
        },
      ],
    );
    const saved = wip.stash(false, false);
    expect(wip.worktreeText('f.txt')).toBe('x\n');
    expect(
      wip.applyStashFile('f.txt', false, saved?.worktree.get('f.txt')?.text ?? null, false),
    ).toEqual({
      ok: 'applied',
    });
    expect(wip.worktreeText('f.txt')).toBeNull();
    expect(wip.changes('unstaged')).toContainEqual(
      expect.objectContaining({ path: 'f.txt', status: 'deleted' }),
    );
  });

  it('a file gone on our side cannot take the stash change (`stash_file_missing`)', () => {
    const change = {
      path: 'f.txt',
      status: 'modified' as const,
      oldMode: 'regular' as const,
      newMode: 'regular' as const,
      old: 'x\n',
      new: 'y\n',
    };
    const saved = MockWip.fromChanges([], [change]).stash(false, false);
    expect(saved?.base.get('f.txt')?.text).toBe('x\n');
    // The deletion was staged since: the index no longer has the file.
    const gone = MockWip.fromChanges(
      [{ ...change, status: 'deleted', newMode: null, new: null }],
      [],
    );
    expect(
      gone.applyStashFile('f.txt', false, 'y\n', false, saved?.base.has('f.txt')),
    ).toMatchObject({
      error: {
        code: 'invalidArgument',
        message: { en: expect.stringContaining('no longer exists on your side') as string },
      },
    });
    // A file the stash adds is not in its base: it comes back staged.
    expect(gone.applyStashFile('g.txt', false, 'y\n', false, false)).toEqual({ ok: 'applied' });
  });

  it('bisect marks survive a page reload (`refs/bisect/*`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    mockBackend.simulateOperation(id, 'bisect', { marks: { bad: 'HEAD', good: ['HEAD~12'] } });
    await unwrap(mock.bisectMark(id, 'HEAD~6', 'good'));
    const before = await unwrap(mock.bisectState(id));

    // A new page: a new backend reads the same store.
    const reloaded = new MockBackend();
    const reopened = await unwrap(reloaded.commands.openRepo('/Users/alex/dev/blog'));
    expect((await unwrap(reloaded.commands.repoState(reopened.id))).operation).toEqual({
      kind: 'bisect',
    });
    const after = await unwrap(reloaded.commands.bisectState(reopened.id));
    expect(after).toMatchObject({
      original: before?.original,
      remaining: before?.remaining,
      steps: before?.steps,
    });
    expect(after?.bad).not.toBeNull();
    expect(after?.good).toHaveLength(2);

    // Ending the bisect forgets the marks for good.
    await unwrap(reloaded.commands.abortOperation(reopened.id));
    const again = new MockBackend();
    const last = await unwrap(again.commands.openRepo('/Users/alex/dev/blog'));
    expect((await unwrap(again.commands.repoState(last.id))).operation).toBeNull();
    expect(await unwrap(again.commands.bisectState(last.id))).toBeNull();
  });

  describe('undo journal (`store/undo_journal.rs`, `journal.rs`)', () => {
    async function journaled() {
      const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
      await unwrap(mock.createBranch(id, 'topic', { kind: 'head' }, false));
      return id;
    }

    it('forgets the entries past 30 days when the journal is read back', async () => {
      const id = await journaled();
      mockBackend.simulateRestoredJournal(id, { ageDays: 29 });
      expect(await unwrap(mock.opHistory(id))).toHaveLength(1);
      // 29 + 2 days: older than the bound.
      mockBackend.simulateRestoredJournal(id, { ageDays: 2 });
      expect(await unwrap(mock.opHistory(id))).toEqual([]);
      expect(await mock.undo(id)).toMatchObject({ error: { code: 'nothingToUndo' } });
    });

    it('prunes by age when an operation is appended, then keeps the last 100', async () => {
      const id = await journaled();
      mockBackend.simulateRestoredJournal(id, { ageDays: 31 });
      // Expired at the next append, which is the only entry left.
      await unwrap(mock.createBranch(id, 'topic-2', { kind: 'head' }, false));
      const entries = await unwrap(mock.opHistory(id));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.restored).toBe(false);
      for (let i = 0; i < 105; i++) {
        await unwrap(mock.createBranch(id, `bulk-${String(i)}`, { kind: 'head' }, false));
      }
      const all = await unwrap(mock.opHistory(id));
      expect(all).toHaveLength(100);
      expect(all[0]?.op).toMatchObject({ kind: 'createBranch' });
    });

    it('lists an entry another version saved as `unreadable` and refuses its undo', async () => {
      const id = await journaled();
      mockBackend.simulateRestoredJournal(id, { unreadable: true });
      expect((await unwrap(mock.opHistory(id)))[0]?.blocked).toEqual({ kind: 'unreadable' });
      expect((await unwrap(mock.undoState(id))).undo?.blocked).toEqual({ kind: 'unreadable' });
      expect(await mock.undo(id)).toMatchObject({
        error: { code: 'undoBlocked', payload: { reason: { kind: 'unreadable' } } },
      });
      // A new operation is journaled normally behind it.
      await unwrap(mock.createBranch(id, 'after', { kind: 'head' }, false));
      expect((await unwrap(mock.undoState(id))).undo?.blocked).toBeNull();
    });
  });

  it('a folder of another user opens once it is in `safe.directory` (`check_safe_directory`)', async () => {
    const path = '/Users/alex/unsafe-owner';
    const refused = await mock.openRepo(path);
    expect(refused).toMatchObject({
      status: 'error',
      error: { code: 'unsafeRepository', action: { kind: 'addSafeDirectory', path } },
    });
    await unwrap(mock.addSafeDirectory(path));
    expect(await unwrap(mock.openRepo(path))).toMatchObject({ path });
  });

  it('a force push refuses a remote branch that moved since the fetch (`stale_lease`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const push = {
      remote: null,
      branch: null,
      setUpstream: false,
      forceWithLease: true,
      expectedSha: null,
    };
    mockBackend.simulateStaleLease(id);
    expect(await mock.push(id, push)).toMatchObject({ error: { code: 'staleLease' } });
    // One refusal per simulated move: the next force push goes through.
    await unwrap(mock.push(id, push));
  });

  it('a refused fixup reports `op-finished` failed (`fixup.rs`, checks in the queue)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const outcomes: string[] = [];
    const off = mockClient.events.subscribe('opFinished', (e) => outcomes.push(e.outcome.kind));
    expect(await mock.commitFixup(id, 'no-such-rev')).toMatchObject({
      error: { code: 'revisionNotFound' },
    });
    off();
    expect(outcomes).toEqual(['failed']);
  });

  it('a bisect mark in the wrong order is not recorded (`bisect.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    await unwrap(mock.bisectMark(id, 'HEAD~3', 'bad'));
    // HEAD descends from the bad commit: good after bad.
    expect(await mock.bisectMark(id, 'HEAD', 'good')).toMatchObject({
      error: { code: 'bisectWrongOrder' },
    });
    expect((await unwrap(mock.bisectState(id)))?.good).toEqual([]);
    expect((await unwrap(mock.operationDetail(id)))?.canSkip).toBe(true);
  });

  it('a bisect checkout in the way keeps the mark, `bisectNext` recovers', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const page = await unwrap(mock.graphPage(id, 0, 40));
    await unwrap(mock.bisectMark(id, null, 'bad'));
    mockBackend.simulateBisectCheckoutFailure(id);
    const failed = await mock.bisectMark(id, page.shas[page.shas.length - 1] ?? '', 'good');
    expect(failed).toMatchObject({
      error: { code: 'bisectCheckoutFailed', payload: { kind: 'dirtyWorktree' } },
    });
    const waiting = await unwrap(mock.bisectState(id));
    expect(waiting).toMatchObject({
      awaitingCheckout: true,
      good: [page.shas[page.shas.length - 1]],
    });
    const next = await unwrap(mock.bisectNext(id));
    expect(next.awaitingCheckout).toBe(false);
    expect(next.current?.sha).not.toBe(page.shas[0]);
  });

  it('a bisect started before a restart is found again with its marks (`bisect.rs`)', async () => {
    const path = '/Users/alex/dev/blog';
    const { id } = await unwrap(mock.openRepo(path));
    const page = await unwrap(mock.graphPage(id, 0, 40));
    const [bad = '', good = ''] = [page.shas[0], page.shas[page.shas.length - 1]];
    mockBackend.simulateOperation(id, 'bisect', { marks: { bad, good: [good] } });
    await unwrap(mock.closeRepo(id));
    const again = await unwrap(mock.openRepo(path));
    const reopened = await unwrap(mock.repoState(again.id));
    expect(reopened.operation).toEqual({ kind: 'bisect' });
    expect(reopened.head.kind).toBe('detached');
    const state = await unwrap(mock.bisectState(again.id));
    expect(state).toMatchObject({ bad, good: [good], original: 'main', awaitingCheckout: false });
    expect(state?.remaining).toBeGreaterThan(0);
    expect(state?.current?.sha).not.toBe(bad);
  });

  it('a line history read can be cancelled, even before it starts (`line_history.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const request = { path: 'README.md', rev: 'HEAD', start: 1, end: 3 };
    mockBackend.simulateSlowReads(10_000);
    const running = mock.lineHistory(id, request, null, 100, 7);
    await unwrap(mock.cancelRead(7));
    expect(await running).toMatchObject({ error: { code: 'cancelled' } });
    mockBackend.simulateSlowReads(0);
    await unwrap(mock.cancelRead(8));
    expect(await mock.lineHistory(id, request, null, 100, 8)).toMatchObject({
      error: { code: 'cancelled' },
    });
    await unwrap(mock.lineHistory(id, request, null, 100, 9));
  });

  it('the lines of a file not committed yet have no history (`line_history.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const files = (await unwrap(mock.changedFiles(id, { kind: 'unstaged' }))).files;
    const path = files.find((f) => f.status === 'untracked')?.path ?? '';
    const result = await mock.lineHistory(id, { path, rev: null, start: 1, end: 1 }, null, 100, 1);
    expect(result).toMatchObject({
      error: {
        code: 'invalidArgument',
        message: { en: `"${path}" is not committed yet: its lines have no history.` },
      },
    });
  });
});

/**
 * Where M8-3 found the mock and the backend apart. The reference is the backend
 * (`src-tauri/src/git/read/line_history.rs`, `repo/inspect.rs`, `store`, `op_journal`).
 */
describe('mock / backend parity (M8-3)', () => {
  it('line history maps working tree lines to HEAD (`committed_range`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    // `README.md` is modified in the fixture: HEAD and the working tree differ.
    const path = 'README.md';
    const blame = await unwrap(mock.blame(id, { path, rev: null }, 1));
    if (blame.content.kind !== 'text') throw new Error(blame.content.kind);
    const lines = blame.content.lines;
    const request = { path, rev: null, start: 2, end: 3 };
    const before = (await unwrap(mock.lineHistory(id, request, null, 500, 1))).range;

    // Three lines added above the range: the same HEAD lines, three further down.
    mockBackend.simulateEdit(id, path, `${['a', 'b', 'c', ...lines].join('\n')}\n`);
    const shifted = await unwrap(
      mock.lineHistory(id, { ...request, start: 5, end: 6 }, null, 500, 1),
    );
    expect(shifted.range).toMatchObject({ start: before.start, end: before.end });
    // Only added lines: no history.
    expect(
      await mock.lineHistory(id, { ...request, start: 1, end: 3 }, null, 500, 1),
    ).toMatchObject({
      error: {
        code: 'invalidArgument',
        message: { en: 'These lines are not committed yet: they have no history.' },
      },
    });
    const first = await unwrap(mock.lineHistory(id, { ...request, start: 5, end: 6 }, null, 1, 1));
    expect(first.next?.range).toMatchObject({ start: before.start, end: before.end });
  });

  it('mapToHead stands for the backend `map_to_head`', () => {
    const head = 'a\nb\nc\nd\ne\n';
    // Two lines inserted after `b`, `d` changed.
    const work = 'a\nb\nx\ny\nc\nD\ne\n';
    expect(mapToHead(head, work, 1, 2)).toEqual([1, 2]);
    expect(mapToHead(head, work, 5, 5)).toEqual([3, 3]);
    expect(mapToHead(head, work, 6, 7)).toEqual([4, 5]);
    expect(mapToHead(head, work, 3, 4)).toBeNull();
    // A range from added lines to unchanged ones starts at the first line after them.
    expect(mapToHead(head, work, 3, 5)).toEqual([3, 3]);
  });

  it('line history follows the range between commits (`git log -L`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const request = { path: 'src/app/Thing.ts', rev: null, start: 20, end: 24 };
    const { entries } = await unwrap(mock.lineHistory(id, request, null, 500, 1));
    const diffs = entries.flatMap((e) => (e.diff && !e.origin ? [e.diff.hunks[0]] : []));
    // Each commit's range after is the range before of the newer one.
    for (let i = 1; i < diffs.length; i++) {
      expect(diffs[i]?.newStart).toBe(diffs[i - 1]?.oldStart);
    }
    expect(new Set(diffs.map((h) => h?.newStart)).size).toBeGreaterThan(1);
    const origin = entries.at(-1);
    expect(origin?.diff?.hunks[0]?.newStart).toBe(diffs.at(-1)?.oldStart);
  });
});

describe('mock / backend parity (M8)', () => {
  it('a conflicting stash file ends `op-finished` failed, its undo journaled (`stash_file.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const [path = ''] = (await unwrap(mock.changedFiles(id, { kind: 'unstaged' }))).files
      .filter((f) => f.status !== 'untracked')
      .map((f) => f.path);
    const pushed = await unwrap(
      mock.stashPush(id, { message: 'conflict demo', includeUntracked: false, keepIndex: false }),
    );
    const events: string[] = [];
    const offFinished = mockClient.events.subscribe('opFinished', (e) =>
      events.push(e.outcome.kind === 'failed' ? `failed:${e.outcome.error.code}` : e.outcome.kind),
    );
    const offJournal = mockClient.events.subscribe('journalChanged', () => events.push('journal'));
    const stash = { index: 0, sha: pushed.sha };
    expect(await mock.stashApplyFile(id, { stash, path, untracked: false })).toMatchObject({
      error: { code: 'stashConflict' },
    });
    offFinished();
    offJournal();
    expect(events).toEqual(['failed:stashConflict', 'journal']);
    expect((await unwrap(mock.undoState(id))).undo?.entry.op).toMatchObject({
      kind: 'stashApplyFile',
      path,
    });
  });

  it('`skipOperation` in a bisect ends inconclusive like a skip mark (`bisect.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    await unwrap(mock.bisectMark(id, null, 'bad'));
    let state = await unwrap(mock.bisectMark(id, 'HEAD~3', 'good'));
    const notes: (string | null)[] = [];
    const off = mockClient.events.subscribe('opFinished', (e) =>
      notes.push(e.outcome.kind === 'success' ? e.outcome.note : e.outcome.kind),
    );
    let skips = 0;
    while (!state.result && skips < 5) {
      await unwrap(mock.skipOperation(id));
      const read = await unwrap(mock.bisectState(id));
      if (!read) break;
      state = read;
      skips += 1;
    }
    off();
    expect(state.result?.kind).toBe('inconclusive');
    expect(notes.at(-1)).toBeNull();
    expect(notes.slice(0, -1).every((n) => n === 'step')).toBe(true);
    expect((await unwrap(mock.repoState(id))).operation).toEqual({ kind: 'bisect' });
  });
});
