import { REBASE_PLAN_MAX } from '../bindings';
import type {
  AutosquashPlan,
  YagguiError,
  InteractiveRebasePlan,
  RebasePlanCommit,
  RebaseTodoEntry,
} from '../bindings';
import type { MockGraph } from '../mockGraph';
import { invalidHistoryArgument } from './history';
import { ancestors } from './refs';

/** A line of the todo the backend gives Git (`git/ops/rebase_todo.rs`). */
export interface MockTodoLine {
  command: 'pick' | 'edit' | 'fixup' | 'drop';
  commit: number;
  /** Message the commit takes (reword, or the combined message of a squash group). */
  message: string | null;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** Like `normalize_message`: no leading blank lines, no trailing whitespace. */
export function normalizeMockMessage(message: string): string | null {
  const text = message
    .replace(/^[\r\n]+/, '')
    .trimEnd()
    .replace(/\r\n/g, '\n');
  const summary = text.split('\n')[0] ?? '';
  return summary.trim() === '' ? null : text;
}

/** Commits of `base..head`, oldest first, and whether merges are among them. */
export function mockRange(
  graph: MockGraph,
  base: number,
  head: number,
): { ids: number[]; merges: boolean } | YagguiError {
  const { commits } = graph.history;
  if (base === head) return { ids: [], merges: false };
  const reachable = ancestors(commits, head);
  if (!reachable.has(base)) {
    const sha = short(commits[base]?.sha ?? '');
    return invalidHistoryArgument(
      `${sha} is not an ancestor of the current branch.`,
      `${sha} n'est pas un ancêtre de la branche courante.`,
    );
  }
  const hidden = ancestors(commits, base);
  const ids = [...reachable]
    .filter((c) => !hidden.has(c))
    .sort((a, b) => (graph.rowOfCommit(b) ?? 0) - (graph.rowOfCommit(a) ?? 0));
  if (ids.length > REBASE_PLAN_MAX) {
    return invalidHistoryArgument(
      `More than ${REBASE_PLAN_MAX} commits to rebase: choose a more recent base.`,
      `Plus de ${REBASE_PLAN_MAX} commits à rebaser : choisis une base plus récente.`,
    );
  }
  return { ids, merges: ids.some((c) => (commits[c]?.parents.length ?? 0) > 1) };
}

/** `interactiveRebasePlan` of the mock: `base..HEAD` of the current branch. */
export function mockPlan(
  graph: MockGraph,
  branch: string,
  head: number,
  base: number,
): InteractiveRebasePlan | YagguiError {
  const range = mockRange(graph, base, head);
  if ('code' in range) return range;
  const { history } = graph;
  const upstreamName = history.local.find((b) => b.name === branch)?.upstream ?? null;
  const upstream = history.remote.find((b) => b.name === upstreamName);
  const pushed = upstream ? ancestors(history.commits, upstream.commit) : new Set<number>();
  const commits: RebasePlanCommit[] = range.ids.map((c) => {
    const commit = history.commits[c];
    const summary = commit?.summary ?? '';
    const body = commit?.body ?? '';
    return {
      sha: commit?.sha ?? '',
      summary,
      message: body ? `${summary}\n\n${body}` : summary,
      authorName: commit?.authorName ?? '',
      authorEmail: commit?.authorEmail ?? '',
      authorTime: commit?.authorTime ?? 0,
      merge: (commit?.parents.length ?? 0) > 1,
      pushed: pushed.has(c),
    };
  });
  const baseCommit = history.commits[base];
  return {
    base: { sha: baseCommit?.sha ?? '', summary: baseCommit?.summary ?? '' },
    head: history.commits[head]?.sha ?? '',
    branch,
    upstream: upstreamName,
    commits,
    hasMerges: range.merges,
    pushed: commits.filter((c) => c.pushed).length,
  };
}

function stale(): YagguiError {
  return invalidHistoryArgument(
    'The list of commits no longer matches the branch (it changed meanwhile): reload it.',
    'La liste des commits ne correspond plus à la branche (elle a changé entre-temps) : recharge-la.',
  );
}

function squashMessageRequired(): YagguiError {
  return invalidHistoryArgument(
    'The message of a squashed commit is empty.',
    "Le message d'un commit fusionné (squash) est vide.",
  );
}

/** Validates the todo against the range and turns it into lines, like `rebase_todo::plan`. */
export function mockTodo(
  graph: MockGraph,
  range: number[],
  entries: RebaseTodoEntry[],
): MockTodoLine[] | YagguiError {
  if (entries.length === 0) {
    return invalidHistoryArgument(
      'There is no commit to rebase.',
      "Il n'y a aucun commit à rebaser.",
    );
  }
  const { commits } = graph.history;
  const bySha = new Map(range.map((c) => [commits[c]?.sha ?? '', c]));
  const seen = new Set<number>();
  const lines: MockTodoLine[] = [];
  let head: number | null = null;
  let missingMessage = false;
  for (const entry of entries) {
    const commit = bySha.get(entry.sha.trim().toLowerCase());
    if (commit === undefined || seen.has(commit)) return stale();
    seen.add(commit);
    const sha = short(entry.sha);
    switch (entry.action) {
      case 'drop':
        lines.push({ command: 'drop', commit, message: null });
        break;
      case 'pick':
      case 'reword':
      case 'edit': {
        if (missingMessage) return squashMessageRequired();
        let message: string | null = null;
        if (entry.action === 'reword') {
          message = normalizeMockMessage(entry.message ?? '');
          if (message === null) {
            return invalidHistoryArgument(
              `The new message of ${sha} is empty.`,
              `Le nouveau message de ${sha} est vide.`,
            );
          }
        }
        head = lines.length;
        lines.push({ command: entry.action === 'edit' ? 'edit' : 'pick', commit, message });
        break;
      }
      case 'squash':
      case 'fixup': {
        const target = head === null ? undefined : lines[head];
        if (!target) {
          return invalidHistoryArgument(
            `${sha} cannot be squashed or fixed up: there is no kept commit before it.`,
            `${sha} ne peut pas être fusionné (squash / fixup) : aucun commit conservé ne le précède.`,
          );
        }
        if (entry.action === 'squash') {
          const message = normalizeMockMessage(entry.message ?? '');
          if (message === null) missingMessage = true;
          else {
            target.message = message;
            missingMessage = false;
          }
        }
        lines.push({ command: 'fixup', commit, message: null });
        break;
      }
    }
  }
  if (missingMessage) return squashMessageRequired();
  if (seen.size !== range.length) return stale();
  if (head === null) {
    return invalidHistoryArgument(
      'Every commit would be dropped: reset the branch instead.',
      'Tous les commits seraient supprimés : fais plutôt un reset de la branche.',
    );
  }
  return lines;
}

const FIXUP_PREFIX = 'fixup! ';

/** Like `rebase_todo::fixup_subject`: the subject without its `fixup! ` prefixes. */
export function mockFixupSubject(summary: string): string | null {
  if (!summary.startsWith(FIXUP_PREFIX)) return null;
  let rest = summary;
  while (rest.startsWith(FIXUP_PREFIX)) rest = rest.slice(FIXUP_PREFIX.length);
  return rest;
}

/** Like `rebase_todo::autosquash`: the todo order with the fixups under their targets. */
export function mockAutosquash(commits: readonly { sha: string; summary: string }[]): {
  order: { index: number; action: 'pick' | 'fixup' }[];
  unmatched: number[];
} {
  const targets: (number | null)[] = commits.map(() => null);
  const bySummary = new Map<string, number>();
  const unmatched: number[] = [];
  commits.forEach(({ summary }, i) => {
    const subject = mockFixupSubject(summary);
    if (subject !== null) {
      let found: number | undefined;
      if (subject.trim() !== '') {
        const prefix = subject.toLowerCase();
        const earlier = commits.slice(0, i);
        found = bySummary.get(subject);
        if (found === undefined && prefix.length >= 4 && /^[0-9a-f]+$/.test(prefix)) {
          const index = earlier.findIndex((c) => c.sha.startsWith(prefix));
          if (index !== -1) found = index;
        }
        if (found === undefined) {
          const index = earlier.findIndex((c) => c.summary.startsWith(subject));
          if (index !== -1) found = index;
        }
      }
      if (found !== undefined) {
        targets[i] = targets[found] ?? found;
        return;
      }
      unmatched.push(i);
    }
    if (!bySummary.has(summary)) bySummary.set(summary, i);
  });
  const order: { index: number; action: 'pick' | 'fixup' }[] = [];
  targets.forEach((target, i) => {
    if (target !== null) return;
    order.push({ index: i, action: 'pick' });
    targets.forEach((t, k) => {
      if (t === i) order.push({ index: k, action: 'fixup' });
    });
  });
  return { order, unmatched };
}

/**
 * Like `fixup::automatic_base`: parent of the oldest commit a fixup targets, along the first
 * parents of HEAD up to the first merge or root commit.
 */
export function mockAutosquashBase(graph: MockGraph, head: number): number | null {
  const { commits } = graph.history;
  const chain: { id: number; parent: number }[] = [];
  let current = head;
  while (chain.length < REBASE_PLAN_MAX) {
    const parents = commits[current]?.parents ?? [];
    const [parent] = parents;
    if (parents.length !== 1 || parent === undefined) break;
    chain.push({ id: current, parent });
    current = parent;
  }
  chain.reverse();
  const { order } = mockAutosquash(
    chain.map(({ id }) => ({
      sha: commits[id]?.sha ?? '',
      summary: commits[id]?.summary ?? '',
    })),
  );
  const target = order.find((_, i) => order[i + 1]?.action === 'fixup');
  return target ? (chain[target.index]?.parent ?? null) : null;
}

/** `autosquashPlan` of the mock, from the plan of `base..HEAD`. */
export function mockAutosquashPlan(plan: InteractiveRebasePlan): AutosquashPlan {
  const { order, unmatched } = mockAutosquash(plan.commits);
  return {
    plan,
    todo: order.map(({ index, action }) => ({
      sha: plan.commits[index]?.sha ?? '',
      action,
      message: null,
    })),
    unmatched: unmatched.map((i) => plan.commits[i]?.sha ?? ''),
    fixups: order.filter((entry) => entry.action === 'fixup').length,
  };
}
