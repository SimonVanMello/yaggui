import type { RepoRefs } from '../../ipc';
import { fuzzyMatch } from '../welcome/fuzzy';
import type { RefTarget } from '../sidebar/sidebarRows';

export interface BranchChoice {
  /** Short name: `feat/graph`, or `origin/main` for a remote branch. */
  name: string;
  remote: boolean;
  current: boolean;
  target: RefTarget;
  indices: number[];
}

/** Most results the popover renders; the rest is reached by typing more. */
export const MAX_CHOICES = 100;

/** Every local and remote branch of the repository, as picker entries. */
export function allChoices(refs: RepoRefs): BranchChoice[] {
  const choices: BranchChoice[] = refs.local.map((branch) => ({
    name: branch.name,
    remote: false,
    current: branch.isHead,
    target: { kind: 'local', branch },
    indices: [],
  }));
  for (const remote of refs.remotes) {
    for (const branch of remote.branches) {
      choices.push({
        name: branch.name,
        remote: true,
        current: false,
        target: { kind: 'remote', branch, remote: remote.name },
        indices: [],
      });
    }
  }
  return choices;
}

/**
 * Choices for a query. Without a query: recent branches first (most recent first), then the
 * other local branches, then remote ones. With a query: best fuzzy score first, local before
 * remote on ties, recent ones slightly boosted.
 */
export function rankChoices(
  choices: readonly BranchChoice[],
  query: string,
  recent: readonly string[],
): { items: BranchChoice[]; total: number } {
  const recentRank = new Map(recent.map((name, index) => [name, index]));
  let ranked: BranchChoice[];
  if (query.trim() === '') {
    const order = (choice: BranchChoice) =>
      recentRank.get(choice.name) ?? (choice.remote ? recent.length + 1 : recent.length);
    ranked = [...choices].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  } else {
    const scored: { choice: BranchChoice; score: number }[] = [];
    for (const choice of choices) {
      const match = fuzzyMatch(query, choice.name);
      if (!match) continue;
      const boost = recentRank.has(choice.name) ? 3 : 0;
      const score = match.score + boost - (choice.remote ? 1 : 0);
      scored.push({ choice: { ...choice, indices: match.indices }, score });
    }
    scored.sort((a, b) => b.score - a.score || a.choice.name.localeCompare(b.choice.name));
    ranked = scored.map((entry) => entry.choice);
  }
  return { items: ranked.slice(0, MAX_CHOICES), total: ranked.length };
}
