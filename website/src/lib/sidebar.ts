import type { DocsVersion } from './docs-versions';

/** Label of the hidden top-level sidebar group that holds the pages of one version. */
export function sidebarGroupLabel(v: DocsVersion): string {
  return `__version:${v.id}`;
}
