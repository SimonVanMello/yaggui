export interface PickModifiers {
  /** `Shift`: extends from the anchor. */
  shift: boolean;
  /** `⌘` / `Ctrl`: toggles one file. */
  toggle: boolean;
}

export interface Picked {
  paths: ReadonlySet<string>;
  /** Fixed end of a `Shift` range. */
  anchor: string | null;
  /** File open in the diff when the picks were made: they apply only while it is unchanged. */
  base: string | null;
}

export const NO_PICKS: Picked = { paths: new Set(), anchor: null, base: null };

/**
 * Files the next action applies to: the picked ones, else the file open in the diff. Picks
 * made before the open file changed (`j`/`k` in the diff, another list) no longer count, and
 * files that left the list are dropped.
 */
export function effectivePaths(
  picked: Picked,
  openPath: string | null,
  present: ReadonlySet<string>,
): ReadonlySet<string> {
  const base = picked.paths.size > 0 && picked.base === openPath ? picked.paths : null;
  const paths = base ?? (openPath ? new Set([openPath]) : new Set<string>());
  return new Set([...paths].filter((path) => present.has(path)));
}

/**
 * New picks after a click on `path`. `order` is the files as listed (what the user sees:
 * collapsed folders excluded), `current` the effective picks before the click.
 */
export function pick(
  order: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  path: string,
  modifiers: PickModifiers,
  openPath: string | null,
): Picked {
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(path);
  if (modifiers.shift && from >= 0 && to >= 0) {
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    const paths = new Set(modifiers.toggle ? [...current, ...range] : range);
    return { paths, anchor, base: openPath };
  }
  if (modifiers.toggle) {
    const paths = new Set(current);
    if (!paths.delete(path)) paths.add(path);
    return { paths, anchor: path, base: openPath };
  }
  return { paths: new Set([path]), anchor: path, base: openPath };
}

/**
 * Files an action started on `clicked` applies to: the whole selection when `clicked` is part
 * of it, else just `clicked`. Keeps the list order.
 */
export function actionTargets<T extends { path: string }>(
  files: readonly T[],
  selected: ReadonlySet<string>,
  clicked: string,
): T[] {
  if (!selected.has(clicked)) return files.filter((f) => f.path === clicked);
  return files.filter((f) => selected.has(f.path));
}

/** File to move to once `acted` left the list: the next one below, else the last above. */
export function nextAfter(order: readonly string[], acted: ReadonlySet<string>): string | null {
  let last = -1;
  order.forEach((path, i) => {
    if (acted.has(path)) last = i;
  });
  if (last < 0) return null;
  for (let i = last + 1; i < order.length; i++) {
    const path = order[i];
    if (path !== undefined && !acted.has(path)) return path;
  }
  for (let i = last - 1; i >= 0; i--) {
    const path = order[i];
    if (path !== undefined && !acted.has(path)) return path;
  }
  return null;
}
