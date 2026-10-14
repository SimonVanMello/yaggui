/** Conventional Commits helper of the commit panel (F-067): `type(scope)!: subject`. */

/** Types offered first, in this order (from the Conventional Commits and Angular lists). */
export const CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export interface Conventional {
  type: string;
  scope: string;
  breaking: boolean;
  subject: string;
}

const HEADER = /^([a-z][a-z0-9-]*)(?:\(([^()\n]*)\))?(!)?:[ \t]?(.*)$/;

/** `null` when the summary does not start with `type:` or `type(scope):`. */
export function parseConventional(summary: string): Conventional | null {
  const match = HEADER.exec(summary);
  if (!match) return null;
  return {
    type: match[1] ?? '',
    scope: match[2] ?? '',
    breaking: match[3] === '!',
    subject: match[4] ?? '',
  };
}

export function formatConventional(c: Conventional): string {
  const scope = c.scope.trim() ? `(${c.scope.trim()})` : '';
  return `${c.type}${scope}${c.breaking ? '!' : ''}: ${c.subject}`;
}

/** The summary with its header changed; a plain summary becomes the subject. */
export function withHeader(
  summary: string,
  change: Partial<Omit<Conventional, 'subject'>>,
): string {
  const current = parseConventional(summary) ?? {
    type: 'feat',
    scope: '',
    breaking: false,
    subject: summary,
  };
  return formatConventional({ ...current, ...change });
}

/** Scopes of recent messages, most used first (ties: most recent first). */
export function recentScopes(messages: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const scope = parseConventional(message.split('\n', 1)[0] ?? '')?.scope.trim();
    if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([scope]) => scope);
}

/** Length of the subject alone, as the user counts characters. */
export function subjectLength(summary: string): number {
  return Array.from(parseConventional(summary)?.subject ?? summary).length;
}
