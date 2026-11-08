/** Longest display name of a repository, in characters (the backend checks it too). */
export const MAX_REPO_NAME_LENGTH = 60;

export type RepoNameCheck =
  | { ok: true; /** Trimmed; empty gives back the folder name. */ name: string }
  | { ok: false; reason: 'tooLong' };

/** Validates a name typed in "Rename…": spaces around it do not count, empty is allowed. */
export function checkRepoName(input: string): RepoNameCheck {
  const name = input.trim();
  // Characters, not UTF-16 units: an emoji or an accented letter counts once, like in Rust.
  if (Array.from(name).length > MAX_REPO_NAME_LENGTH) return { ok: false, reason: 'tooLong' };
  return { ok: true, name };
}

/** Last component of a path: the default display name of a repository. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}
