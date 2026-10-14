import type { RefLabel } from '../../ipc';

export type DisplayRefKind = 'head' | 'local' | 'remote' | 'tag' | 'stash';

/** A label as shown on a row: a local branch absorbs its remote at the same commit (F-023). */
export interface DisplayRef {
  key: string;
  kind: DisplayRefKind;
  name: string;
  /** Checked out branch, or detached HEAD. */
  isHead: boolean;
  /** Remote branch merged into this local label (`origin/main`). */
  remote: string | null;
  /** Branch name a checkout would use (`null` for tags and stashes). */
  branch: string | null;
}

const ORDER: Record<DisplayRefKind, number> = { head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

/** Remote part of `origin/feat/x` matching a local branch `feat/x`. */
function sameShortName(remote: string, local: string): boolean {
  const slash = remote.indexOf('/');
  return slash > 0 && remote.slice(slash + 1) === local;
}

export function displayRefs(labels: readonly RefLabel[]): DisplayRef[] {
  const remotes = labels.filter((l) => l.kind === 'remoteBranch');
  const merged = new Set<string>();
  const out: DisplayRef[] = [];

  for (const label of labels) {
    if (label.kind !== 'localBranch') continue;
    const remote =
      remotes.find((r) => !merged.has(r.name) && r.name === label.upstream) ??
      remotes.find((r) => !merged.has(r.name) && sameShortName(r.name, label.name));
    if (remote) merged.add(remote.name);
    out.push({
      key: label.fullName,
      kind: 'local',
      name: label.name,
      isHead: label.isHead,
      remote: remote?.name ?? null,
      branch: label.name,
    });
  }
  for (const label of labels) {
    switch (label.kind) {
      case 'localBranch':
        break;
      case 'remoteBranch':
        if (!merged.has(label.name)) {
          out.push({
            key: label.fullName,
            kind: 'remote',
            name: label.name,
            isHead: false,
            remote: null,
            branch: label.name,
          });
        }
        break;
      case 'head':
        out.push({
          key: 'HEAD',
          kind: 'head',
          name: label.name,
          isHead: true,
          remote: null,
          branch: null,
        });
        break;
      case 'tag':
        out.push({
          key: label.fullName,
          kind: 'tag',
          name: label.name,
          isHead: false,
          remote: null,
          branch: null,
        });
        break;
      case 'stash':
        out.push({
          key: `${label.fullName}:${label.name}`,
          kind: 'stash',
          name: label.name,
          isHead: false,
          remote: null,
          branch: null,
        });
        break;
    }
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || Number(b.isHead) - Number(a.isHead));
}

/** Splits labels into the ones shown and the overflow (`+N`), keeping HEAD visible. */
export function splitOverflow(
  refs: readonly DisplayRef[],
  max: number,
): { shown: DisplayRef[]; hidden: DisplayRef[] } {
  if (refs.length <= max) return { shown: [...refs], hidden: [] };
  // One slot goes to the `+N` chip.
  const keep = Math.max(1, max - 1);
  return { shown: refs.slice(0, keep), hidden: refs.slice(keep) };
}
