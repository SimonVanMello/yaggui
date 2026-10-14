import type { ErrorCode, YagguiError } from '../../ipc';

/**
 * Failures the refs UI presents itself (dialogs, inline messages, warnings): the generic
 * `op-finished` failure toast stays out of the way, `refOps` falls back to a toast for the
 * ones no dialog takes.
 */
const HANDLED_CODES: ReadonlySet<ErrorCode> = new Set([
  'invalidRefName',
  'refExists',
  'dirtyWorktree',
  'branchNotMerged',
  'currentBranch',
  'stashConflict',
  'nothingToStash',
  'staleRefs',
]);

export function isRefUiError(error: YagguiError): boolean {
  return HANDLED_CODES.has(error.code);
}
