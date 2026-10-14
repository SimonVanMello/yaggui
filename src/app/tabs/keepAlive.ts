/**
 * How many tab views stay mounted (the active one included). The others are unmounted and
 * rebuilt from their stores when shown again. Each kept view holds its DOM and React tree in
 * memory, so this bounds the memory traded for the switch speed (P-07).
 */
export const KEEP_ALIVE_TABS = 3;

/**
 * Tab ids whose view stays mounted, most recently shown first: the active tab, then the tabs
 * last shown before it that are still open and `keepable`, within `limit`.
 */
export function touchRecent(
  recent: readonly string[],
  activeId: string,
  keepable: ReadonlySet<string>,
  limit: number = KEEP_ALIVE_TABS,
): string[] {
  const next = [activeId];
  for (const id of recent) {
    if (next.length >= limit) break;
    if (id !== activeId && keepable.has(id)) next.push(id);
  }
  return next;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
