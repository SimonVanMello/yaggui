import type { YagguiError, JournalEntry, JournalOp, UndoBlock, UndoStep } from '../bindings';

import type { MockCommit, MockHistory } from '../mockGraph';
import type { MockWip } from './wip';

/** Errors of the undo commands, with the messages of `git/errors.rs`. */
function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

export function nothingToUndo(): YagguiError {
  return mockError(
    'nothingToUndo',
    'Nothing to undo in this session.',
    'Rien à annuler dans cette session.',
  );
}

export function nothingToRedo(): YagguiError {
  return mockError('nothingToRedo', 'Nothing to redo.', 'Rien à rétablir.');
}

export function undoDiverged(refs: string[], paths: string[]): YagguiError {
  return {
    ...mockError(
      'undoDiverged',
      'The repository changed since this operation (branches or files modified elsewhere): undoing it would lose that change.',
      "Le dépôt a changé depuis cette opération (branches ou fichiers modifiés ailleurs) : l'annuler perdrait ce changement.",
    ),
    action: { kind: 'refresh' },
    payload: { kind: 'undoChanges', refs, paths },
  };
}

export function undoWouldOverwrite(paths: string[]): YagguiError {
  return {
    ...mockError(
      'undoWouldOverwrite',
      'Your local changes would be overwritten. Commit or stash them first.',
      "Tes modifications locales seraient écrasées. Commite-les ou mets-les de côté (stash) d'abord.",
    ),
    payload: { kind: 'undoChanges', refs: [], paths },
  };
}

export function undoObjectsMissing(count: number): YagguiError {
  return {
    ...mockError(
      'undoObjectsMissing',
      'Git deleted what this undo needs (old commits or saved file contents, removed by a garbage collection since): it can no longer be undone. Nothing was changed; redo the change by hand if you still need it.',
      "Git a supprimé ce dont cette annulation a besoin (anciens commits ou contenus de fichiers sauvegardés, effacés par un nettoyage depuis) : elle ne peut plus être annulée. Rien n'a été modifié ; refais le changement à la main si tu en as encore besoin.",
    ),
    payload: { kind: 'undoBlocked', reason: { kind: 'objectsMissing', count } },
  };
}

export function undoBlocked(reason: UndoBlock): YagguiError {
  const texts: Record<
    Exclude<UndoBlock['kind'], 'diverged' | 'objectsMissing'>,
    [string, string]
  > = {
    published: [
      'This operation changed a remote: it cannot be undone locally.',
      'Cette opération a modifié un remote : elle ne peut pas être annulée localement.',
    ],
    pruned: [
      'A fetch with prune cannot be undone: the deleted remote-tracking branches come back with the next fetch if they still exist.',
      'Un fetch avec prune ne peut pas être annulé : les branches distantes supprimées reviennent au prochain fetch si elles existent encore.',
    ],
    pulled: [
      'A pull cannot be undone: what it fetched stays. Reset the branch instead if needed.',
      "Un pull ne peut pas être annulé : ce qu'il a récupéré reste. Fais plutôt un reset de la branche si besoin.",
    ],
    notRecorded: [
      'The state before this operation could not be recorded: it cannot be undone.',
      "L'état d'avant cette opération n'a pas pu être enregistré : elle ne peut pas être annulée.",
    ],
    downloaded: [
      'This operation downloaded and checked out content (LFS files, submodule commits): it cannot be undone.',
      'Cette opération a téléchargé et extrait du contenu (fichiers LFS, commits de submodules) : elle ne peut pas être annulée.',
    ],
    filesDeleted: [
      'The worktree was removed with its local changes: they cannot be brought back.',
      'Le worktree a été supprimé avec ses modifications locales : elles ne peuvent pas être restaurées.',
    ],
    unreadable: [
      'This operation was recorded by another version of yaggui and cannot be read: it cannot be undone. Use the reflog to find the earlier state if you need it.',
      "Cette opération a été enregistrée par une autre version de yaggui et ne peut pas être lue : elle ne peut pas être annulée. Passe par le reflog pour retrouver l'état d'avant si besoin.",
    ],
  };
  if (reason.kind === 'diverged') return undoDiverged(reason.refs, []);
  if (reason.kind === 'objectsMissing') return undoObjectsMissing(reason.count);
  const [en, fr] = texts[reason.kind];
  return { ...mockError('undoBlocked', en, fr), payload: { kind: 'undoBlocked', reason } };
}

/** Operations kept per repository, like the backend journal (`JOURNAL_MAX_ENTRIES`). */
export const MOCK_JOURNAL_MAX = 100;

/** The local refs of a mock history by full name (`HEAD`: its branch or commit), to compare. */
export function mockRefs(history: MockHistory): Map<string, string> {
  const sha = (commit: number) => history.commits[commit]?.sha ?? '';
  const refs = new Map<string, string>();
  for (const b of history.local) refs.set(`refs/heads/${b.name}`, sha(b.commit));
  for (const t of history.tags) refs.set(`refs/tags/${t.name}`, sha(t.commit));
  // Remotes by name (M4-7c): an undo of a remote operation checks and restores them.
  for (const r of history.remotes) refs.set(`remote:${r.name}`, `${r.url} ${r.pushUrl ?? ''}`);
  const { head } = history;
  refs.set('HEAD', head.kind === 'detached' ? sha(head.commit) : `ref: refs/heads/${head.name}`);
  return refs;
}

/** Full names of the refs that differ between two `mockRefs`, sorted. */
export function changedRefs(a: Map<string, string>, b: Map<string, string>): string[] {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((name) => a.get(name) !== b.get(name)).sort();
}

/** Refs an undo or redo from `from` to `to` changes that no longer are as in `from`. */
export function movedRefs(
  current: Map<string, string>,
  from: Map<string, string>,
  to: Map<string, string>,
): string[] {
  return changedRefs(from, to).filter((name) => current.get(name) !== from.get(name));
}

/** What an undo or redo puts back: refs, the HEAD commit as it was (amend), and the files. */
export interface MockSnapshot {
  refs: Pick<
    MockHistory,
    'local' | 'tags' | 'stashes' | 'head' | 'remote' | 'remotes' | 'worktrees'
  >;
  /** LFS patterns (`lfs track` changes `.gitattributes`). */
  lfsPatterns: string[];
  /** The HEAD commit, copied: an amend rewrites it in place in the mock history. */
  headCommit: { index: number; commit: MockCommit } | null;
  wip: MockWip | null;
  /** `mockRefs` at the time of the snapshot. */
  refMap: Map<string, string>;
}

export interface MockJournalRecord {
  entry: JournalEntry;
  before: MockSnapshot;
  after: MockSnapshot;
  /** The undo restores the index and working tree too (discard, reset). */
  files: boolean;
  /** What the step needs was pruned (`mockPruneJournal`): refused with `undoObjectsMissing`. */
  missing: boolean;
}

/** How an operation is journaled. */
export interface MockJournalSpec {
  op: JournalOp;
  blocked?: UndoBlock;
  files?: boolean;
}

/**
 * Journal of one mock repository; same model as `OpJournal`. Like the backend's, saved in
 * `yaggui.db`, it outlives the session: `restore` flags the entries as from a previous one.
 */
export class MockJournal {
  private records: MockJournalRecord[] = [];
  /** Undone records that can be redone, latest last; cleared by a new operation. */
  private redoable: MockJournalRecord[] = [];
  private nextId = 1;

  push(spec: MockJournalSpec, before: MockSnapshot, after: MockSnapshot, at: number): void {
    this.records.push({
      entry: {
        id: this.nextId++,
        op: spec.op,
        at,
        undone: false,
        blocked: spec.blocked ?? null,
        restored: false,
      },
      before,
      after,
      files: spec.files ?? false,
      missing: false,
    });
    if (this.records.length > MOCK_JOURNAL_MAX) this.records.shift();
    this.redoable = [];
  }

  /** Latest record not undone. */
  undoTarget(): MockJournalRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record && !record.entry.undone) return record;
    }
    return null;
  }

  redoTarget(): MockJournalRecord | null {
    return this.redoable.at(-1) ?? null;
  }

  markUndone(record: MockJournalRecord): void {
    record.entry.undone = true;
    this.redoable.push(record);
  }

  markRedone(record: MockJournalRecord): void {
    record.entry.undone = false;
    this.redoable.pop();
  }

  /** The repository was closed: its entries come back as from a previous session. */
  restore(): void {
    for (const record of this.records) record.entry.restored = true;
  }

  /**
   * Simulates `git gc` pruning what the restored entries need (their saved file contents),
   * so they are refused with `undoObjectsMissing`.
   */
  prune(): void {
    for (const record of this.records) {
      if (record.entry.restored && !record.entry.blocked) record.missing = true;
    }
  }

  /** Why the record cannot be undone or redone before the refs are even looked at. */
  static block(record: MockJournalRecord): UndoBlock | null {
    return record.entry.blocked ?? (record.missing ? { kind: 'objectsMissing', count: 1 } : null);
  }

  history(): JournalEntry[] {
    return this.records.map((r) => ({ ...r.entry, blocked: MockJournal.block(r) })).reverse();
  }

  step(record: MockJournalRecord | null, current: Map<string, string>): UndoStep | null {
    if (!record) return null;
    const [from, to] = record.entry.undone
      ? [record.before, record.after]
      : [record.after, record.before];
    const moved = movedRefs(current, from.refMap, to.refMap);
    return {
      entry: { ...record.entry },
      blocked:
        MockJournal.block(record) ?? (moved.length > 0 ? { kind: 'diverged', refs: moved } : null),
    };
  }
}
