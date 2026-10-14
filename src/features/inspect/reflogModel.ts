/** `checkout: moving from a to b` → action `checkout`, detail `moving from a to b`. */
export function splitReflogMessage(message: string): { action: string; detail: string } {
  const colon = message.indexOf(': ');
  if (colon < 0) return { action: '', detail: message };
  return { action: message.slice(0, colon), detail: message.slice(colon + 2) };
}

/** `HEAD@{3}`, `main@{0}`: how Git names an entry. */
export function reflogSelector(reference: string, index: number): string {
  const name = reference.replace(/^refs\/(heads|remotes)\//, '');
  return `${name}@{${String(index)}}`;
}

/**
 * A reset restores an entry only on the reference it moves: HEAD, or the checked-out branch.
 * Other branches' entries can be restored as a new branch.
 */
export function canResetTo(reference: string, currentBranch: string | null): boolean {
  if (reference === 'HEAD') return true;
  return currentBranch !== null && reference === `refs/heads/${currentBranch}`;
}
