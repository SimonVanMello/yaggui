/** Stable lane color for a repository name, used as its identity dot in tabs and lists. */
export function repoColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `var(--lane-${hash % 8})`;
}
