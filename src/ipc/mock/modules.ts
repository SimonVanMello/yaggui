import type {
  CreateWorktreeRequest,
  YagguiError,
  LfsStatus,
  SubmoduleStatus,
  SubmoduleUpdateRequest,
  WorktreeRef,
  WorktreeRemovePreview,
} from '../bindings';
import type { MockHistory } from '../mockGraph';
import { isValidRefName } from './refs';

/**
 * Submodules, worktrees and Git LFS of the mock repositories (M4-5). Each function works on
 * the live `MockHistory` of a repository; the mock client runs them as queued operations.
 */

type Result<T> = { ok: T } | { error: YagguiError };

function error(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

/** Same messages as the backend catalog (`git/errors.rs`). */
export function branchInOtherWorktree(branch: string, path: string): YagguiError {
  return error(
    'branchInOtherWorktree',
    `The branch "${branch}" is checked out in the worktree ${path}: open that worktree, or check out another branch here.`,
    `La branche « ${branch} » est extraite dans le worktree ${path} : ouvre ce worktree, ou extrais une autre branche ici.`,
  );
}

export function worktreeDirty(path: string): YagguiError {
  return error(
    'worktreeDirty',
    `The worktree ${path} has local changes: removing it would lose them.`,
    `Le worktree ${path} a des modifications locales : le supprimer les perdrait.`,
  );
}

export function worktreeLocked(path: string): YagguiError {
  return error(
    'worktreeLocked',
    `The worktree ${path} is locked. Unlock it (git worktree unlock) before removing it.`,
    `Le worktree ${path} est verrouillé. Déverrouille-le (git worktree unlock) avant de le supprimer.`,
  );
}

export function lfsNotInstalled(): YagguiError {
  return error(
    'lfsNotInstalled',
    'Git LFS is not installed: large files stay as pointers. Install Git LFS (git-lfs.com), then run git lfs install.',
    "Git LFS n'est pas installé : les gros fichiers restent des pointeurs. Installe Git LFS (git-lfs.com), puis lance git lfs install.",
  );
}

function targetNotEmpty(path: string): YagguiError {
  return error(
    'targetNotEmpty',
    `The folder ${path} already exists and is not empty. Choose another folder, or an empty one.`,
    `Le dossier ${path} existe déjà et n'est pas vide. Choisis un autre dossier, ou un dossier vide.`,
  );
}

function invalid(en: string, fr: string): YagguiError {
  return error('invalidArgument', en, fr);
}

/** Commit checked out in `vendor/codemirror` of `yaggui`: behind the recorded one. */
export const MOVED_CODEMIRROR_HEAD = '4e1b0f7a9c2d3e8f5a6b1c0d9e8f7a6b5c4d3e2f';

export const MOCK_LFS_VERSION = 'git-lfs/3.5.1 (GitHub; darwin arm64; go 1.22.2)';

/** Joins a repository-relative path to the worktree root, with the root's separator. */
function join(root: string, path: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`;
}

function headBranch(worktree: WorktreeRef): string | null {
  const head = worktree.head;
  return head && head.kind !== 'detached' ? head.name : null;
}

/** Live state the mock keeps next to each repository's history. */
export class MockModules {
  /** Checked out commit of a submodule when it differs from the recorded one. */
  private heads = new Map<number, Map<string, string>>();
  private dirtySubmodules = new Map<number, Set<string>>();
  /** Local changes of linked worktrees, by path. */
  private dirtyWorktrees = new Map<string, WorktreeRemovePreview['dirty']>();
  private patterns = new Map<number, string[]>();
  /** `false` simulates a machine without `git lfs`. */
  lfsInstalled = true;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.heads = new Map([[1, new Map([['vendor/codemirror', MOVED_CODEMIRROR_HEAD]])]]);
    this.dirtySubmodules = new Map([[1, new Set(['vendor/codemirror'])]]);
    this.dirtyWorktrees = new Map();
    // `yaggui-review` (see `createMockHistory`) has local changes.
    this.markWorktreeDirty('/Users/alex/dev/yaggui-review');
    this.patterns = new Map([[1, ['*.psd', '*.blend']]]);
    this.lfsInstalled = true;
  }

  /** A linked worktree of the scenario with local changes (`yaggui-review`). */
  markWorktreeDirty(path: string): void {
    this.dirtyWorktrees.set(path, { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 });
  }

  isWorktreeDirty(path: string): boolean {
    const dirty = this.dirtyWorktrees.get(path);
    return dirty !== undefined && dirty.staged + dirty.unstaged + dirty.untracked > 0;
  }

  lfsPatterns(repoId: number): string[] {
    return [...(this.patterns.get(repoId) ?? [])];
  }

  /** An undo or redo of `lfs track` puts `.gitattributes` back. */
  setLfsPatterns(repoId: number, patterns: readonly string[]): void {
    this.patterns.set(repoId, [...patterns]);
  }

  submoduleStatus(repoId: number, root: string, history: MockHistory): SubmoduleStatus[] {
    const heads = this.heads.get(repoId);
    const dirty = this.dirtySubmodules.get(repoId);
    return history.submodules.map((sub) => ({
      path: sub.path,
      absolutePath: join(root, sub.path),
      expected: sub.sha,
      head: sub.initialized ? (heads?.get(sub.path) ?? sub.sha) : null,
      initialized: sub.initialized,
      dirty: sub.initialized && (dirty?.has(sub.path) ?? false),
    }));
  }

  updateSubmodules(
    repoId: number,
    history: MockHistory,
    request: SubmoduleUpdateRequest,
  ): Result<null> {
    const unknown = request.paths.find((p) => !history.submodules.some((s) => s.path === p));
    if (unknown !== undefined) {
      return {
        error: invalid(
          `"${unknown}" is not a submodule of this repository.`,
          `« ${unknown} » n'est pas un submodule de ce dépôt.`,
        ),
      };
    }
    for (const sub of history.submodules) {
      if (request.paths.length > 0 && !request.paths.includes(sub.path)) continue;
      if (!sub.initialized && !request.init) continue;
      sub.initialized = true;
      this.heads.get(repoId)?.delete(sub.path);
    }
    return { ok: null };
  }

  createWorktree(
    history: MockHistory,
    request: CreateWorktreeRequest,
    isAbsolute: (path: string) => boolean,
  ): Result<string> {
    const { path, branch } = request;
    if (!isAbsolute(path)) {
      return {
        error: invalid(
          `Expected an absolute folder path, got "${path}".`,
          `Chemin de dossier absolu attendu, reçu « ${path} ».`,
        ),
      };
    }
    if (history.worktrees.some((w) => w.path === path)) return { error: targetNotEmpty(path) };
    let commit: number;
    if (branch.kind === 'existing') {
      const local = history.local.find((b) => b.name === branch.name);
      if (!local) {
        return {
          error: error(
            'revisionNotFound',
            `"${branch.name}" does not exist in this repository.`,
            `« ${branch.name} » n'existe pas dans ce dépôt.`,
          ),
        };
      }
      const other = history.worktrees.find((w) => headBranch(w) === branch.name);
      if (other) return { error: branchInOtherWorktree(branch.name, other.path) };
      commit = local.commit;
    } else {
      if (!isValidRefName(branch.name)) {
        return {
          error: error(
            'invalidRefName',
            `"${branch.name}" is not a valid branch name.`,
            `« ${branch.name} » n'est pas un nom de branche valide.`,
          ),
        };
      }
      if (history.local.some((b) => b.name === branch.name)) {
        return {
          error: error(
            'refExists',
            `A branch named "${branch.name}" already exists.`,
            `Une branche « ${branch.name} » existe déjà.`,
          ),
        };
      }
      // A branch name, else HEAD (the mock resolves no other revision).
      const head = history.head;
      const start =
        history.local.find((b) => b.name === branch.start) ??
        (head.kind === 'branch' ? history.local.find((b) => b.name === head.name) : undefined);
      commit = start?.commit ?? (head.kind === 'detached' ? head.commit : 0);
      history.local.push({ name: branch.name, commit });
    }
    history.worktrees.push({
      path,
      head: { kind: 'branch', name: branch.name, oid: history.commits[commit]?.sha ?? '' },
      isMain: false,
      isCurrent: false,
      locked: false,
      prunable: false,
    });
    history.worktrees.sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : a.path < b.path ? -1 : 1));
    return { ok: path };
  }

  private linked(history: MockHistory, path: string): Result<WorktreeRef> {
    const worktree = history.worktrees.find((w) => w.path === path && !w.isMain && !w.isCurrent);
    if (!worktree) {
      return {
        error: invalid(
          `${path} is not a linked worktree that can be removed from here.`,
          `${path} n'est pas un worktree lié qui peut être supprimé d'ici.`,
        ),
      };
    }
    return { ok: worktree };
  }

  removePreview(history: MockHistory, path: string): Result<WorktreeRemovePreview> {
    const found = this.linked(history, path);
    if ('error' in found) return found;
    const worktree = found.ok;
    const clean = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    return {
      ok: {
        path,
        branch: headBranch(worktree),
        dirty: worktree.prunable ? clean : (this.dirtyWorktrees.get(path) ?? clean),
        locked: worktree.locked,
        missing: worktree.prunable,
      },
    };
  }

  removeWorktree(history: MockHistory, path: string, force: boolean): Result<null> {
    const preview = this.removePreview(history, path);
    if ('error' in preview) return preview;
    if (preview.ok.locked) return { error: worktreeLocked(path) };
    const { dirty } = preview.ok;
    const changes = dirty.staged + dirty.unstaged + dirty.untracked + dirty.conflicted;
    if (changes > 0 && !force) return { error: worktreeDirty(path) };
    history.worktrees = history.worktrees.filter((w) => w.path !== path);
    this.dirtyWorktrees.delete(path);
    return { ok: null };
  }

  pruneWorktrees(history: MockHistory): Result<null> {
    history.worktrees = history.worktrees.filter((w) => !w.prunable);
    return { ok: null };
  }

  lfsStatus(repoId: number): LfsStatus {
    const patterns = this.patterns.get(repoId) ?? [];
    return {
      version: this.lfsInstalled ? MOCK_LFS_VERSION : null,
      patterns: [...patterns],
      used: patterns.length > 0,
    };
  }

  lfsPull(): Result<null> {
    return this.lfsInstalled ? { ok: null } : { error: lfsNotInstalled() };
  }

  lfsTrack(repoId: number, pattern: string): Result<null> {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.startsWith('-') || /[\r\n\0]/.test(trimmed)) {
      return {
        error: invalid(
          `"${trimmed}" is not a file pattern (e.g. *.psd).`,
          `« ${trimmed} » n'est pas un motif de fichiers (ex. *.psd).`,
        ),
      };
    }
    if (!this.lfsInstalled) return { error: lfsNotInstalled() };
    const patterns = this.patterns.get(repoId) ?? [];
    if (!patterns.includes(trimmed)) this.patterns.set(repoId, [...patterns, trimmed]);
    return { ok: null };
  }
}
