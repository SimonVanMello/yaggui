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
        // A `fixup` with a message is `fixup -C`: it gives the group its message.
        if (entry.action === 'squash' || entry.message !== null) {
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

/** How an autosquashed commit melds into its target (`rebase_todo::Meld`). */
export type MockMeld = 'fixup' | 'amend' | 'squash';

const MELD_PREFIXES: readonly (readonly [string, MockMeld])[] = [
  ['fixup! ', 'fixup'],
  ['amend! ', 'amend'],
  ['squash! ', 'squash'],
];

function skipMeldPrefix(subject: string): [MockMeld, string] | null {
  for (const [prefix, meld] of MELD_PREFIXES) {
    if (subject.startsWith(prefix)) return [meld, subject.slice(prefix.length)];
  }
  return null;
}

/** Like `rebase_todo::meld_subject`: the kind (first prefix) and the subject, every prefix skipped. */
export function mockMeldSubject(summary: string): { meld: MockMeld; subject: string } | null {
  const first = skipMeldPrefix(summary.trim());
  if (!first) return null;
  let rest = first[1];
  for (;;) {
    rest = rest.replace(/^[ \t\r\n]+/, '');
    const next = skipMeldPrefix(rest);
    if (!next) return { meld: first[0], subject: rest };
    rest = next[1];
  }
}

/** Like `rebase_todo::without_subject`: the message below its subject paragraph. */
export function mockWithoutSubject(message: string): string {
  const blank = /\n[ \t]*(\r?\n|$)/.exec(message);
  return blank ? message.slice(blank.index).trim() : '';
}

export type MockAutosquashStep = 'pick' | MockMeld;

/** Like `rebase_todo::autosquash`: Git's todo order, each melded commit under its target. */
export function mockAutosquash(
  commits: readonly { sha: string; summary: string }[],
  resolve: (name: string) => string | null = () => null,
): {
  order: { index: number; action: MockAutosquashStep }[];
  unmatched: number[];
} {
  const next: (number | null)[] = commits.map(() => null);
  const tail: (number | null)[] = commits.map(() => null);
  const steps: MockAutosquashStep[] = commits.map(() => 'pick');
  const bySummary = new Map<string, number>();
  const unmatched: number[] = [];
  commits.forEach(({ summary: raw }, i) => {
    const summary = raw.trim();
    const meld = mockMeldSubject(summary);
    let target: number | undefined;
    if (meld) {
      const { subject } = meld;
      target = bySummary.get(subject);
      if (target === undefined && !subject.includes(' ')) {
        const sha = resolve(subject);
        const index = sha === null ? -1 : commits.slice(0, i).findIndex((c) => c.sha === sha);
        if (index !== -1) target = index;
      }
      if (target === undefined) {
        const index = commits.slice(0, i).findIndex((c) => c.summary.trim().startsWith(subject));
        if (index !== -1) target = index;
      }
      if (target === undefined) unmatched.push(i);
      else {
        steps[i] = meld.meld;
        const after = tail[target] ?? target;
        next[i] = next[after] ?? null;
        next[after] = i;
        tail[target] = i;
      }
    }
    if (target === undefined && !bySummary.has(summary)) bySummary.set(summary, i);
  });
  const order: { index: number; action: MockAutosquashStep }[] = [];
  steps.forEach((step, i) => {
    if (step !== 'pick') return;
    for (let k: number | null = i; k !== null; k = next[k] ?? null) {
      order.push({ index: k, action: steps[k] ?? 'pick' });
    }
  });
  return { order, unmatched };
}

/** A SHA prefix of 4 digits or more, or a ref of the mock (`resolve_name`). */
function nameResolver(graph: MockGraph): (name: string) => string | null {
  return (name) => {
    if (name === '' || name.startsWith(':')) return null;
    const lower = name.toLowerCase();
    if (/^[0-9a-f]+$/.test(lower)) {
      if (lower.length < 4) return null;
      const hit = graph.history.commits.find((c) => c.sha.startsWith(lower));
      return hit?.sha ?? null;
    }
    const commit = graph.resolve(name);
    return commit === null ? null : (graph.history.commits[commit]?.sha ?? null);
  };
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
    nameResolver(graph),
  );
  const target = order.find((_, i) => (order[i + 1]?.action ?? 'pick') !== 'pick');
  return target ? (chain[target.index]?.parent ?? null) : null;
}

/** `autosquashPlan` of the mock, from the plan of `base..HEAD`. */
export function mockAutosquashPlan(plan: InteractiveRebasePlan, graph: MockGraph): AutosquashPlan {
  const { order, unmatched } = mockAutosquash(plan.commits, nameResolver(graph));
  return {
    plan,
    todo: order.map(({ index, action }) => {
      const commit = plan.commits[index];
      return {
        sha: commit?.sha ?? '',
        action: action === 'pick' ? 'pick' : action === 'squash' ? 'squash' : 'fixup',
        // `fixup -C`: the message the `amend!` commit carries below its subject.
        message: action === 'amend' ? mockWithoutSubject(commit?.message ?? '') : null,
      };
    }),
    unmatched: unmatched.map((i) => plan.commits[i]?.sha ?? ''),
    fixups: order.filter((entry) => entry.action !== 'pick').length,
  };
}
