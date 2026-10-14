import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { GRAPH_COLORS } from '../../ipc';
import { useThemeStore } from '../../theme/themeStore';
import { drawScene, type GraphPalette } from './drawGraph';
import type { GraphSource } from './graphSource';
import { buildScene } from './scene';
import type { ScrollMapper } from './scrollMapper';
import { assignTiles, neededTiles } from './tiles';
import styles from './GraphCanvas.module.css';

interface Props {
  source: GraphSource;
  /** Logical ↔ physical scroll offsets; tiles are laid out in logical offsets. */
  mapper: ScrollMapper;
  scrollRef: RefObject<HTMLDivElement | null>;
  rowHeight: number;
  /** Height of the WIP row above row 0 (0 when hidden). */
  wipHeight: number;
  width: number;
  viewportHeight: number;
  totalRows: number;
  /** Changes whenever the drawn data may have changed (pages, selection…). */
  dataVersion: number;
}

function readPalette(): GraphPalette {
  const style = getComputedStyle(document.documentElement);
  const lanes: string[] = [];
  for (let i = 0; i < GRAPH_COLORS; i++)
    lanes.push(style.getPropertyValue(`--lane-${String(i)}`).trim());
  return {
    lanes,
    background: style.getPropertyValue('--bg-app').trim(),
    selected: style.getPropertyValue('--bg-selected').trim(),
  };
}

/** Canvases in the pool: the viewport plus its margins spans at most three tiles. */
const SLOTS = 4;

/**
 * Lanes and nodes on Canvas 2D tiles of about one viewport, positioned in the scrolled content:
 * they scroll natively with the rows (no tearing). While scrolling, only the tile entering the
 * margin is drawn, into the canvas of a tile that left it; every tile is redrawn when pages
 * arrive or the theme/selection changes. A tile costs its draw and the upload of its bitmap,
 * so small tiles keep each frame's share low.
 */
export function GraphCanvas({
  source,
  mapper,
  scrollRef,
  rowHeight,
  wipHeight,
  width,
  viewportHeight,
  totalRows,
  dataVersion,
}: Props) {
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const tiles = useRef<(number | null)[]>(Array.from({ length: SLOTS }, () => null));
  /** Physical y each slot is placed at (`null`: unknown). */
  const placed = useRef<(number | null)[]>(Array.from({ length: SLOTS }, () => null));
  const theme = useThemeStore((state) => state.theme);
  const palette = useRef<GraphPalette | null>(null);
  // A whole number of rows, so a row never straddles two tiles' worth of rounding.
  const tileHeight = Math.max(rowHeight, Math.ceil(viewportHeight / rowHeight) * rowHeight);

  const drawTile = useCallback(
    (canvas: HTMLCanvasElement, tile: number) => {
      const contentHeight = wipHeight + totalRows * rowHeight;
      const top = tile * tileHeight;
      const height = Math.max(1, Math.min(tileHeight, contentHeight - top));
      const ratio = window.devicePixelRatio || 1;
      if (
        canvas.width !== Math.round(width * ratio) ||
        canvas.height !== Math.round(height * ratio)
      ) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = `${String(width)}px`;
        canvas.style.height = `${String(height)}px`;
      }
      canvas.style.visibility = 'visible';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      palette.current ??= readPalette();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const first = Math.max(0, Math.floor((top - wipHeight) / rowHeight));
      const last = Math.min(totalRows - 1, Math.ceil((top + height - wipHeight) / rowHeight));
      const selection = source.selection;
      const scene = buildScene({
        first,
        last,
        rowHeight,
        wipHeight,
        top,
        rowAt: (row) => source.cache.row(row),
        edgesAt: (row) => source.cache.edgesOf(row),
        wip: source.cache.wip,
        selectedRow: selection?.kind === 'commit' ? selection.row : null,
        wipSelected: selection?.kind === 'wip',
      });
      drawScene(ctx, scene, palette.current, width, height);
    },
    [source, rowHeight, wipHeight, width, totalRows, tileHeight],
  );

  const draw = useCallback(
    (force: boolean) => {
      const scroller = scrollRef.current;
      if (!scroller || viewportHeight <= 0 || width <= 0) return;
      const needed = neededTiles(
        mapper.sync(scroller),
        viewportHeight,
        tileHeight / 4,
        tileHeight,
        wipHeight + totalRows * rowHeight,
      );
      const plan = assignTiles(tiles.current, needed, force);
      tiles.current = plan.tiles;
      plan.tiles.forEach((tile, slot) => {
        const canvas = canvasRefs.current[slot];
        if (canvas && tile === null) canvas.style.visibility = 'hidden';
      });
      for (const slot of plan.redraw) {
        const canvas = canvasRefs.current[slot];
        const tile = plan.tiles[slot];
        if (canvas && tile !== undefined && tile !== null) drawTile(canvas, tile);
      }
      // Tiles sit at their logical offset minus the mapper's: moved when either changes.
      plan.tiles.forEach((tile, slot) => {
        const canvas = canvasRefs.current[slot];
        if (!canvas || tile === null) return;
        const y = tile * tileHeight - mapper.offset;
        if (placed.current[slot] === y) return;
        placed.current[slot] = y;
        canvas.style.transform = `translateY(${String(y)}px)`;
      });
    },
    [
      scrollRef,
      mapper,
      viewportHeight,
      width,
      tileHeight,
      wipHeight,
      totalRows,
      rowHeight,
      drawTile,
    ],
  );

  // Colors are re-read after a theme change (the attribute is set before the store notifies).
  useLayoutEffect(() => {
    palette.current = null;
  }, [theme]);

  useLayoutEffect(() => {
    draw(true);
  }, [draw, dataVersion, theme]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      draw(false);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [draw, scrollRef]);

  return (
    <>
      {Array.from({ length: SLOTS }, (_, slot) => (
        <canvas
          key={slot}
          ref={(canvas) => {
            canvasRefs.current[slot] = canvas;
          }}
          aria-hidden="true"
          className={styles.tile}
        />
      ))}
    </>
  );
}
