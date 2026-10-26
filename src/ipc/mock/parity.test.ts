import { beforeEach, describe, expect, it } from 'vitest';

import type { RebaseAction } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
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

/** M8-2: the product gaps of M7-10 (autosquash of `squash!` / `amend!`, first-parent bisect). */
describe('mock / backend parity (M8-2)', () => {
  it('arranges squash! and amend! commits like `fixup.rs` (`tests/fixup.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    await unwrap(mock.stashPush(id, { message: null, includeUntracked: true, keepIndex: false }));
    const before = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~2'));
    const target = before.commits[0]?.summary ?? '';
    mockBackend.simulateCommit(id, `squash! ${target}`, 'squash body');
    mockBackend.simulateCommit(id, `amend! ${target}`, 'Reworded\n\nnew body');
    const plan = await unwrap(mock.autosquashPlan(id, null));
    if (!plan) throw new Error('no plan');
    const actions = plan.todo.map((entry) => {
      const commit = plan.plan.commits.find((c) => c.sha === entry.sha);
      return [commit?.summary, entry.action, entry.message];
    });
    expect(actions).toEqual([
      [target, 'pick', null],
      [`squash! ${target}`, 'squash', null],
      // `fixup -C`: the message below the `amend!` subject.
      [`amend! ${target}`, 'fixup', 'Reworded\n\nnew body'],
      [before.commits[1]?.summary, 'pick', null],
    ]);
    expect(plan.fixups).toBe(2);
    // The todo runs: one commit with the group's message (the view's, sent on the amend!).
    const message = `${target}\n\nsquash body\n\nReworded\n\nnew body`;
    const todo = plan.todo.map((entry, i) => (i === 2 ? { ...entry, message } : entry));
    await unwrap(mock.interactiveRebase(id, plan.plan.base.sha, todo));
    const after = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~2'));
    expect(after.commits.map((c) => c.message)).toEqual([message, before.commits[1]?.message]);
  });

  it('a bisect started in first-parent mode only tests first parents (`tests/bisect.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    // A bisect needs a clean tree; `yaggui` has merges in its last commits.
    await unwrap(mock.stashPush(id, { message: null, includeUntracked: false, keepIndex: false }));
    const filter = await unwrap(mock.graphFilter(id));
    const all = await unwrap(mock.graphPage(id, 0, 60));
    const good = all.shas[all.shas.length - 1] ?? '';

    await unwrap(mock.bisectMark(id, null, 'bad'));
    const full = await unwrap(mock.bisectMark(id, good, 'good'));
    expect(full.firstParent).toBe(false);
    await unwrap(mock.abortOperation(id));

    await unwrap(mock.setGraphFilter(id, { ...filter, firstParent: true }));
    await unwrap(mock.bisectMark(id, null, 'bad'));
    const chain = await unwrap(mock.bisectMark(id, good, 'good'));
    expect(chain.firstParent).toBe(true);
    // Fewer commits left, the steps counted on them, the commit under test a graph row.
    expect(chain.remaining).toBeLessThan(full.remaining ?? 0);
    expect(chain.steps).toBeLessThanOrEqual(full.steps ?? 0);
    const rows = await unwrap(mock.graphPage(id, 0, 500));
    expect(rows.shas).toContain(chain.current?.sha);
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
