import type {
  DiffOptions,
  DirtyState,
  FileMode,
  LineEnding,
  YagguiError,
  HunkChange,
  PathSelection,
  TextEncoding,
} from '../bindings';
import { genericWip, yagguiWip, type MockFileChange } from './diffData';
import { textDiff } from './lineDiff';
import { stashFileInTheWay } from './refs';

/** One version of a path in HEAD, the index or the working tree. */
interface MockSide {
  text: string | null;
  mode: FileMode;
  binarySize?: number | null;
  tooLargeSize?: number | null;
  submodule?: string | null;
  encoding?: TextEncoding;
}

interface IndexSide extends MockSide {
  /** Unmerged path: listed as conflicted in the unstaged list, never as staged. */
  conflicted?: boolean;
}

type Result<T> = { ok: T } | { error: YagguiError };

function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

/** Same messages as `YagguiError::stale_diff`. */
export function staleDiff(path: string): YagguiError {
  return {
    ...mockError(
      'staleDiff',
      `${path} changed since its diff was shown. Refresh and select again.`,
      `${path} a changé depuis l'affichage de son diff. Rafraîchis puis refais la sélection.`,
    ),
    action: { kind: 'refresh' },
  };
}

/** Same messages as `YagguiError::file_changed`. */
export function fileChanged(path: string): YagguiError {
  return mockError(
    'fileChanged',
    `${path} changed on disk since it was opened.`,
    `${path} a changé sur le disque depuis son ouverture.`,
  );
}

function notEditable(path: string, en: string, fr: string): YagguiError {
  return mockError(
    'invalidArgument',
    `"${path}" cannot be edited here: ${en}.`,
    `« ${path} » ne peut pas être modifié ici : ${fr}.`,
  );
}

/** Line ending style of a whole text, as `text::line_ending` reports it. */
export function lineEndingOf(text: string): LineEnding {
  const breaks = text.match(/\r?\n/g) ?? [];
  if (breaks.length === 0) return 'none';
  const crlf = breaks.filter((b) => b === '\r\n').length;
  return crlf === 0 ? 'lf' : crlf === breaks.length ? 'crlf' : 'mixed';
}

export function unresolvedConflicts(): YagguiError {
  return mockError(
    'unresolvedConflicts',
    'Some files are still in conflict: resolve them (and stage them) first.',
    'Des fichiers sont encore en conflit : résous-les (et stage-les) d’abord.',
  );
}

/** Deterministic fake blob id, so the UI can show and compare them. */
export function blobId(text: string | null): string | null {
  if (text === null) return null;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(5);
}

function sideOf(change: MockFileChange, which: 'old' | 'new'): MockSide {
  const old = which === 'old';
  const side: MockSide = {
    text: old ? change.old : change.new,
    mode: (old ? change.oldMode : change.newMode) ?? 'regular',
  };
  if (change.binary) side.binarySize = old ? change.binary.oldSize : change.binary.newSize;
  if (change.tooLarge) side.tooLargeSize = old ? change.tooLarge.oldSize : change.tooLarge.newSize;
  if (change.submodule) {
    side.submodule = old ? change.submodule.oldCommit : change.submodule.newCommit;
  }
  const encoding = old ? change.oldEncoding : change.newEncoding;
  if (encoding) side.encoding = encoding;
  return side;
}

function same(a: MockSide, b: MockSide): boolean {
  const strip = ({ text, mode, binarySize, tooLargeSize, submodule, encoding }: MockSide) =>
    JSON.stringify([text, mode, binarySize, tooLargeSize, submodule, encoding]);
  return strip(a) === strip(b);
}

/** A copy without the index-only conflict flag. */
function clone(side: MockSide): MockSide {
  const copy: IndexSide = { ...side };
  delete copy.conflicted;
  return copy;
}

/** Lines of a text, each keeping its `\n`. */
function splitKeep(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Joins lines, adding the newline a kept last line lacks when others follow it. */
function join(lines: string[]): string {
  return lines
    .map((line, i) => (i < lines.length - 1 && !line.endsWith('\n') ? `${line}\n` : line))
    .join('');
}

type Picked = (hunk: number, line: number) => boolean;

/**
 * Line indexes of a hunk with each block of removals followed by additions interleaved
 * pairwise (`-a +A -b +B`), as the backend builds its patches: a line picked alone from a
 * block of replaced lines stays in place.
 */
function pairedOrder(kinds: string): number[] {
  const order: number[] = [];
  let i = 0;
  while (i < kinds.length) {
    if (kinds.charAt(i) === ' ') {
      order.push(i++);
      continue;
    }
    let removedEnd = i;
    while (kinds.charAt(removedEnd) === '-') removedEnd++;
    let addedEnd = removedEnd;
    while (kinds.charAt(addedEnd) === '+') addedEnd++;
    const removed = removedEnd - i;
    const added = addedEnd - removedEnd;
    for (let k = 0; k < Math.max(removed, added); k++) {
      if (k < removed) order.push(i + k);
      if (k < added) order.push(removedEnd + k);
    }
    i = addedEnd;
  }
  return order;
}

/** `old` plus the selected changes (staging). */
function applyForward(oldText: string, newText: string, options: DiffOptions, picked: Picked) {
  const oldLines = splitKeep(oldText);
  const newLines = splitKeep(newText);
  const out: string[] = [];
  let oi = 0;
  textDiff(oldText, newText, options).hunks.forEach((hunk, h) => {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    out.push(...oldLines.slice(oi, start));
    oi = start;
    let ni = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    for (const k of pairedOrder(hunk.kinds)) {
      const kind = hunk.kinds.charAt(k);
      if (kind === ' ') {
        out.push(oldLines[oi++] ?? '');
        ni++;
      } else if (kind === '-') {
        if (!picked(h, k)) out.push(oldLines[oi] ?? '');
        oi++;
      } else {
        if (picked(h, k)) out.push(newLines[ni] ?? '');
        ni++;
      }
    }
  });
  out.push(...oldLines.slice(oi));
  return join(out);
}

/** `new` without the selected changes (unstaging, discarding). */
function applyReverse(oldText: string, newText: string, options: DiffOptions, picked: Picked) {
  const oldLines = splitKeep(oldText);
  const newLines = splitKeep(newText);
  const out: string[] = [];
  let ni = 0;
  textDiff(oldText, newText, options).hunks.forEach((hunk, h) => {
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    out.push(...newLines.slice(ni, start));
    ni = start;
    let oi = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    for (const k of pairedOrder(hunk.kinds)) {
      const kind = hunk.kinds.charAt(k);
      if (kind === ' ') {
        out.push(newLines[ni++] ?? '');
        oi++;
      } else if (kind === '+') {
        if (!picked(h, k)) out.push(newLines[ni] ?? '');
        ni++;
      } else {
        if (picked(h, k)) out.push(oldLines[oi] ?? '');
        oi++;
      }
    }
  });
  out.push(...newLines.slice(ni));
  return join(out);
}

export type WipList = 'staged' | 'unstaged';

/** Index and working tree saved by a mock stash. */
export interface MockStashState {
  index: Map<string, MockSide & { conflicted?: boolean }>;
  worktree: Map<string, MockSide>;
}

/**
 * HEAD, index and working tree of a mock repository: the staged and unstaged lists are
 * derived from them, so staging and discarding behave like Git.
 */
export class MockWip {
  private head = new Map<string, MockSide>();
  private index = new Map<string, IndexSide>();
  private worktree = new Map<string, MockSide>();
  /** Untracked files hidden by a rule added with `addToGitignore`. */
  private ignored = new Set<string>();
  private backups = 0;

  static fromFixture(repoName: string, dirty: DirtyState): MockWip {
    const changes = repoName === 'yaggui' ? yagguiWip() : genericWip(dirty);
    return MockWip.fromChanges(changes.staged, changes.unstaged);
  }

  static fromChanges(staged: MockFileChange[], unstaged: MockFileChange[]): MockWip {
    const wip = new MockWip();
    const deleted = new Set<string>();
    for (const c of staged) {
      if (c.status !== 'added') wip.head.set(c.oldPath ?? c.path, sideOf(c, 'old'));
      if (c.status !== 'deleted') wip.index.set(c.path, sideOf(c, 'new'));
    }
    for (const c of unstaged) {
      if (c.status === 'untracked') {
        wip.worktree.set(c.path, sideOf(c, 'new'));
        continue;
      }
      if (c.status === 'conflicted') {
        const ours: MockSide = { text: `int value = 1;\n`, mode: 'regular' };
        if (!wip.head.has(c.path)) wip.head.set(c.path, ours);
        wip.index.set(c.path, { ...ours, conflicted: true });
        wip.worktree.set(c.path, {
          text: '<<<<<<< HEAD\nint value = 1;\n=======\nint value = 2;\n>>>>>>> feature\n',
          mode: 'regular',
        });
        continue;
      }
      const base = sideOf(c, 'old');
      if (!wip.index.has(c.path)) wip.index.set(c.path, base);
      if (!wip.head.has(c.path)) wip.head.set(c.path, clone(base));
      if (c.status === 'deleted') deleted.add(c.path);
      else wip.worktree.set(c.path, sideOf(c, 'new'));
    }
    for (const [path, side] of wip.index) {
      if (!wip.worktree.has(path) && !deleted.has(path)) wip.worktree.set(path, clone(side));
    }
    return wip;
  }

  /** Changed paths of one list, sorted by path. */
  changes(list: WipList): MockFileChange[] {
    const [from, to] =
      list === 'staged'
        ? [this.head, this.index as Map<string, MockSide>]
        : [this.index as Map<string, MockSide>, this.worktree];
    const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
    const out: MockFileChange[] = [];
    for (const path of paths) {
      const conflicted = this.index.get(path)?.conflicted === true;
      if (conflicted) {
        if (list === 'unstaged') {
          out.push({
            path,
            status: 'conflicted',
            oldMode: null,
            newMode: null,
            old: null,
            new: null,
          });
        }
        continue;
      }
      const a = from.get(path);
      const b = to.get(path);
      if (a && b && same(a, b)) continue;
      if (!a && list === 'unstaged' && this.ignored.has(path)) continue;
      const change: MockFileChange = {
        path,
        status: !a ? (list === 'staged' ? 'added' : 'untracked') : !b ? 'deleted' : 'modified',
        oldMode: a?.mode ?? null,
        newMode: b?.mode ?? null,
        old: a?.text ?? null,
        new: b?.text ?? null,
      };
      if (a?.binarySize !== undefined || b?.binarySize !== undefined) {
        change.binary = { oldSize: a?.binarySize ?? null, newSize: b?.binarySize ?? null };
      }
      if (a?.tooLargeSize !== undefined || b?.tooLargeSize !== undefined) {
        change.tooLarge = { oldSize: a?.tooLargeSize ?? null, newSize: b?.tooLargeSize ?? null };
      }
      if (a?.submodule !== undefined || b?.submodule !== undefined) {
        change.submodule = { oldCommit: a?.submodule ?? null, newCommit: b?.submodule ?? null };
      }
      if (a?.encoding) change.oldEncoding = a.encoding;
      if (b?.encoding) change.newEncoding = b.encoding;
      out.push(change);
    }
    return out;
  }

  dirty(): DirtyState {
    const unstaged = this.changes('unstaged');
    return {
      staged: this.changes('staged').length,
      unstaged: unstaged.filter((c) => c.status !== 'untracked' && c.status !== 'conflicted')
        .length,
      untracked: unstaged.filter((c) => c.status === 'untracked').length,
      conflicted: unstaged.filter((c) => c.status === 'conflicted').length,
    };
  }

  hasConflicts(): boolean {
    return [...this.index.values()].some((side) => side.conflicted === true);
  }

  private selected(list: WipList, selection: PathSelection): string[] {
    const listed = this.changes(list).map((c) => c.path);
    if (selection.kind === 'all') return listed;
    return selection.paths.filter((p) => listed.includes(p));
  }

  stagePaths(selection: PathSelection): string[] {
    const paths = this.selected('unstaged', selection);
    for (const path of paths) {
      const side = this.worktree.get(path);
      if (side) this.index.set(path, clone(side));
      else this.index.delete(path);
    }
    return paths;
  }

  unstagePaths(selection: PathSelection): string[] {
    const paths = this.selected('staged', selection);
    for (const path of paths) {
      const side = this.head.get(path);
      if (side) this.index.set(path, clone(side));
      else this.index.delete(path);
    }
    return paths;
  }

  discardPaths(selection: PathSelection, includeStaged: boolean): Result<string> {
    const paths = new Set(this.selected('unstaged', selection));
    if (includeStaged) this.selected('staged', selection).forEach((p) => paths.add(p));
    if ([...paths].some((p) => this.index.get(p)?.conflicted)) {
      return { error: unresolvedConflicts() };
    }
    for (const path of paths) {
      if (includeStaged) {
        const head = this.head.get(path);
        if (head) this.index.set(path, clone(head));
        else this.index.delete(path);
      }
      const side = this.index.get(path);
      if (side) this.worktree.set(path, clone(side));
      else this.worktree.delete(path);
    }
    return { ok: this.nextBackup() };
  }

  /** Stages (`stage`), unstages or discards hunks and lines of one file diff. */
  applyHunks(op: 'stage' | 'unstage' | 'discard', change: HunkChange): Result<null> {
    const [fromMap, toMap] =
      op === 'unstage'
        ? [this.head, this.index as Map<string, MockSide>]
        : [this.index as Map<string, MockSide>, this.worktree];
    const { path } = change;
    if (change.options.ignoreWhitespace) {
      return {
        error: mockError(
          'invalidArgument',
          'Hunks of a diff that ignores whitespace cannot be staged or discarded.',
          'Les hunks d’un diff qui ignore les espaces ne peuvent pas être stagés ni annulés.',
        ),
      };
    }
    if (this.index.get(path)?.conflicted) return { error: unresolvedConflicts() };
    const from = fromMap.get(change.oldPath ?? path);
    const to = toMap.get(path);
    if (blobId(from?.text ?? null) !== change.oldId || blobId(to?.text ?? null) !== change.newId) {
      return { error: staleDiff(path) };
    }
    const oldText = from?.text ?? '';
    const newText = to?.text ?? '';
    const hunks = textDiff(oldText, newText, change.options).hunks;
    const picks = new Map<number, Set<number> | 'all'>();
    for (const selection of change.hunks) {
      const h = hunks.findIndex((hunk) => hunk.id === selection.id);
      if (h < 0) return { error: staleDiff(path) };
      picks.set(h, selection.lines === null ? 'all' : new Set(selection.lines));
    }
    const picked: Picked = (h, k) => {
      const pick = picks.get(h);
      return pick === 'all' || (pick?.has(k) ?? false);
    };
    if (op === 'stage') {
      const text = applyForward(oldText, newText, change.options, picked);
      const base = from ?? to;
      if (!to && text === '') this.index.delete(path);
      else if (base) this.index.set(path, { ...clone(base), text });
    } else {
      const text = applyReverse(oldText, newText, change.options, picked);
      const target = op === 'unstage' ? this.index : this.worktree;
      if (!from && text === '') target.delete(path);
      else if (to) target.set(path, { ...clone(to), text });
      else if (from) target.set(path, { ...clone(from), text });
    }
    return { ok: null };
  }

  /** Tracked paths with staged or unstaged changes (conflicts included). */
  trackedChanges(): string[] {
    const paths = new Set(this.changes('staged').map((c) => c.path));
    for (const c of this.changes('unstaged')) if (c.status !== 'untracked') paths.add(c.path);
    return [...paths].sort();
  }

  /**
   * `git stash push`: saves the index and working tree, then resets them to HEAD (the
   * index stays with `keepIndex`; untracked files stay unless `includeUntracked`).
   * `null` when there is nothing to stash.
   */
  stash(includeUntracked: boolean, keepIndex: boolean): MockStashState | null {
    const untracked = this.changes('unstaged')
      .filter((c) => c.status === 'untracked')
      .map((c) => c.path);
    if (this.trackedChanges().length === 0 && (!includeUntracked || untracked.length === 0)) {
      return null;
    }
    const saved: MockStashState = {
      index: new Map([...this.index].map(([path, side]) => [path, { ...side }])),
      worktree: new Map(
        [...this.worktree]
          .filter(([path]) => includeUntracked || !untracked.includes(path))
          .map(([path, side]) => [path, clone(side)]),
      ),
    };
    const base = keepIndex ? this.index : this.head;
    const kept = new Map(
      [...this.worktree].filter(([path]) => !includeUntracked && untracked.includes(path)),
    );
    this.index = new Map([...base].map(([path, side]) => [path, clone(side)]));
    this.worktree = new Map([...base].map(([path, side]) => [path, clone(side)]));
    for (const [path, side] of kept) this.worktree.set(path, side);
    return saved;
  }

  /**
   * `git stash push -- <paths>`: saves and resets only these files; untracked ones only with
   * `includeUntracked`. `null` when none of them has a change.
   */
  stashPaths(paths: string[], includeUntracked: boolean): MockStashState | null {
    const known = (path: string) => this.head.has(path) || this.index.has(path);
    const changed = new Set([
      ...this.changes('staged').map((c) => c.path),
      ...this.changes('unstaged').map((c) => c.path),
    ]);
    const picked = paths.filter((p) => changed.has(p) && (includeUntracked || known(p)));
    if (picked.length === 0) return null;
    const saved: MockStashState = { index: new Map(), worktree: new Map() };
    for (const path of picked) {
      const index = this.index.get(path);
      const worktree = this.worktree.get(path);
      if (index) saved.index.set(path, { ...index });
      if (worktree) saved.worktree.set(path, clone(worktree));
      const head = this.head.get(path);
      if (head) {
        this.index.set(path, clone(head));
        this.worktree.set(path, clone(head));
      } else {
        this.index.delete(path);
        this.worktree.delete(path);
      }
    }
    return saved;
  }

  /** Untracked files, sorted (`git ls-files --others --exclude-standard`). */
  untracked(): string[] {
    return this.changes('unstaged')
      .filter((c) => c.status === 'untracked')
      .map((c) => c.path);
  }

  worktreeFile(path: string): string | null {
    return this.worktree.get(path)?.text ?? null;
  }

  /** A working tree file the diff view can edit, as `worktree_file` checks it. */
  editableFile(path: string): Result<{ text: string; original: string | null }> {
    if (this.isConflicted(path)) return { error: unresolvedConflicts() };
    const side = this.worktree.get(path);
    if (!side || side.text === null) {
      return { error: notEditable(path, 'it was deleted', 'il a été supprimé') };
    }
    if (side.mode !== 'regular' && side.mode !== 'executable') {
      return {
        error: notEditable(path, 'it is not a regular file', 'ce n’est pas un fichier ordinaire'),
      };
    }
    if (side.binarySize !== undefined || side.text.includes('\0')) {
      return { error: notEditable(path, 'it is binary', 'il est binaire') };
    }
    if (side.tooLargeSize !== undefined) {
      return { error: notEditable(path, 'it is too large', 'il est trop gros') };
    }
    if (side.encoding === 'windows1252') {
      return { error: notEditable(path, 'it is not UTF-8 text', 'ce n’est pas du texte UTF-8') };
    }
    if (lineEndingOf(side.text) === 'mixed') {
      return {
        error: notEditable(
          path,
          'it mixes LF and CRLF line endings',
          'il mélange les fins de ligne LF et CRLF',
        ),
      };
    }
    return { ok: { text: side.text, original: this.index.get(path)?.text ?? null } };
  }

  /** Saves a file edited in the diff view, keeping its mode. */
  saveFile(path: string, text: string): void {
    this.worktree.set(path, { text, mode: this.worktree.get(path)?.mode ?? 'regular' });
  }

  /** Writes a text file in the working tree (`.gitignore`). */
  writeFile(path: string, text: string): void {
    this.worktree.set(path, { text, mode: 'regular' });
  }

  /** Hides untracked files, as a new `.gitignore` rule does. */
  ignore(paths: string[]): void {
    for (const path of paths) this.ignored.add(path);
  }

  /** Puts stashed changes back on top of the current files (`git stash apply`). */
  applyStash(saved: MockStashState): void {
    for (const [path, side] of saved.index) this.index.set(path, { ...side });
    for (const [path, side] of saved.worktree) this.worktree.set(path, clone(side));
  }

  /**
   * One file of a stash (`stash_apply_file`): `stashed` is its stashed content, `null` when
   * the stash deletes it, `undefined` when the mock does not know it (fixture stashes).
   * Refused over local changes or a file in the way; `conflict` leaves it conflicted.
   */
  applyStashFile(
    path: string,
    untracked: boolean,
    stashed: string | null | undefined,
    conflict: boolean,
  ): Result<'applied' | 'conflict'> {
    const current = this.worktree.get(path);
    const text = stashed ?? `${current?.text ?? ''}stashed change of ${path}\n`;
    if (untracked) {
      if (current) return { error: stashFileInTheWay(path, true) };
      this.worktree.set(path, { text, mode: 'regular' });
      return { ok: 'applied' };
    }
    const indexed = this.index.get(path);
    if (!indexed) {
      if (current) return { error: stashFileInTheWay(path, true) };
      // A file the stash adds stays staged, as with `git stash apply`.
      this.index.set(path, { text, mode: 'regular' });
    } else if (indexed.conflicted || indexed.text !== (current?.text ?? null)) {
      return { error: stashFileInTheWay(path, false) };
    }
    if (conflict) {
      this.markConflicted([path]);
      return { ok: 'conflict' };
    }
    if (stashed === null && indexed) {
      // Deleted in the stash: deleted here too, the deletion left unstaged.
      this.worktree.delete(path);
      return { ok: 'applied' };
    }
    this.worktree.set(path, { text, mode: current?.mode ?? 'regular' });
    return { ok: 'applied' };
  }

  /** Leaves `paths` in conflict, as a stash apply that conflicted does. */
  markConflicted(paths: string[]): void {
    for (const path of paths) {
      const ours = this.head.get(path) ?? { text: '', mode: 'regular' as const };
      this.index.set(path, { ...ours, conflicted: true });
      this.worktree.set(path, {
        text: `<<<<<<< Updated upstream\n${ours.text ?? ''}=======\n(stashed)\n>>>>>>> Stashed changes\n`,
        mode: 'regular',
      });
    }
  }

  /** Puts `path` in conflict with `ours` in the index and `merged` in the working tree. */
  setConflict(path: string, ours: string | null, merged: string | null): void {
    const side = { text: ours ?? '', mode: 'regular' as const };
    if (ours !== null && !this.head.has(path)) this.head.set(path, side);
    this.index.set(path, { ...side, conflicted: true });
    if (merged === null) this.worktree.delete(path);
    else this.worktree.set(path, { text: merged, mode: 'regular' });
  }

  isConflicted(path: string): boolean {
    return this.index.get(path)?.conflicted === true;
  }

  conflictedPaths(): string[] {
    return [...this.index]
      .filter(([, side]) => side.conflicted === true)
      .map(([path]) => path)
      .sort();
  }

  worktreeText(path: string): string | null {
    return this.worktree.get(path)?.text ?? null;
  }

  /** Resolves a conflict with `text` (`null`: the file is deleted), staged like `git add`. */
  resolveConflict(path: string, text: string | null): void {
    if (text === null) {
      this.index.delete(path);
      this.worktree.delete(path);
      return;
    }
    const side = { text, mode: 'regular' as const };
    this.index.set(path, side);
    this.worktree.set(path, { ...side });
  }

  /**
   * `git reset --hard`: index and working tree take HEAD (untracked files stay). Returns
   * the paths whose content was lost.
   */
  resetHard(): string[] {
    const lost = this.trackedChanges();
    const untracked = this.changes('unstaged').filter((c) => c.status === 'untracked');
    this.index = new Map([...this.head].map(([path, side]) => [path, clone(side)]));
    const kept = new Map(untracked.map((c) => [c.path, this.worktree.get(c.path)]));
    this.worktree = new Map([...this.head].map(([path, side]) => [path, clone(side)]));
    for (const [path, side] of kept) if (side) this.worktree.set(path, side);
    return lost;
  }

  /** `git reset --mixed`: the index takes HEAD, the working tree stays. */
  resetIndex(): void {
    this.index = new Map([...this.head].map(([path, side]) => [path, clone(side)]));
  }

  /** HEAD takes the index (after a commit or an amend). */
  commit(): void {
    this.head = new Map([...this.index].map(([path, side]) => [path, clone(side)]));
  }

  /** Deep copy, for the snapshots of the mock undo journal. */
  copy(): MockWip {
    const out = new MockWip();
    out.head = new Map([...this.head].map(([path, side]) => [path, { ...side }]));
    out.index = new Map([...this.index].map(([path, side]) => [path, { ...side }]));
    out.worktree = new Map([...this.worktree].map(([path, side]) => [path, { ...side }]));
    out.ignored = new Set(this.ignored);
    out.backups = this.backups;
    return out;
  }

  /**
   * Takes HEAD back from a snapshot, and the index and working tree too with `files`. With
   * `paths`, only those files come back, and HEAD stays (`Mode::Files` of the backend).
   */
  restoreFrom(snapshot: MockWip, files: boolean, paths: string[] | null = null): void {
    const copy = snapshot.copy();
    if (paths) {
      for (const [mine, theirs] of [
        [this.index, copy.index],
        [this.worktree, copy.worktree],
      ] as const) {
        for (const path of paths) {
          const side = theirs.get(path);
          if (side) mine.set(path, side);
          else mine.delete(path);
        }
      }
      this.ignored = copy.ignored;
      return;
    }
    this.head = copy.head;
    if (files) {
      this.index = copy.index;
      this.worktree = copy.worktree;
      this.ignored = copy.ignored;
    }
  }

  /** Paths (among `only` when given) whose index or working tree entry differs from `snapshot`. */
  changedSince(snapshot: MockWip, only: string[] | null = null): string[] {
    const changed = new Set<string>();
    for (const [mine, theirs] of [
      [this.index, snapshot.index],
      [this.worktree, snapshot.worktree],
    ] as const) {
      for (const path of only ?? new Set([...mine.keys(), ...theirs.keys()])) {
        if (JSON.stringify(mine.get(path)) !== JSON.stringify(theirs.get(path))) changed.add(path);
      }
    }
    return [...changed].sort();
  }

  /** Content of HEAD, index and working tree, to tell whether they changed. */
  fingerprint(): string {
    const entries = (map: Map<string, MockSide>) =>
      [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([
      entries(this.head),
      entries(this.index),
      entries(this.worktree),
      [...this.ignored].sort(),
    ]);
  }

  private nextBackup(): string {
    this.backups++;
    return `mock-backup-${String(this.backups)}`;
  }
}
