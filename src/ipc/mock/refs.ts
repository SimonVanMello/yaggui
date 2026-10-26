import type { YagguiError, RefNameKind, RevisionRelation } from '../bindings';

import type { MockCommit, MockHistory } from '../mockGraph';

/** Errors of the branch, stash and tag commands, with the messages of `git/errors.rs`. */
function mockError(code: YagguiError['code'], en: string, fr: string): YagguiError {
  return { code, message: { en, fr }, action: null, detail: null, payload: null };
}

export function invalidRefName(name: string, kind: RefNameKind): YagguiError {
  const [en, fr] = kind === 'tag' ? ['tag', 'tag'] : ['branch', 'branche'];
  return mockError(
    'invalidRefName',
    `"${name}" is not a valid ${en} name: no spaces, no ~ ^ : ? * [ \\, no "..", and it cannot start with "-" or end with "/", "." or ".lock".`,
    `« ${name} » n'est pas un nom de ${fr} valide : pas d'espace, ni ~ ^ : ? * [ \\, ni « .. », et il ne peut pas commencer par « - » ni finir par « / », « . » ou « .lock ».`,
  );
}

export function refExists(name: string, kind: RefNameKind): YagguiError {
  return kind === 'tag'
    ? mockError(
        'refExists',
        `A tag named "${name}" already exists.`,
        `Un tag « ${name} » existe déjà.`,
      )
    : mockError(
        'refExists',
        `A branch named "${name}" already exists.`,
        `Une branche « ${name} » existe déjà.`,
      );
}

export function dirtyWorktree(paths: string[], canCarry: boolean): YagguiError {
  const error = canCarry
    ? mockError(
        'dirtyWorktree',
        'You have local changes. Stash them, or bring them along to the other branch.',
        "Tu as des modifications locales. Mets-les de côté (stash) ou emporte-les sur l'autre branche.",
      )
    : mockError(
        'dirtyWorktree',
        'Your local changes would be overwritten by the checkout. Stash them first (stash, checkout, then pop).',
        "Tes modifications locales seraient écrasées par le checkout. Mets-les d'abord de côté (stash, checkout puis pop).",
      );
  return { ...error, payload: { kind: 'dirtyWorktree', paths, canCarry } };
}

export function branchNotMerged(name: string): YagguiError {
  return {
    ...mockError(
      'branchNotMerged',
      `The branch "${name}" is not fully merged: deleting it can lose commits. Force the deletion only if you no longer need them.`,
      `La branche « ${name} » n'est pas entièrement mergée : la supprimer peut perdre des commits. Force la suppression seulement si tu n'en as plus besoin.`,
    ),
    action: { kind: 'forceDelete' },
  };
}

export function currentBranch(name: string): YagguiError {
  return mockError(
    'currentBranch',
    `"${name}" is the current branch: check out another branch before deleting it.`,
    `« ${name} » est la branche courante : fais d'abord un checkout d'une autre branche pour la supprimer.`,
  );
}

export function stashConflict(paths: string[], stashSha: string, checkedOut: boolean): YagguiError {
  const error = checkedOut
    ? mockError(
        'stashConflict',
        'The checkout is done, but your stashed changes conflict with this branch. Resolve the conflicts; the stash is kept, drop it once you are done.',
        'Le checkout est fait, mais tes modifications mises de côté entrent en conflit avec cette branche. Résous les conflits ; le stash est conservé, supprime-le quand tu as fini.',
      )
    : mockError(
        'stashConflict',
        'The stash conflicts with your files. Resolve the conflicts; the stash is kept, drop it once you are done.',
        'Le stash entre en conflit avec tes fichiers. Résous les conflits ; le stash est conservé, supprime-le quand tu as fini.',
      );
  return { ...error, payload: { kind: 'stashConflict', paths, stashSha, checkedOut } };
}

export function stashFileConflict(path: string, stashSha: string): YagguiError {
  const error = mockError(
    'stashConflict',
    `"${path}" from the stash conflicts with your version. Resolve the conflict, or undo to get your file back; the stash is untouched.`,
    `« ${path} » du stash entre en conflit avec ta version. Résous le conflit, ou annule pour retrouver ton fichier ; le stash n'est pas modifié.`,
  );
  return {
    ...error,
    payload: { kind: 'stashConflict', paths: [path], stashSha, checkedOut: false },
  };
}

/** `not_in_stash` of `git/errors.rs`. */
export function notInStash(path: string): YagguiError {
  return mockError(
    'invalidArgument',
    `"${path}" is not a file of this stash.`,
    `« ${path} » n'est pas un fichier de ce stash.`,
  );
}

/** `exists`: a file is already at the path; otherwise local changes to the tracked file. */
export function stashFileInTheWay(path: string, exists: boolean): YagguiError {
  const error = exists
    ? mockError(
        'dirtyWorktree',
        `"${path}" already exists in your working tree: the file from the stash would overwrite it. Move or delete it first.`,
        `« ${path} » existe déjà dans ton arbre de travail : le fichier du stash l'écraserait. Déplace-le ou supprime-le d'abord.`,
      )
    : mockError(
        'dirtyWorktree',
        `Your local changes to "${path}" would be overwritten by the file from the stash. Commit, stash or discard them first.`,
        `Tes modifications locales de « ${path} » seraient écrasées par le fichier du stash. Commite-les, mets-les de côté (stash) ou annule-les d'abord.`,
      );
  return { ...error, payload: { kind: 'dirtyWorktree', paths: [path], canCarry: false } };
}

/** `stash_file_missing` of `git/errors.rs`. */
export function stashFileMissing(path: string): YagguiError {
  return mockError(
    'invalidArgument',
    `"${path}" no longer exists on your side: the change the stash holds for it cannot be merged. Open the file in the stash to see its stashed version.`,
    `« ${path} » n'existe plus de ton côté : la modification que le stash garde pour lui ne peut pas y être fusionnée. Ouvre le fichier dans le stash pour voir sa version mise de côté.`,
  );
}

export function nothingToStash(): YagguiError {
  return mockError(
    'nothingToStash',
    'Nothing to stash: you have no local changes.',
    "Rien à mettre de côté : tu n'as aucune modification locale.",
  );
}

export function staleRefs(): YagguiError {
  return {
    ...mockError(
      'staleRefs',
      'The branches or stashes changed in the meantime. Refresh and try again.',
      'Les branches ou les stashes ont changé entre-temps. Rafraîchis puis réessaie.',
    ),
    action: { kind: 'refresh' },
  };
}

/**
 * `git check-ref-format` rules (see git-check-ref-format(1)), for a branch (`--branch`)
 * or a tag name.
 */
export function isValidRefName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('-')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.includes('..') || name.includes('@{')) {
    return false;
  }
  // Control characters, space and ~ ^ : ? * [ \ are refused anywhere.
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ' ~^:?*[\\'.includes(char)) return false;
  }
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Commits reachable from `from` (included). */
export function ancestors(commits: readonly MockCommit[], from: number): Set<number> {
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const commit = stack.pop() ?? -1;
    const parents = commits[commit]?.parents;
    if (seen.has(commit) || !parents) continue;
    seen.add(commit);
    stack.push(...parents);
  }
  return seen;
}

/** How `a` relates to `b`: which one, if any, can be fast-forwarded to the other. */
export function revisionRelation(
  commits: readonly MockCommit[],
  a: number,
  b: number,
): RevisionRelation {
  if (a === b) return 'same';
  if (ancestors(commits, b).has(a)) return 'behind';
  if (ancestors(commits, a).has(b)) return 'ahead';
  return 'diverged';
}

/** The remote of a remote branch short name (`origin/feat/x` → `origin`, `feat/x`). */
export function splitRemoteBranch(
  history: MockHistory,
  name: string,
): { remote: string; branch: string } | null {
  const remote = [...history.remotes]
    .map((r) => r.name)
    .sort((a, b) => b.length - a.length)
    .find((r) => name.startsWith(`${r}/`));
  const fallback = name.indexOf('/');
  if (remote) return { remote, branch: name.slice(remote.length + 1) };
  return fallback > 0
    ? { remote: name.slice(0, fallback), branch: name.slice(fallback + 1) }
    : null;
}
