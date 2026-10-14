import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import type { DiffLine } from './diffModel';

/** Natural height in pixels of the rendered lines, by row (line index). */
export type RowHeights = ReadonlyMap<number, number>;
/** Extra space in pixels to leave after a row, by row. */
export type Spacers = ReadonlyMap<number, number>;

export interface SpacerPair {
  a: Spacers;
  b: Spacers;
}

/** Below this difference (px) two rows count as aligned: avoids chasing sub-pixel rounding. */
export const HEIGHT_EPSILON = 0.5;

const EMPTY: Spacers = new Map();
export const NO_SPACERS: SpacerPair = { a: EMPTY, b: EMPTY };

/**
 * Spacers that make the rows measured on both sides equally tall: the shorter side gets the
 * difference. Rows measured on one side only keep their previous spacer. Returns `previous`
 * itself when nothing changed, so callers can skip the update.
 */
export function mergeSpacers(
  previous: SpacerPair,
  heightsA: RowHeights,
  heightsB: RowHeights,
): SpacerPair {
  const a = new Map(previous.a);
  const b = new Map(previous.b);
  const state = { changed: false };
  const set = (target: Map<number, number>, row: number, value: number | undefined) => {
    const before = target.get(row);
    if (value === undefined) {
      if (before !== undefined) {
        target.delete(row);
        state.changed = true;
      }
    } else if (before === undefined || Math.abs(before - value) >= HEIGHT_EPSILON) {
      target.set(row, value);
      state.changed = true;
    }
  };
  for (const [row, heightA] of heightsA) {
    const heightB = heightsB.get(row);
    if (heightB === undefined) continue;
    const difference = heightA - heightB;
    set(a, row, difference < -HEIGHT_EPSILON ? -difference : undefined);
    set(b, row, difference > HEIGHT_EPSILON ? difference : undefined);
  }
  return state.changed ? { a, b } : previous;
}

/** Replaces the spacers of one editor. */
export const setSpacers = StateEffect.define<Spacers>();

const spacerField = StateField.define<Spacers>({
  create: () => EMPTY,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setSpacers)) return effect.value;
    return value;
  },
});

class Spacer extends WidgetType {
  constructor(
    readonly height: number,
    readonly className: string,
  ) {
    super();
  }

  override eq(other: Spacer): boolean {
    return other.height === this.height && other.className === this.className;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = this.className;
    el.style.height = `${String(this.height)}px`;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  override get estimatedHeight(): number {
    return this.height;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const SPACER_CLASS: Record<DiffLine['kind'], string> = {
  add: 'yaggui-spacer yaggui-add',
  del: 'yaggui-spacer yaggui-del',
  empty: 'yaggui-spacer yaggui-empty',
  context: 'yaggui-spacer',
};

/** Block widgets after the wrapped rows' shorter counterparts; part of the editor state. */
export function spacerExtension(lines: readonly DiffLine[]) {
  return [
    spacerField,
    EditorView.decorations.compute([spacerField], (state): DecorationSet => {
      const spacers = state.field(spacerField);
      if (spacers.size === 0) return Decoration.none;
      const ranges = [];
      for (const [row, height] of spacers) {
        if (row >= state.doc.lines) continue;
        const kind = lines[row]?.kind ?? 'context';
        ranges.push(
          Decoration.widget({
            widget: new Spacer(height, SPACER_CLASS[kind]),
            block: true,
            side: 1,
          }).range(state.doc.line(row + 1).to),
        );
      }
      return Decoration.set(ranges, true);
    }),
  ];
}

/** Heights of the lines currently rendered (the viewport), not of the whole document. */
export function renderedRowHeights(view: EditorView): Map<number, number> {
  const heights = new Map<number, number>();
  for (const element of view.contentDOM.children) {
    if (!element.classList.contains('cm-line')) continue;
    const height = element.getBoundingClientRect().height;
    if (height <= 0) continue;
    heights.set(view.state.doc.lineAt(view.posAtDOM(element)).number - 1, height);
  }
  return heights;
}

/**
 * Keeps the rows of two wrapped editors the same height: a line that wraps on one side
 * leaves the same space on the other. Natural line heights are measured on the rendered
 * lines only, so the cost does not depend on the size of the diff.
 */
export interface HeightSync {
  /** To call when the geometry of either editor may have changed. */
  notify: () => void;
  attach: (a: EditorView, b: EditorView) => void;
  /** Forgets the spacers (wrapping was toggled) and measures again. */
  reset: () => void;
  destroy: () => void;
}

export function createHeightSync(): HeightSync {
  let views: [EditorView, EditorView] | null = null;
  let spacers = NO_SPACERS;
  let destroyed = false;
  const key = {};

  const apply = (next: SpacerPair) => {
    spacers = next;
    // Dispatching is not allowed while the measure cycle runs: do it right after, before paint.
    queueMicrotask(() => {
      if (destroyed || !views) return;
      views[0].dispatch({ effects: setSpacers.of(next.a) });
      views[1].dispatch({ effects: setSpacers.of(next.b) });
    });
  };

  const notify = () => {
    if (!views) return;
    const [a, b] = views;
    a.requestMeasure({
      key,
      read: () => ({ heightsA: renderedRowHeights(a), heightsB: renderedRowHeights(b) }),
      write: ({ heightsA, heightsB }) => {
        if (destroyed) return;
        const next = mergeSpacers(spacers, heightsA, heightsB);
        if (next !== spacers) apply(next);
      },
    });
  };

  return {
    notify,
    attach(a, b) {
      views = [a, b];
      notify();
    },
    reset() {
      if (spacers !== NO_SPACERS) apply(NO_SPACERS);
      notify();
    },
    destroy() {
      destroyed = true;
      views = null;
    },
  };
}
