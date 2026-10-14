/** Tiles of the graph canvas: bands of `tileHeight` px of the scrolled content, tile `k` covering `[k·h, (k+1)·h)`. */

/** Tiles intersecting `[top - margin, top + viewport + margin]`, clamped to the content. */
export function neededTiles(
  scrollTop: number,
  viewportHeight: number,
  margin: number,
  tileHeight: number,
  contentHeight: number,
): number[] {
  if (tileHeight <= 0 || contentHeight <= 0) return [];
  const last = Math.ceil(contentHeight / tileHeight) - 1;
  const from = Math.max(0, Math.floor((scrollTop - margin) / tileHeight));
  const to = Math.min(last, Math.floor((scrollTop + viewportHeight + margin) / tileHeight));
  const out: number[] = [];
  for (let k = from; k <= to; k++) out.push(k);
  return out;
}

/**
 * Assigns the needed tiles to canvas slots. `current[i]` is the tile slot `i` shows (`null`:
 * none). A slot already showing a needed tile keeps it; the others take the missing tiles.
 * Returns the new assignment and the slots to redraw (all of them when `force`).
 */
export function assignTiles(
  current: readonly (number | null)[],
  needed: readonly number[],
  force: boolean,
): { tiles: (number | null)[]; redraw: number[] } {
  const wanted = new Set(needed);
  const tiles = current.map((tile) => (tile !== null && wanted.has(tile) ? tile : null));
  const shown = new Set(tiles);
  const redraw: number[] = [];
  for (const tile of needed) {
    if (shown.has(tile)) continue;
    const slot = tiles.indexOf(null);
    if (slot < 0) break;
    tiles[slot] = tile;
    redraw.push(slot);
  }
  if (force) {
    redraw.length = 0;
    tiles.forEach((tile, slot) => {
      if (tile !== null) redraw.push(slot);
    });
  }
  return { tiles, redraw };
}
