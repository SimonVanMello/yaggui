import type { MockHistory } from './mockGraph';

/** Branch and tag counts of the stress repository (any path containing `many-refs`). */
export const STRESS_LOCAL_BRANCHES = 5_000;
export const STRESS_TAGS = 3_000;

const PEOPLE = ['alice', 'bob', 'chloe', 'david', 'emma', 'farid', 'gina', 'hugo'];
const TOPICS = ['auth', 'billing', 'graph', 'search', 'sync', 'ui', 'perf', 'docs', 'api', 'cli'];
const PACKAGES = ['react', 'vite', 'eslint', 'typescript', 'zustand', 'tauri', 'serde', 'tokio'];

/** Realistic, often nested names: team prefixes, user folders, dependabot paths. */
function branchName(i: number): string {
  const topic = TOPICS[i % TOPICS.length] ?? 'misc';
  const person = PEOPLE[Math.floor(i / 7) % PEOPLE.length] ?? 'dev';
  const pkg = PACKAGES[i % PACKAGES.length] ?? 'dep';
  switch (i % 6) {
    case 0:
      return `feat/${topic}/item-${String(i)}`;
    case 1:
      return `fix/${topic}-${String(i)}`;
    case 2:
      return `users/${person}/${topic}/wip-${String(i)}`;
    case 3:
      return `dependabot/npm_and_yarn/${pkg}-${String(1 + (i % 9))}.${String(i % 13)}.${String(i)}`;
    case 4:
      return `release/${String(1 + Math.floor(i / 600))}.${String(i % 40)}`;
    default:
      return `chore/${topic}-cleanup-${String(i)}`;
  }
}

/**
 * Adds thousands of branches, remote branches and tags on existing commits, to exercise the
 * sidebar virtualization. A few branches track an upstream, some of them gone.
 */
export function addStressRefs(history: MockHistory): void {
  const commits = history.commits.length;
  if (commits === 0) return;
  const at = (i: number) => (i * 7919) % commits;
  const seen = new Set(history.local.map((b) => b.name));
  for (let i = 0; history.local.length < STRESS_LOCAL_BRANCHES; i++) {
    const name = branchName(i);
    if (seen.has(name)) continue;
    seen.add(name);
    const tracked = i % 100 === 1;
    history.local.push({
      name,
      commit: at(i),
      upstream: tracked ? `origin/${name}` : undefined,
    });
    // Every other tracked branch keeps its remote branch; the others are `[gone]`.
    if ((tracked && i % 200 === 1) || i % 3 === 0) {
      history.remote.push({ name: `origin/${name}`, commit: at(i + 1) });
    }
    if (i % 11 === 0) history.remote.push({ name: `upstream/${name}`, commit: at(i + 2) });
  }
  history.remotes.push({ name: 'upstream', url: 'https://github.com/example/many-refs.git' });
  for (let i = 0; history.tags.length < STRESS_TAGS; i++) {
    const major = 1 + Math.floor(i / 400);
    history.tags.push({
      name: `v${String(major)}.${String(Math.floor(i / 20) % 20)}.${String(i % 20)}`,
      commit: at(i + 3),
      message: i % 4 === 0 ? `Release ${String(major)}` : null,
    });
  }
}
