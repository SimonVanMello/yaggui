import type {
  BranchCleanup,
  ComparedCommit,
  Comparison,
  DeleteBranchesResult,
  DiffSide,
  GraphFilter,
  GraphLocation,
  YagguiError,
  RepoRefs,
} from '../bindings';
import { COMPARE_MAX_COMMITS, GRAPH_FILTER_MAX } from '../bindings';
import type { MockGraph, MockHistory } from '../mockGraph';
import { isProtectedBranch } from './network';
import { ancestors } from './refs';

/** Graph, diff and branch tools of M4-7b, as `src-tauri/src/repo/graph_tools.rs`. */

type Result<T> = { ok: T } | { error: YagguiError };

function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

export const EMPTY_GRAPH_FILTER: GraphFilter = {
  hidden: [],
  solo: null,
  hideRemotes: false,
  hideStashes: false,
};

export function isFilterEmpty(filter: GraphFilter): boolean {
  return (
    filter.hidden.length === 0 && filter.solo === null && !filter.hideRemotes && !filter.hideStashes
  );
}

const REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];

function validRef(name: string): boolean {
  const rest = REF_PREFIXES.find((prefix) => name.startsWith(prefix));
  if (rest === undefined) return false;
  const short = name.slice(rest.length);
  return (
    short.length > 0 &&
    !short.split('/').some((part) => part === '' || part === '..' || part.startsWith('.')) &&
    !/[\s~^:?*[\\]/.test(short)
  );
}

function invalidRef(name: string): YagguiError {
  return mockError(
    'invalidArgument',
    `"${name}" is not a branch or tag name.`,
    `« ${name} » n'est pas un nom de branche ou de tag.`,
  );
}

/** Validates and deduplicates a filter, like `normalized_filter`. */
export function normalizeFilter(filter: GraphFilter): Result<GraphFilter> {
  const hidden: string[] = [];
  for (const raw of filter.hidden) {
    const name = raw.trim();
    if (!validRef(name)) return { error: invalidRef(name) };
    if (!hidden.includes(name)) hidden.push(name);
  }
  if (hidden.length > GRAPH_FILTER_MAX) {
    return {
      error: mockError(
        'invalidArgument',
        `At most ${String(GRAPH_FILTER_MAX)} branches can be hidden.`,
        `${String(GRAPH_FILTER_MAX)} branches au plus peuvent être masquées.`,
      ),
    };
  }
  const solo = filter.solo?.trim() ?? null;
  if (solo !== null && !validRef(solo)) return { error: invalidRef(solo) };
  return {
    ok: { hidden, solo, hideRemotes: filter.hideRemotes, hideStashes: filter.hideStashes },
  };
}

/**
 * Best common ancestor. Mock commits come after their parents, so the common ancestor with the
 * highest index is never an ancestor of another common one: it is a best merge-base.
 */
export function mergeBaseOf(history: MockHistory, a: number, b: number): number | null {
  if (a === b) return a;
  const fromA = ancestors(history.commits, a);
  let best = -1;
  for (const c of ancestors(history.commits, b)) if (fromA.has(c) && c > best) best = c;
  return best >= 0 ? best : null;
}

export function mergeBase(graph: MockGraph, a: number, b: number): GraphLocation | null {
  const base = mergeBaseOf(graph.history, a, b);
  return base === null ? null : graph.locate(base);
}

function exclusive(graph: MockGraph, tip: number, hidden: number): [ComparedCommit[], number] {
  const { commits } = graph.history;
  const excluded = ancestors(commits, hidden);
  const only = [...ancestors(commits, tip)]
    .filter((c) => !excluded.has(c))
    .sort((x, y) => (commits[y]?.commitTime ?? 0) - (commits[x]?.commitTime ?? 0) || y - x);
  const list = only.slice(0, COMPARE_MAX_COMMITS).map((c) => {
    const commit = commits[c];
    return {
      sha: commit?.sha ?? '',
      summary: commit?.summary ?? '',
      authorName: commit?.authorName ?? '',
      authorEmail: commit?.authorEmail ?? '',
      authorTime: commit?.authorTime ?? 0,
      row: graph.rowOfCommit(c),
    };
  });
  return [list, only.length];
}

export function compare(graph: MockGraph, a: number, b: number): Comparison {
  const [onlyA, onlyACount] = a === b ? [[], 0] : exclusive(graph, a, b);
  const [onlyB, onlyBCount] = a === b ? [[], 0] : exclusive(graph, b, a);
  const base = mergeBaseOf(graph.history, a, b);
  const sha = (c: number) => graph.history.commits[c]?.sha ?? '';
  return {
    a: sha(a),
    b: sha(b),
    mergeBase: base === null ? null : sha(base),
    onlyA,
    onlyB,
    onlyACount,
    onlyBCount,
    version: graph.version,
  };
}

function checkedOut(refs: RepoRefs): Set<string> {
  const names = new Set<string>();
  for (const w of refs.worktrees) {
    if (w.head?.kind === 'branch' || w.head?.kind === 'unborn') names.add(w.head.name);
  }
  if (refs.head.kind === 'branch' || refs.head.kind === 'unborn') names.add(refs.head.name);
  return names;
}

/** Merged and `[gone]` branches, as `branch_cleanup`. */
export function branchCleanup(
  graph: MockGraph,
  refs: RepoRefs,
  protectedBranches: readonly string[],
): BranchCleanup {
  const head = graph.headCommit();
  const { history } = graph;
  const reachable = head === null ? new Set<number>() : ancestors(history.commits, head);
  const busy = checkedOut(refs);
  const cleanup: BranchCleanup = {
    into: refs.head.kind === 'branch' ? refs.head.name : null,
    branches: [],
    protected: [],
    checkedOut: [],
  };
  const sorted = [...refs.local].sort((x, y) => (x.name < y.name ? -1 : 1));
  for (const branch of sorted) {
    const commit = history.local.find((b) => b.name === branch.name)?.commit;
    if (commit === undefined) continue;
    const gone = branch.upstream?.gone === true;
    const merged = reachable.has(commit);
    if (!merged && !gone) continue;
    if (busy.has(branch.name)) {
      cleanup.checkedOut.push(branch.name);
      continue;
    }
    if (isProtectedBranch(branch.name, protectedBranches)) {
      cleanup.protected.push(branch.name);
      continue;
    }
    let unmerged = 0;
    if (!merged) {
      for (const c of ancestors(history.commits, commit)) if (!reachable.has(c)) unmerged += 1;
    }
    cleanup.branches.push({
      name: branch.name,
      sha: branch.sha,
      merged,
      gone,
      upstream: branch.upstream?.name ?? null,
      unmerged,
    });
  }
  return cleanup;
}

/** Deletes local branches after the checks of `delete_branches` (all or nothing). */
export function deleteBranches(
  graph: MockGraph,
  refs: RepoRefs,
  names: readonly string[],
  protectedBranches: readonly string[],
): Result<DeleteBranchesResult> {
  if (names.length === 0) {
    return {
      error: mockError('invalidArgument', 'No branch to delete.', 'Aucune branche à supprimer.'),
    };
  }
  const { history } = graph;
  const busy = checkedOut(refs);
  const current = history.head.kind === 'branch' ? history.head.name : null;
  const unique = [...new Set(names)];
  const deleted: DeleteBranchesResult['deleted'] = [];
  for (const name of unique) {
    const branch = history.local.find((b) => b.name === name);
    if (!branch) {
      return {
        error: mockError(
          'revisionNotFound',
          `No commit matches "${name}".`,
          `Aucun commit ne correspond à « ${name} ».`,
        ),
      };
    }
    if (name === current) {
      return {
        error: mockError(
          'currentBranch',
          `"${name}" is the current branch: check out another branch before deleting it.`,
          `« ${name} » est la branche courante : fais d'abord un checkout d'une autre branche pour la supprimer.`,
        ),
      };
    }
    if (busy.has(name)) {
      return {
        error: mockError(
          'branchCheckedOut',
          `"${name}" is checked out in a worktree: it cannot be deleted.`,
          `« ${name} » est extraite dans un worktree : elle ne peut pas être supprimée.`,
        ),
      };
    }
    if (isProtectedBranch(name, protectedBranches)) {
      return {
        error: mockError(
          'protectedBranchDelete',
          `"${name}" is a protected branch: the cleanup never deletes it. Delete it on its own if you really mean to.`,
          `« ${name} » est une branche protégée : le nettoyage ne la supprime jamais. Supprime-la seule si c'est vraiment voulu.`,
        ),
      };
    }
    deleted.push({
      fullName: `refs/heads/${name}`,
      sha: history.commits[branch.commit]?.sha ?? '',
    });
  }
  history.local = history.local.filter((b) => !unique.includes(b.name));
  return { ok: { deleted } };
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;

/** A generated picture standing for one side of an image (the mock has no blobs). */
export function mockDiffImage(path: string, side: DiffSide): string | null {
  if (!IMAGE.test(path)) return null;
  const svg =
    side === 'old'
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#e5e7eb"/><circle cx="60" cy="50" r="30" fill="#3b82f6"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#e5e7eb"/><circle cx="90" cy="50" r="36" fill="#22c55e"/><rect x="20" y="20" width="30" height="20" fill="#f59e0b"/></svg>';
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export function diffToolMissing(): YagguiError {
  return mockError(
    'diffToolMissing',
    'No external diff tool is configured: choose one in the preferences (Tools) or set diff.tool in your Git configuration.',
    "Aucun outil de diff externe n'est configuré : choisis-en un dans les préférences (Outils) ou renseigne diff.tool dans ta configuration Git.",
  );
}

export function diffToolFailed(tool: string): YagguiError {
  return {
    ...mockError(
      'diffToolFailed',
      `The diff tool "${tool}" could not be started. Check that it is installed and configured (difftool.${tool}.cmd).`,
      `L'outil de diff « ${tool} » n'a pas pu être lancé. Vérifie qu'il est installé et configuré (difftool.${tool}.cmd).`,
    ),
    action: { kind: 'openCommandLog' },
  };
}
