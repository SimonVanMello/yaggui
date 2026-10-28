import { isDemo } from '../demo/isDemo';
import type {
  CommitDetail,
  CommitSearch,
  GraphFilter,
  GraphLocation,
  GraphPage,
  GraphRef,
  HeadState,
  RefLabel,
  RepoRefs,
  SearchChunk,
  SignatureKind,
  StashRef,
  SubmoduleRef,
  UpstreamState,
  WorktreeRef,
} from './bindings';
import {
  GRAPH_MAX_LANES,
  GRAPH_PAGE_SIZE,
  SIGNATURE_GPG,
  SIGNATURE_NONE,
  SIGNATURE_SSH,
  SIGNATURE_UNKNOWN,
  SIGNATURE_X509,
} from './bindings';
import { computeLayout, type GraphLayout } from './mockLayout';
import { addLongRefs, addStressRefs } from './mockRefsStress';

const SIGNATURE_CODES: Record<SignatureKind, number> = {
  gpg: SIGNATURE_GPG,
  ssh: SIGNATURE_SSH,
  x509: SIGNATURE_X509,
  unknown: SIGNATURE_UNKNOWN,
};

function signatureCode(kind: SignatureKind | null): number {
  return kind === null ? SIGNATURE_NONE : SIGNATURE_CODES[kind];
}

/** A generated commit; `parents` are indices in `MockHistory.commits`. */
export interface MockCommit {
  sha: string;
  parents: number[];
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  commitTime: number;
  files: string[];
  signature: SignatureKind | null;
}

export interface MockBranch {
  name: string;
  commit: number;
  /** Local branches only: short name of the upstream. */
  upstream?: string;
}

export interface MockTag {
  name: string;
  commit: number;
  message: string | null;
}

export interface MockStash {
  message: string;
  sha: string;
  base: number;
  /** Third parent of the stash commit (`--include-untracked`). */
  untrackedSha?: string | null;
}

export type MockHead =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; commit: number }
  | { kind: 'unborn'; name: string };

export interface MockHistory {
  commits: MockCommit[];
  local: MockBranch[];
  /** Remote branches, `origin/main`. */
  remote: MockBranch[];
  remotes: { name: string; url: string; pushUrl?: string }[];
  tags: MockTag[];
  stashes: MockStash[];
  head: MockHead;
  submodules: SubmoduleRef[];
  worktrees: WorktreeRef[];
}

/** Deterministic PRNG (mulberry32) so screenshots and tests stay stable. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX_BYTES = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));

/** A fake but well-formed 40-char SHA. */
export function mockSha(seed: number, index: number): string {
  let out = '';
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < 5; i++) {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    // Byte lookups instead of `toString(16).padStart(8)`: 100k SHAs per huge mock history.
    out +=
      (HEX_BYTES[h >>> 24] as string) +
      (HEX_BYTES[(h >>> 16) & 0xff] as string) +
      (HEX_BYTES[(h >>> 8) & 0xff] as string) +
      (HEX_BYTES[h & 0xff] as string);
    h = (h + index + i * 0x632be5ab) >>> 0;
  }
  return out;
}

const AUTHORS: [string, string][] = [
  ['Alex Martin', 'alex@example.com'],
  ['Camille Durand', 'camille@yaggui.dev'],
  ['Linus Ek', 'linus.ek@example.org'],
  ['Aïcha Benali', 'aicha@example.org'],
  ['Kenji Watanabe', 'kenji@example.jp'],
  ['Maria Gonzalez', 'maria.g@example.com'],
];

const AREAS: [string, string[]][] = [
  ['graph', ['src/features/graph/GraphCanvas.tsx', 'src/features/graph/lanes.ts']],
  ['ipc', ['src/ipc/client.ts', 'src/ipc/mockClient.ts']],
  ['sidebar', ['src/features/sidebar/RefsSidebar.tsx', 'src/features/sidebar/tree.ts']],
  ['backend', ['src-tauri/src/graph/layout.rs', 'src-tauri/src/repo/mod.rs']],
  ['diff', ['src/features/diff/DiffView.tsx', 'src-tauri/src/git/read/diff.rs']],
  ['theme', ['src/theme/graphite.css', 'src/theme/paper.css']],
  ['docs', ['docs/PLAN.md', 'README.md']],
];

const VERBS: [string, string[]][] = [
  ['feat', ['add', 'support', 'introduce', 'show']],
  ['fix', ['fix', 'handle', 'guard against', 'restore']],
  ['refactor', ['extract', 'simplify', 'split', 'rename']],
  ['perf', ['speed up', 'cache', 'batch']],
  ['chore', ['bump', 'clean up', 'update']],
];

const OBJECTS = [
  'lane colors',
  'page loading',
  'stash labels',
  'ref filter',
  'scroll position',
  'empty repositories',
  'detached HEAD',
  'tag tooltips',
  'commit search',
  'keyboard navigation',
  'merge edges',
  'author initials',
];

const FEATURE_TOPICS = [
  'graph-lanes',
  'ref-sidebar',
  'stash-list',
  'diff-view',
  'palette',
  'search',
  'tabs-dnd',
  'perf-pages',
  'themes',
  'i18n',
  'watcher',
  'submodules',
];

interface GenOptions {
  seed: number;
  size: number;
  /** Seconds since epoch of the last commit (history goes back from there). */
  endTime: number;
  maxFeatures: number;
  octopus: boolean;
  orphan: boolean;
}

interface Feature {
  name: string;
  tip: number;
  commits: number;
  planned: number;
}

/** Simulates a team history: main, long feature branches, merges, octopus, an orphan branch. */
export function generateHistory(options: GenOptions): MockHistory {
  const rand = prng(options.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const commits: MockCommit[] = [];
  // Dates go forward from `start`, then are shifted to end at `endTime`.
  let time = 0;
  const local: MockBranch[] = [];
  const remote: MockBranch[] = [];
  const tags: MockTag[] = [];

  const commit = (parents: number[], summary?: string): number => {
    time += 600 + Math.floor(rand() * 4 * 3600);
    const [type, verbs] = pick(VERBS);
    const [area, files] = pick(AREAS);
    const [authorName, authorEmail] = pick(AUTHORS);
    const text = summary ?? `${type}(${area}): ${pick(verbs)} ${pick(OBJECTS)}`;
    commits.push({
      sha: mockSha(options.seed, commits.length),
      parents,
      summary: text,
      body:
        parents.length > 1 || rand() < 0.5
          ? ''
          : `Explain why the ${area} code needed this change.\n\nRefs: #${100 + commits.length}`,
      authorName,
      authorEmail,
      authorTime: time - Math.floor(rand() * 3600),
      commitTime: time,
      files: files.slice(0, 1 + Math.floor(rand() * files.length)),
      signature: rand() < 0.15 ? (rand() < 0.5 ? 'gpg' : 'ssh') : null,
    });
    return commits.length - 1;
  };

  let main = commit([], 'chore: initial commit');
  let mainCount = 1;
  const features: Feature[] = [];
  let featureSerial = 0;
  let develop: number | null = null;
  let orphan: number | null = null;

  while (commits.length < options.size) {
    const r = rand();
    if (features.length < options.maxFeatures && r < 0.08) {
      const topic = pick(FEATURE_TOPICS);
      featureSerial += 1;
      features.push({
        name: `${pick(['feat', 'fix', 'refactor'])}/${topic}-${featureSerial}`,
        tip: main,
        commits: 0,
        planned: 2 + Math.floor(rand() * (rand() < 0.2 ? 40 : 8)),
      });
    } else if (features.length > 0 && r < 0.62) {
      const feature = pick(features);
      feature.tip = commit([feature.tip]);
      feature.commits += 1;
    } else if (r < 0.8) {
      main = commit([main]);
      mainCount += 1;
      if (mainCount % 40 === 0) {
        const version = `v0.${Math.floor(mainCount / 40)}.0`;
        tags.push({
          name: version,
          commit: main,
          message: mainCount % 80 === 0 ? `Release ${version}` : null,
        });
      }
    } else if (r < 0.9) {
      const ready = features.filter((f) => f.commits >= f.planned);
      if (options.octopus && ready.length >= 3 && rand() < 0.1) {
        const merged = ready.slice(0, 3);
        main = commit(
          [main, ...merged.map((f) => f.tip)],
          `Merge branches ${merged.map((f) => `'${f.name}'`).join(', ')}`,
        );
        for (const f of merged) features.splice(features.indexOf(f), 1);
      } else if (ready.length > 0) {
        const feature = pick(ready);
        main = commit([main, feature.tip], `Merge branch '${feature.name}'`);
        features.splice(features.indexOf(feature), 1);
        // Some merged branches are kept around.
        if (rand() < 0.1) local.push({ name: feature.name, commit: feature.tip });
      }
    } else if (r < 0.95) {
      // Long-lived `develop`, merged back and forth with main (criss-cross shapes).
      if (develop === null) {
        develop = commit([main], 'chore: start develop');
      } else if (rand() < 0.5) {
        develop = commit([develop, main], "Merge branch 'main' into develop");
      } else {
        develop = commit([develop]);
        if (rand() < 0.3) main = commit([main, develop], "Merge branch 'develop'");
      }
    } else if (options.orphan && commits.length > options.size / 3) {
      orphan =
        orphan === null
          ? commit([], 'docs: start gh-pages')
          : commit([orphan], 'docs: publish site');
    }
  }

  const shift = options.endTime - time;
  for (const c of commits) {
    c.authorTime += shift;
    c.commitTime += shift;
  }

  local.push({ name: 'main', commit: main, upstream: 'origin/main' });
  remote.push({ name: 'origin/main', commit: main });
  if (develop !== null) {
    local.push({ name: 'develop', commit: develop, upstream: 'origin/develop' });
    remote.push({ name: 'origin/develop', commit: develop });
  }
  if (orphan !== null) remote.push({ name: 'origin/gh-pages', commit: orphan });
  features.forEach((feature, index) => {
    if (feature.commits === 0) return;
    if (index % 3 !== 2) {
      local.push({
        name: feature.name,
        commit: feature.tip,
        upstream: index % 2 === 0 ? `origin/${feature.name}` : undefined,
      });
    }
    if (index % 2 === 0 || index % 3 === 2)
      remote.push({ name: `origin/${feature.name}`, commit: feature.tip });
  });

  return {
    commits,
    local,
    remote,
    remotes: [{ name: 'origin', url: 'git@github.com:alexmartin/yaggui.git' }],
    tags,
    stashes: [],
    head: { kind: 'branch', name: 'main' },
    submodules: [],
    worktrees: [],
  };
}

function firstParentAncestor(history: MockHistory, commit: number, depth: number): number {
  let current = commit;
  for (let i = 0; i < depth; i++) {
    const parent = history.commits[current]?.parents[0];
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}

/** Fields (author, files…) of an existing commit, reused for the commits added on top. */
function templateCommit(history: MockHistory, index: number): MockCommit {
  const commit = history.commits[index] ?? history.commits[0];
  if (!commit) throw new Error('mock history without commits');
  return commit;
}

function longestFeature(history: MockHistory): MockBranch | undefined {
  return history.local
    .filter((b) => b.name.includes('/'))
    .sort((a, b) => b.commit - a.commit)
    .at(0);
}

/** Stash commits are not in the graph; only their base commit is. */
function stash(history: MockHistory, base: number, message: string): MockStash {
  return { message, sha: mockSha(0x57a5, history.stashes.length + base), base };
}

/** History of a mock repository, consistent with its `RepoState` (HEAD, upstream). */
export function createMockHistory(
  repoId: number,
  path: string,
  head: HeadState,
  upstream: UpstreamState | null,
  endTime: number,
): MockHistory {
  const empty: MockHistory = {
    commits: [],
    local: [],
    remote: [],
    remotes: [],
    tags: [],
    stashes: [],
    head: { kind: 'unborn', name: 'main' },
    submodules: [],
    worktrees: [{ path, head, isMain: true, isCurrent: true, locked: false, prunable: false }],
  };
  if (head.kind === 'unborn') return { ...empty, head: { kind: 'unborn', name: head.name } };

  const stress = !isDemo && /many-refs/.test(path);
  // A path containing `huge-history` simulates a history taller than the browser can lay out.
  const huge = !isDemo && /huge-history/.test(path);
  const sizes: Record<number, Partial<GenOptions>> = {
    1: { size: 640, maxFeatures: 6, octopus: true, orphan: true },
    // A huge history to exercise the virtualization (100k rows).
    2: { size: isDemo ? 2_000 : 100_000, maxFeatures: 10, octopus: true, orphan: false },
    3: { size: 120, maxFeatures: 1, octopus: false, orphan: false },
  };
  const history = generateHistory({
    seed: 0x6000 + repoId,
    size: 60,
    endTime,
    maxFeatures: 3,
    octopus: false,
    orphan: false,
    ...sizes[repoId],
    // A path containing `many-refs` simulates a repository with thousands of branches and tags.
    ...(stress ? { size: 2_000, maxFeatures: 6 } : {}),
    ...(huge ? { size: 400_000, maxFeatures: 4 } : {}),
  });
  if (stress) addStressRefs(history);
  const main = history.local.find((b) => b.name === 'main');

  if (head.kind === 'detached') {
    const feature = longestFeature(history);
    const target = firstParentAncestor(history, feature?.commit ?? main?.commit ?? 0, 1);
    const commit = history.commits[target];
    if (commit) commit.sha = head.oid;
    history.head = { kind: 'detached', commit: target };
  } else {
    let branch = history.local.find((b) => b.name === head.name);
    if (!branch) {
      // The checked out branch gets its own newest commits on top of a feature branch.
      let tip = (longestFeature(history) ?? main)?.commit ?? 0;
      for (let i = 0; i < 3; i++) {
        history.commits.push({
          ...templateCommit(history, tip),
          sha: mockSha(0x4ead, history.commits.length),
          parents: [tip],
          summary: ['feat(graph): draw lanes', 'fix(graph): merge edges', 'feat(graph): WIP node'][
            i
          ] as string,
          body: '',
          authorTime: endTime - 600 * (3 - i),
          commitTime: endTime - 600 * (3 - i),
          signature: null,
        });
        tip = history.commits.length - 1;
      }
      branch = { name: head.name, commit: tip };
      history.local.push(branch);
    }
    const tip = history.commits[branch.commit];
    if (tip) tip.sha = head.oid;
    history.head = { kind: 'branch', name: head.name };
    branch.upstream = upstream?.name ?? undefined;
    if (upstream && !upstream.gone) {
      history.remote = history.remote.filter((b) => b.name !== upstream.name);
      let remoteTip = firstParentAncestor(history, branch.commit, upstream.ahead);
      // Commits only on the remote (behind): appended on top of the shared base.
      for (let i = 0; i < upstream.behind; i++) {
        const parent = remoteTip;
        history.commits.push({
          ...templateCommit(history, parent),
          sha: mockSha(0xbe41, history.commits.length),
          parents: [parent],
          summary: `chore(deps): bump dependency ${i + 1}`,
          body: '',
          authorTime: endTime + 60 * (i + 1),
          commitTime: endTime + 60 * (i + 1),
          signature: null,
        });
        remoteTip = history.commits.length - 1;
      }
      history.remote.push({ name: upstream.name, commit: remoteTip });
    }
  }

  const headCommit =
    history.head.kind === 'detached'
      ? history.head.commit
      : (history.local.find((b) => history.head.kind === 'branch' && b.name === history.head.name)
          ?.commit ?? 0);
  if (repoId === 1) {
    // Upstream deleted on the remote and pruned: shown as `[gone]`.
    history.local.push({
      name: 'fix/stale-review',
      commit: firstParentAncestor(history, main?.commit ?? 0, 6),
      upstream: 'origin/fix/stale-review',
    });
    history.stashes.push(
      stash(history, headCommit, `WIP on ${head.kind === 'branch' ? head.name : 'HEAD'}: lanes`),
    );
    history.stashes.push(
      stash(
        history,
        firstParentAncestor(history, main?.commit ?? 0, 3),
        'On main: try another palette',
      ),
    );
    history.submodules.push({
      name: 'vendor/codemirror',
      path: 'vendor/codemirror',
      url: 'https://github.com/codemirror/dev.git',
      sha: mockSha(0x5b, 1),
      initialized: true,
    });
    history.submodules.push({
      name: 'docs/theme',
      path: 'docs/theme',
      url: 'https://github.com/yaggui-app/docs-theme.git',
      sha: mockSha(0x5b, 2),
      initialized: false,
    });
    history.submodules.sort((a, b) => (a.path < b.path ? -1 : 1));
    const review = history.local.find((b) => b.name.startsWith('fix/'));
    if (review) {
      history.worktrees.push({
        path: `${path}-review`,
        head: { kind: 'branch', name: review.name, oid: history.commits[review.commit]?.sha ?? '' },
        isMain: false,
        isCurrent: false,
        locked: false,
        prunable: false,
      });
    }
    // Its folder was deleted by hand: `git worktree prune` would forget it.
    history.worktrees.push({
      path: `${path}-spike`,
      head: { kind: 'detached', oid: history.commits[headCommit]?.sha ?? '' },
      isMain: false,
      isCurrent: false,
      locked: false,
      prunable: true,
    });
  } else if (repoId === 2) {
    history.stashes.push(stash(history, headCommit, 'On sched/eevdf-fixes: debug prints'));
  }
  if (/long-refs/.test(path)) addLongRefs(history, headCommit);
  history.worktrees.unshift({
    path,
    head,
    isMain: true,
    isCurrent: true,
    locked: false,
    prunable: false,
  });
  return history;
}

/** Parents of a commit, cut to the first one in first-parent mode (F-032). */
function parentsOf(commits: readonly MockCommit[], c: number, firstParent: boolean): number[] {
  const parents = commits[c]?.parents ?? [];
  return firstParent ? parents.slice(0, 1) : parents;
}

/**
 * `git log --topo-order` over the given tips (see `src-tauri/src/graph/topo.rs`); with
 * `firstParent`, each tip follows its first parents only.
 */
export function topoOrder(
  commits: readonly MockCommit[],
  tips: readonly number[],
  firstParent = false,
): number[] {
  const reachable = new Uint8Array(commits.length);
  const stack = [...tips];
  while (stack.length > 0) {
    const c = stack.pop() as number;
    if (reachable[c]) continue;
    reachable[c] = 1;
    for (const p of parentsOf(commits, c, firstParent)) if (!reachable[p]) stack.push(p);
  }
  const indegree = new Int32Array(commits.length);
  for (let c = 0; c < commits.length; c++) {
    if (!reachable[c]) continue;
    const parents = parentsOf(commits, c, firstParent);
    parents.forEach((p, i) => {
      if (parents.indexOf(p) === i) indegree[p] = (indegree[p] ?? 0) + 1;
    });
  }
  const time = (c: number) => commits[c]?.commitTime ?? 0;
  const queue: number[] = [];
  for (let c = 0; c < commits.length; c++) if (reachable[c] && indegree[c] === 0) queue.push(c);
  // Newest tip on top of the stack.
  queue.sort((a, b) => time(a) - time(b) || a - b);
  const order: number[] = [];
  while (queue.length > 0) {
    const c = queue.pop() as number;
    order.push(c);
    const parents = parentsOf(commits, c, firstParent);
    parents.forEach((p, i) => {
      // Duplicated parents count once, without a `Set` per commit (100k commits).
      if (parents.indexOf(p) !== i) return;
      indegree[p] = (indegree[p] ?? 0) - 1;
      if (indegree[p] === 0) queue.push(p);
    });
  }
  return order;
}

/** Whether `filter` hides the tip and label of `fullName` (solo aside). */
export function hidesRef(filter: GraphFilter, fullName: string): boolean {
  return (
    (filter.hideRemotes && fullName.startsWith('refs/remotes/')) ||
    filter.hidden.some((h) => h === fullName || (h.endsWith('/') && fullName.startsWith(h)))
  );
}

/** Commit of the soloed ref, `null` when it no longer exists (then everything is shown). */
function soloCommit(history: MockHistory, solo: string): number | null {
  const ref =
    history.local.find((b) => `refs/heads/${b.name}` === solo) ??
    history.remote.find((b) => `refs/remotes/${b.name}` === solo) ??
    history.tags.find((t) => `refs/tags/${t.name}` === solo);
  return ref?.commit ?? null;
}

/** A computed mock graph: order, layout and labels of one history version. */
export class MockGraph {
  readonly order: number[];
  readonly rowOf: Int32Array;
  readonly layout: GraphLayout;
  private readonly labels = new Map<number, RefLabel[]>();

  constructor(
    readonly history: MockHistory,
    readonly version: number,
    /** Refs left out (F-028) and first-parent mode (F-032), as `src-tauri/src/graph/mod.rs`. */
    readonly filter: GraphFilter | null = null,
  ) {
    const { commits } = history;
    for (const branch of history.local) {
      this.label(branch.commit, {
        kind: 'localBranch',
        name: branch.name,
        fullName: `refs/heads/${branch.name}`,
        isHead: history.head.kind === 'branch' && history.head.name === branch.name,
        upstream: branch.upstream ?? null,
      });
    }
    for (const branch of history.remote) {
      this.label(branch.commit, {
        kind: 'remoteBranch',
        name: branch.name,
        fullName: `refs/remotes/${branch.name}`,
        isHead: false,
        upstream: null,
      });
    }
    for (const tag of history.tags) {
      this.label(tag.commit, {
        kind: 'tag',
        name: tag.name,
        fullName: `refs/tags/${tag.name}`,
        isHead: false,
        upstream: null,
      });
    }
    history.stashes.forEach((s, index) => {
      this.label(s.base, {
        kind: 'stash',
        name: `stash@{${index}}`,
        fullName: 'refs/stash',
        isHead: false,
        upstream: null,
        message: s.message,
      });
    });
    const head = this.headCommit();
    if (history.head.kind === 'detached' && head !== null) {
      this.label(head, {
        kind: 'head',
        name: 'HEAD',
        fullName: 'HEAD',
        isHead: true,
        upstream: null,
      });
    }

    const solo = filter?.solo ? soloCommit(history, filter.solo) : null;
    let tips: number[];
    if (solo !== null) {
      tips = [solo];
    } else {
      tips = [
        ...history.local.map((b) => ({ ref: `refs/heads/${b.name}`, commit: b.commit })),
        ...history.remote.map((b) => ({ ref: `refs/remotes/${b.name}`, commit: b.commit })),
        ...history.tags.map((t) => ({ ref: `refs/tags/${t.name}`, commit: t.commit })),
      ]
        .filter((r) => !filter || !hidesRef(filter, r.ref))
        .map((r) => r.commit);
      if (head !== null) tips.push(head);
    }
    if (filter) {
      for (const [commit, list] of this.labels) {
        const kept = list.filter((l) =>
          l.kind === 'stash'
            ? !filter.hideStashes
            : l.kind === 'head'
              ? solo === null
              : l.isHead || !hidesRef(filter, l.fullName),
        );
        if (kept.length > 0) this.labels.set(commit, kept);
        else this.labels.delete(commit);
      }
    }
    const firstParent = filter?.firstParent ?? false;
    this.order = topoOrder(commits, tips, firstParent);
    this.rowOf = new Int32Array(commits.length).fill(-1);
    this.order.forEach((c, row) => {
      this.rowOf[c] = row;
    });
    const parentRows = this.order.map((c) =>
      parentsOf(commits, c, firstParent)
        .map((p) => this.rowOf[p] ?? -1)
        .filter((r) => r >= 0),
    );
    const seeds = this.order.map((c) => this.seed(c));
    const soloOnOther =
      solo !== null &&
      !(history.head.kind === 'branch' && filter?.solo === `refs/heads/${history.head.name}`);
    const headRow = head === null || soloOnOther ? null : (this.rowOf[head] ?? -1);
    this.layout = computeLayout(
      parentRows,
      seeds,
      headRow !== null && headRow >= 0 ? headRow : null,
      head === null ? '' : this.seed(head),
    );
  }

  private label(commit: number, label: RefLabel) {
    const list = this.labels.get(commit) ?? [];
    list.push(label);
    this.labels.set(commit, list);
  }

  /** Same color seed as the backend: branch name (remote prefix removed) or SHA. */
  private seed(commit: number): string {
    const labels = this.labels.get(commit) ?? [];
    const branch =
      labels.find((l) => l.kind === 'localBranch') ?? labels.find((l) => l.kind === 'remoteBranch');
    if (branch?.kind === 'remoteBranch') return branch.name.slice(branch.name.indexOf('/') + 1);
    return branch?.name ?? this.history.commits[commit]?.sha ?? '';
  }

  headCommit(): number | null {
    const { head } = this.history;
    if (head.kind === 'detached') return head.commit;
    if (head.kind === 'unborn') return null;
    return this.history.local.find((b) => b.name === head.name)?.commit ?? null;
  }

  labelsOf(commit: number): RefLabel[] {
    return this.labels.get(commit) ?? [];
  }

  rowOfCommit(commit: number): number | null {
    const row = this.rowOf[commit] ?? -1;
    return row >= 0 ? row : null;
  }

  page(start: number, limit: number): GraphPage {
    const total = this.order.length;
    const from = Math.min(start, total);
    const to = Math.min(total, from + Math.min(limit, GRAPH_PAGE_SIZE));
    const { commits } = this.history;
    const { lanes, colors, edgeOffsets, edges } = this.layout;
    const rows = this.order.slice(from, to).map((c) => commits[c] as MockCommit);
    const firstEdge = edgeOffsets[from] ?? 0;
    const lastEdge = edgeOffsets[to] ?? firstEdge;
    const pageEdges = edges.slice(firstEdge * 4, lastEdge * 4);
    let laneCount = 0;
    for (let r = from; r < to; r++) laneCount = Math.max(laneCount, (lanes[r] ?? 0) + 1);
    for (let i = 0; i < pageEdges.length; i += 4) {
      laneCount = Math.max(laneCount, (pageEdges[i] ?? 0) + 1, (pageEdges[i + 1] ?? 0) + 1);
    }
    const refs: GraphRef[] = [];
    for (let r = from; r < to; r++) {
      for (const label of this.labelsOf(this.order[r] ?? -1)) refs.push({ row: r, label });
    }
    return {
      version: this.version,
      start: from,
      totalRows: total,
      totalExact: true,
      laneCount: Math.min(laneCount, GRAPH_MAX_LANES),
      wip: this.layout.wip,
      shas: rows.map((c) => c.sha),
      parents: rows.map((c) => c.parents.map((p) => commits[p]?.sha ?? '')),
      summaries: rows.map((c) => c.summary),
      authorNames: rows.map((c) => c.authorName),
      authorEmails: rows.map((c) => c.authorEmail),
      authorTimes: rows.map((c) => c.authorTime),
      commitTimes: rows.map((c) => c.commitTime),
      lanes: Array.from(lanes.subarray(from, to)),
      colors: Array.from(colors.subarray(from, to)),
      signatures: rows.map((c) => signatureCode(c.signature)),
      edgeOffsets: Array.from(edgeOffsets.subarray(from, to + 1), (o) => o - firstEdge),
      edges: pageEdges,
      refs,
    };
  }

  /** Resolves a SHA (prefix of 4+ chars), branch, tag, `HEAD` or `HEAD~n`. */
  resolve(rev: string): number | null {
    const { history } = this;
    const trimmed = rev.trim();
    const ancestry = /^(.*?)~(\d+)$/.exec(trimmed);
    if (ancestry) {
      const base = this.resolve(ancestry[1] ?? '');
      return base === null ? null : firstParentAncestor(history, base, Number(ancestry[2]));
    }
    if (trimmed === 'HEAD') return this.headCommit();
    const named =
      history.local.find((b) => b.name === trimmed || `refs/heads/${b.name}` === trimmed) ??
      history.remote.find((b) => b.name === trimmed || `refs/remotes/${b.name}` === trimmed) ??
      history.tags.find((t) => t.name === trimmed || `refs/tags/${t.name}` === trimmed);
    if (named) return named.commit;
    if (/^[0-9a-f]{4,40}$/i.test(trimmed)) {
      const lower = trimmed.toLowerCase();
      const index = history.commits.findIndex((c) => c.sha.startsWith(lower));
      return index >= 0 ? index : null;
    }
    return null;
  }

  locate(commit: number): GraphLocation {
    return {
      version: this.version,
      sha: this.history.commits[commit]?.sha ?? '',
      row: this.rowOfCommit(commit),
    };
  }

  /** Scans at most `budget` rows from `fromRow`, like the time-budgeted backend search. */
  search(query: CommitSearch, fromRow: number, budget = 20_000): SearchChunk {
    const total = this.order.length;
    const text = query.text?.trim().toLowerCase() || null;
    const author = query.author?.trim().toLowerCase() || null;
    const path =
      query.path
        ?.trim()
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase() || null;
    const end = Math.min(total, fromRow + budget);
    const matches: number[] = [];
    for (let row = fromRow; row < end; row++) {
      const c = this.history.commits[this.order[row] ?? -1];
      if (!c) continue;
      const who = `${c.authorName}\n${c.authorEmail}`.toLowerCase();
      if (
        text &&
        !`${c.summary}\n${c.body}`.toLowerCase().includes(text) &&
        !who.includes(text) &&
        !c.sha.startsWith(text)
      ) {
        continue;
      }
      if (author && !who.includes(author)) continue;
      if (query.since !== null && c.authorTime < query.since) continue;
      if (query.until !== null && c.authorTime > query.until) continue;
      if (
        path &&
        !c.files.some((f) => {
          const lower = f.toLowerCase();
          return lower === path || lower.startsWith(`${path}/`);
        })
      )
        continue;
      matches.push(row);
    }
    return {
      version: this.version,
      matches,
      nextRow: end < total ? end : null,
      totalRows: total,
    };
  }

  detail(commit: number): CommitDetail {
    const c = this.history.commits[commit] as MockCommit;
    const signature = {
      name: c.authorName,
      email: c.authorEmail,
      time: c.authorTime,
      offsetMinutes: 120,
    };
    return {
      sha: c.sha,
      parents: c.parents.map((p) => this.history.commits[p]?.sha ?? ''),
      summary: c.summary,
      message: c.body ? `${c.summary}\n\n${c.body}` : c.summary,
      author: signature,
      committer: { ...signature, time: c.commitTime },
      refs: this.labelsOf(commit),
      signature: c.signature,
      row: this.rowOfCommit(commit),
    };
  }

  refs(head: HeadState, headUpstream: UpstreamState | null): RepoRefs {
    const { history } = this;
    const shaOf = (commit: number) => history.commits[commit]?.sha ?? '';
    const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
    const stashes: StashRef[] = history.stashes.map((s, index) => ({
      index,
      name: `stash@{${index}}`,
      message: s.message,
      sha: s.sha,
      baseSha: shaOf(s.base),
      untrackedSha: s.untrackedSha ?? null,
      row: this.rowOfCommit(s.base),
    }));
    return {
      graphVersion: this.version,
      head,
      local: history.local
        .map((b) => {
          const isHead = history.head.kind === 'branch' && history.head.name === b.name;
          const remote = history.remote.find((r) => r.name === b.upstream);
          let upstream: UpstreamState | null = null;
          if (isHead && headUpstream) upstream = headUpstream;
          else if (b.upstream) {
            upstream = {
              name: b.upstream,
              ahead: remote ? countExclusive(history, b.commit, remote.commit) : 0,
              behind: remote ? countExclusive(history, remote.commit, b.commit) : 0,
              gone: !remote,
            };
          }
          return {
            name: b.name,
            fullName: `refs/heads/${b.name}`,
            sha: shaOf(b.commit),
            isHead,
            upstream,
            row: this.rowOfCommit(b.commit),
          };
        })
        .sort(byName),
      remotes: history.remotes.map((remote) => ({
        name: remote.name,
        url: remote.url,
        pushUrl: remote.pushUrl ?? null,
        branches: history.remote
          .filter((b) => b.name.startsWith(`${remote.name}/`))
          .map((b) => ({
            name: b.name,
            fullName: `refs/remotes/${b.name}`,
            sha: shaOf(b.commit),
            row: this.rowOfCommit(b.commit),
          }))
          .sort(byName),
      })),
      tags: history.tags
        .map((t) => ({
          name: t.name,
          fullName: `refs/tags/${t.name}`,
          sha: shaOf(t.commit),
          annotated: t.message !== null,
          message: t.message,
          row: this.rowOfCommit(t.commit),
        }))
        .sort(byName),
      stashes,
      submodules: history.submodules,
      worktrees: history.worktrees,
    };
  }
}

function ancestors(history: MockHistory, tip: number): Set<number> {
  const seen = new Set<number>();
  const stack = [tip];
  while (stack.length > 0) {
    const c = stack.pop() as number;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(history.commits[c]?.parents ?? []));
  }
  return seen;
}

/** Commits reachable from `tip` but not from `hidden` (`git rev-list --count hidden..tip`). */
export function countExclusive(history: MockHistory, tip: number, hidden: number): number {
  // Mock commits are appended after their parents, so walking indexes downwards visits every
  // commit after all its children: its flags are final when reached. The walk stops once no
  // commit reachable only from `tip` is left, i.e. at the merge base, instead of visiting the
  // whole history (two full walks per upstream made `listRefs` slow on 100k commits).
  const { commits } = history;
  const TIP = 1;
  const HIDDEN = 2;
  const flags = new Map<number, number>([[hidden, HIDDEN]]);
  flags.set(tip, (flags.get(tip) ?? 0) | TIP);
  let pending = flags.get(tip) === TIP ? 1 : 0;
  let count = 0;
  for (let c = Math.max(tip, hidden); c >= 0 && pending > 0; c--) {
    const flag = flags.get(c);
    if (flag === undefined) continue;
    flags.delete(c);
    if (flag === TIP) {
      pending -= 1;
      count += 1;
    }
    for (const p of commits[c]?.parents ?? []) {
      if (p >= c) return countExclusiveFullWalk(history, tip, hidden);
      const before = flags.get(p) ?? 0;
      const after = before | flag;
      if (after === before) continue;
      flags.set(p, after);
      if (after === TIP) pending += 1;
      else if (before === TIP) pending -= 1;
    }
  }
  return count;
}

/** Same count without the ordering assumption (never needed by the current mock histories). */
function countExclusiveFullWalk(history: MockHistory, tip: number, hidden: number): number {
  const excluded = ancestors(history, hidden);
  let count = 0;
  for (const c of ancestors(history, tip)) if (!excluded.has(c)) count += 1;
  return count;
}
