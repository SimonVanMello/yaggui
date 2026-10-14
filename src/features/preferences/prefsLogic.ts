import type { ConfirmationKind } from '../../ipc';

/** Protected-branch list after typing `input`: trimmed, no duplicates, no spaces. */
export function addProtectedBranch(list: readonly string[], input: string): string[] {
  const pattern = input.trim();
  if (!pattern || /\s/.test(pattern) || list.includes(pattern)) return [...list];
  return [...list, pattern];
}

export function removeProtectedBranch(list: readonly string[], pattern: string): string[] {
  return list.filter((entry) => entry !== pattern);
}

/** Whether `input` can be added: non-empty, without spaces, not already there. */
export function canAddProtectedBranch(list: readonly string[], input: string): boolean {
  return addProtectedBranch(list, input).length > list.length;
}

export function setConfirmation(
  disabled: readonly ConfirmationKind[],
  kind: ConfirmationKind,
  enabled: boolean,
): ConfirmationKind[] {
  // The force push confirmation cannot be turned off (the backend refuses it too).
  if (kind === 'forcePush') return disabled.filter((entry) => entry !== 'forcePush');
  const rest = disabled.filter((entry) => entry !== kind);
  return enabled ? rest : [...rest, kind];
}

/** Integer in `[min, max]` from a text field; `fallback` when it is not a number. */
export function clampInt(text: string, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(text.trim(), 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export type GitStatus =
  | { kind: 'checking' }
  | { kind: 'ok'; version: string; path: string }
  | { kind: 'old'; version: string; path: string; min: string }
  | { kind: 'error'; reason: 'notFound' | 'invalid' };

export interface GitInfoLike {
  path: string | null;
  version: string | null;
  supported: boolean;
  minVersion: string;
  error: { code: string } | null;
}

/** What the Git path field says about the binary. */
export function gitStatus(info: GitInfoLike): GitStatus {
  if (info.error || info.version === null) {
    return {
      kind: 'error',
      reason: info.error?.code === 'gitNotFound' ? 'notFound' : 'invalid',
    };
  }
  const path = info.path ?? '';
  return info.supported
    ? { kind: 'ok', version: info.version, path }
    : { kind: 'old', version: info.version, path, min: info.minVersion };
}
