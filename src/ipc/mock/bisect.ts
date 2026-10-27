import type { BisectCommit, BisectMark, BisectResult, BisectState, YagguiError } from '../bindings';
import type { MockCommit, MockHead, MockHistory } from '../mockGraph';
import { ancestors } from './refs';

/** Errors of the bisect commands (M7-9), with the messages of `git/errors.rs`. */
function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

export function bisectDirty(paths: string[]): YagguiError {
  return {
    ...mockError(
      'dirtyWorktree',
      'You have local changes: a bisect tests each commit as it was committed. Stash or commit them first.',
      "Tu as des modifications locales : un bisect teste chaque commit tel qu'il a été commité. Mets-les de côté (stash) ou commite-les d'abord.",
    ),
    payload: { kind: 'dirtyWorktree', paths, canCarry: false },
  };
}

export function bisectWrongOrder(): YagguiError {
  return mockError(
    'bisectWrongOrder',
    'A good commit is not an ancestor of the bad one: Git cannot bisect between them. Check the marks, or end the bisect and start again.',
    "Un commit bon n'est pas un ancêtre du mauvais : Git ne peut pas faire de bisect entre eux. Vérifie les marquages, ou termine le bisect et recommence.",
  );
}

export function bisectCheckoutFailed(paths: string[]): YagguiError {
  return {
    ...mockError(
      'bisectCheckoutFailed',
      'The mark is saved, but the next commit to test could not be checked out: files are in the way. Move or remove them, then check out the next commit.',
      "Le marquage est enregistré, mais le prochain commit à tester n'a pas pu être extrait : des fichiers gênent. Déplace-les ou supprime-les, puis extrais le commit suivant.",
    ),
    payload: { kind: 'dirtyWorktree', paths, canCarry: false },
  };
}

export function bisectNotStarted(): YagguiError {
  return mockError(
    'invalidArgument',
    'No bisect in progress: mark a good or a bad commit to start one.',
    'Aucun bisect en cours : marque un commit bon ou mauvais pour en démarrer un.',
  );
}

/** A bisect of the mock: what `refs/bisect/*` and `BISECT_START` hold. */
export interface MockBisect {
  bad: number | null;
  good: number[];
  skipped: number[];
  /** HEAD when the bisect started, put back by the reset. */
  original: MockHead;
  /** Started with `--first-parent` (`BISECT_FIRST_PARENT`): first-parent mode was on. */
  firstParent?: boolean;
}

/** Marks of a bisect started outside the mock's commands, as revisions. */
export interface MockBisectMarks {
  bad?: string;
  good?: string[];
  skipped?: string[];
}

/** Git's `estimate_bisect_steps`. */
export function estimateSteps(all: number): number {
  if (all < 3) return 0;
  const n = Math.floor(Math.log2(all));
  const e = 2 ** n;
  return e < 3 * (all - e) ? n : n - 1;
}

/**
 * Commits reachable from `bad` and from none of `good`; with `firstParent`, only the
 * first-parent chain of `bad` (the good side still hides every ancestor), like `range` of
 * `read/bisect.rs`.
 */
export function bisectRange(
  commits: readonly MockCommit[],
  bad: number,
  good: readonly number[],
  firstParent = false,
): number[] {
  const hidden = new Set<number>();
  for (const g of good) for (const c of ancestors(commits, g)) hidden.add(c);
  if (!firstParent) return [...ancestors(commits, bad)].filter((c) => !hidden.has(c));
  const chain: number[] = [];
  let current: number | undefined = bad;
  while (current !== undefined && !hidden.has(current)) {
    chain.push(current);
    current = commits[current]?.parents[0];
  }
  return chain;
}

/** Larger ranges take the middle by index instead of the best split (mock only). */
const SPLIT_LIMIT = 400;

/** The candidate that splits the range best, like Git's bisection point. */
function middle(
  commits: readonly MockCommit[],
  range: number[],
  candidates: number[],
  firstParent: boolean,
): number {
  const sorted = [...candidates].sort((a, b) => a - b);
  if (candidates.length > SPLIT_LIMIT) return sorted[Math.floor(sorted.length / 2)] ?? -1;
  const inRange = new Set(range);
  let best = sorted[0] ?? -1;
  let bestScore = -1;
  for (const c of sorted) {
    let reach = 0;
    if (firstParent) {
      // The range is a chain from the bad commit: what is left after `c` is its ancestry.
      reach = range.length - range.indexOf(c);
    } else {
      for (const a of ancestors(commits, c)) if (inRange.has(a)) reach++;
    }
    const score = Math.min(reach, range.length - reach);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export interface BisectOutcome {
  remaining: number | null;
  steps: number | null;
  result:
    | { kind: 'found'; commit: number }
    | { kind: 'inconclusive'; candidates: number[] }
    | { kind: 'inconsistentMarks' }
    | null;
  /** Commit to check out next; `null` when there is none (result, or a mark missing). */
  next: number | null;
}

export function bisectOutcome(commits: readonly MockCommit[], b: MockBisect): BisectOutcome {
  if (b.bad === null || b.good.length === 0) {
    return { remaining: null, steps: null, result: null, next: null };
  }
  const bad = b.bad;
  const firstParent = b.firstParent === true;
  const range = bisectRange(commits, bad, b.good, firstParent);
  const skipped = new Set(b.skipped);
  const untested = range.filter((c) => c !== bad && !skipped.has(c));
  let result: BisectOutcome['result'] = null;
  if (!range.includes(bad)) {
    // Hidden by a good commit it is an ancestor of (marks taken in a terminal).
    result = { kind: 'inconsistentMarks' };
  } else if (untested.length === 0) {
    result =
      range.length === 1
        ? { kind: 'found', commit: bad }
        : {
            kind: 'inconclusive',
            candidates: [...range].sort(
              (x, y) => (commits[y]?.authorTime ?? 0) - (commits[x]?.authorTime ?? 0),
            ),
          };
  }
  return {
    remaining: untested.length,
    steps: estimateSteps(untested.length + 1),
    result,
    next: untested.length > 0 ? middle(commits, range, untested, firstParent) : null,
  };
}

/** Records `mark` on `commit`; a newer bad mark replaces the previous one, like Git. */
export function applyMark(b: MockBisect, commit: number, mark: BisectMark): void {
  if (mark === 'bad') b.bad = commit;
  const list = mark === 'good' ? b.good : mark === 'skip' ? b.skipped : null;
  if (list && !list.includes(commit)) list.push(commit);
}

/** A good commit that descends from the bad one: Git refuses to bisect. */
export function wrongOrder(commits: readonly MockCommit[], b: MockBisect): boolean {
  const bad = b.bad;
  return bad !== null && b.good.some((g) => g !== bad && ancestors(commits, g).has(bad));
}

function bisectCommit(commits: readonly MockCommit[], commit: number): BisectCommit | null {
  const c = commits[commit];
  return c
    ? { sha: c.sha, summary: c.summary, authorName: c.authorName, authorTime: c.authorTime }
    : null;
}

export function mockBisectState(
  history: MockHistory,
  b: MockBisect,
  head: number | null,
): BisectState {
  const { commits } = history;
  const sha = (c: number) => commits[c]?.sha ?? '';
  const outcome = bisectOutcome(commits, b);
  let result: BisectResult | null = null;
  if (outcome.result?.kind === 'found') {
    const commit = bisectCommit(commits, outcome.result.commit);
    result = commit ? { kind: 'found', commit } : null;
  } else if (outcome.result?.kind === 'inconclusive') {
    result = {
      kind: 'inconclusive',
      candidates: outcome.result.candidates.flatMap((c) => bisectCommit(commits, c) ?? []),
    };
  } else if (outcome.result) {
    result = outcome.result;
  }
  const marked =
    head !== null && (b.bad === head || b.good.includes(head) || b.skipped.includes(head));
  const original =
    b.original.kind === 'branch'
      ? b.original.name
      : b.original.kind === 'detached'
        ? sha(b.original.commit)
        : null;
  return {
    bad: b.bad === null ? null : sha(b.bad),
    good: b.good.map(sha),
    skipped: b.skipped.map(sha),
    current: head === null ? null : bisectCommit(commits, head),
    awaitingCheckout: (outcome.remaining ?? 0) > 0 && result === null && marked,
    remaining: outcome.remaining,
    steps: outcome.steps,
    result,
    original,
    firstParent: b.firstParent === true,
  };
}
