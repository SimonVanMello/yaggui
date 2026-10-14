import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';

import { useT } from '../../i18n/useT';
import type { DiffViewMode, HunkSelection, TextDiff } from '../../ipc';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { adjacentStop, changeStarts, splitModel, unifiedModel, type DiffLine } from './diffModel';
import {
  createDiffEditor,
  revealLine,
  setSelectedRows,
  showCursorRow,
  topLine,
  type DiffEditor,
  type EditorLabels,
  type HunkActionDef,
  type HunkActionKind,
  type PressModifiers,
} from './editor';
import { createHeightSync, type HeightSync } from './heightSync';
import {
  applySelectionKey,
  rowRange,
  selectableRows,
  selectedLineCount,
  selectionToHunks,
  wholeHunk,
  type SelectionKey,
} from './lineSelection';
import styles from './CodeDiff.module.css';

export interface CodeDiffHandle {
  /** Moves to the next (1) or previous (-1) change; `false` at the end. */
  navigate: (direction: 1 | -1) => boolean;
  /** Clears the line selection; `false` when there was none. */
  clearSelection: () => boolean;
}

/** What a hunk action or the line selection bar asks the parent to apply. */
export type HunksHandler = (
  action: HunkActionKind,
  hunks: HunkSelection[],
  lineCount: number,
) => void;

const NO_ROWS: ReadonlySet<number> = new Set();

interface CodeDiffProps {
  diff: TextDiff;
  view: DiffViewMode;
  path: string;
  /** Index / working tree diffs get hunk and line actions. */
  worktree: 'staged' | 'unstaged' | null;
  /** Applies hunks of the diff on screen (stage, unstage or discard). */
  onHunks?: HunksHandler;
  /** Why hunk and line actions are unavailable right now (e.g. whitespace ignored). */
  actionsDisabled?: string | null;
  /** Soft-wrap long lines (the two columns of a split view stay aligned). */
  wrap?: boolean;
  /** The line selection is dropped when this changes (e.g. the diff options). */
  resetKey?: string;
  ref?: Ref<CodeDiffHandle>;
}

/** Ends the P-06 measure started by `openDiff`: selection → first frame with the diff. */
function measureRender() {
  requestAnimationFrame(() => {
    if (performance.getEntriesByName('yaggui:diff-select', 'mark').length === 0) return;
    performance.measure('yaggui:diff-render', 'yaggui:diff-select');
    performance.clearMarks('yaggui:diff-select');
  });
}

/** Unified or side-by-side code of a text diff, on read-only CodeMirror views. */
export function CodeDiff({
  diff,
  view,
  path,
  worktree,
  onHunks,
  actionsDisabled = null,
  wrap = false,
  resetKey = '',
  ref,
}: CodeDiffProps) {
  const t = useT();
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const editors = useRef<DiffEditor[]>([]);
  const current = useRef<number | null>(null);

  const model = useMemo(
    () =>
      view === 'split'
        ? { kind: 'split' as const, ...splitModel(diff) }
        : { kind: 'unified' as const, ...unifiedModel(diff) },
    [diff, view],
  );
  const stops = useMemo(
    () => changeStarts(model.kind === 'split' ? mergeSides(model.left, model.right) : model.lines),
    [model],
  );

  const sides = useMemo(
    () => (model.kind === 'split' ? [model.left, model.right] : [model.lines]),
    [model],
  );
  const selectable = useMemo(
    () =>
      worktree && onHunks
        ? new Set(
            model.kind === 'split'
              ? selectableRows(model.left, model.right)
              : selectableRows(model.lines),
          )
        : undefined,
    [model, worktree, onHunks],
  );

  // The selection belongs to one diff: a refreshed diff (other lines) starts empty.
  const [picked, setPicked] = useState<{
    model: unknown;
    resetKey: string;
    rows: ReadonlySet<number>;
  }>({ model, resetKey, rows: NO_ROWS });
  const rows = picked.model === model && picked.resetKey === resetKey ? picked.rows : NO_ROWS;
  const anchor = useRef<number | null>(null);
  const cursor = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  const selectRows = useCallback(
    (next: ReadonlySet<number>) => {
      setPicked({ model, resetKey, rows: next });
    },
    [model, resetKey],
  );
  const ordered = useMemo(
    () => (selectable ? [...selectable].sort((a, b) => a - b) : []),
    [selectable],
  );

  const moveCursor = useCallback((row: number | null) => {
    cursor.current = row;
    for (const editor of editors.current) showCursorRow(editor, row);
  }, []);

  const onRowPress = useCallback(
    (row: number, modifiers: PressModifiers) => {
      if (!selectable) return;
      const current = rowsRef.current;
      if (modifiers.shift && anchor.current !== null) {
        const range = rowRange(selectable, anchor.current, row);
        moveCursor(row);
        selectRows(new Set(modifiers.toggle ? [...current, ...range] : range));
        return;
      }
      anchor.current = row;
      moveCursor(row);
      if (modifiers.toggle) {
        const next = new Set(current);
        if (!next.delete(row)) next.add(row);
        selectRows(next);
      } else {
        selectRows(current.size === 1 && current.has(row) ? NO_ROWS : new Set([row]));
      }
    },
    [selectable, selectRows, moveCursor],
  );
  const onRowDrag = useCallback(
    (row: number) => {
      if (!selectable || anchor.current === null) return;
      selectRows(new Set(rowRange(selectable, anchor.current, row)));
    },
    [selectable, selectRows],
  );

  const hunksOf = useCallback(
    (action: HunkActionKind, hunk: number) => {
      const view = model.hunks[hunk];
      if (!view || !onHunks) return;
      const whole = wholeHunk(view);
      onHunks(action, whole, selectedLineCount(whole, model.hunks));
    },
    [model, onHunks],
  );

  const wrapRef = useRef(wrap);
  const sync = useRef<HeightSync | null>(null);
  const keyHandler = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const onKeyDown = useCallback((event: KeyboardEvent) => keyHandler.current(event), []);

  const labels: EditorLabels = useMemo(() => {
    const action = (kind: HunkActionKind): HunkActionDef => ({
      kind,
      label: t(`diff.hunk.${kind}`),
      ...(actionsDisabled ? { disabled: actionsDisabled } : {}),
    });
    return {
      noNewline: t('diff.noNewline'),
      hunkActions: !onHunks
        ? null
        : worktree === 'staged'
          ? [action('unstage')]
          : worktree === 'unstaged'
            ? [action('discard'), action('stage')]
            : null,
    };
  }, [t, worktree, onHunks, actionsDisabled]);

  useLayoutEffect(() => {
    const left = leftRef.current;
    if (!left) return;
    current.current = null;
    const heights = createHeightSync();
    sync.current = heights;
    const created: DiffEditor[] = [];
    if (model.kind === 'unified') {
      created.push(
        createDiffEditor({
          parent: left,
          lines: model.lines,
          hunks: model.hunks,
          side: 'unified',
          labels,
          label: t('diff.code', { path }),
          onHunkAction: hunksOf,
          selectable,
          onRowPress,
          onRowDrag,
          wrap: wrapRef.current,
          onKeyDown,
          onGeometry: heights.notify,
        }),
      );
    } else {
      const right = rightRef.current;
      if (!right) return;
      created.push(
        createDiffEditor({
          parent: left,
          lines: model.left,
          hunks: model.hunks,
          side: 'old',
          labels,
          label: t('diff.codeOld', { path }),
          onHunkAction: hunksOf,
          selectable,
          onRowPress,
          onRowDrag,
          wrap: wrapRef.current,
          onKeyDown,
          onGeometry: heights.notify,
        }),
        createDiffEditor({
          parent: right,
          lines: model.right,
          hunks: model.hunks,
          side: 'new',
          labels: { ...labels, hunkActions: null },
          label: t('diff.codeNew', { path }),
          selectable,
          onRowPress,
          onRowDrag,
          wrap: wrapRef.current,
          onKeyDown,
          onGeometry: heights.notify,
        }),
      );
    }
    editors.current = created;
    cursor.current = null;
    anchor.current = null;
    // Hunk titles stay visible on long lines: they stick right after the gutters.
    for (const editor of created) {
      editor.view.requestMeasure({
        read: (view) => view.dom.querySelector<HTMLElement>('.cm-gutters')?.offsetWidth ?? 0,
        write: (width, view) => {
          view.dom.parentElement?.style.setProperty('--gutter-width', `${String(width)}px`);
        },
      });
    }
    measureRender();
    // Highlighting parses the code: it comes right after the first painted frame, so the
    // diff itself shows without waiting for the language (P-06).
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      highlightTimer = setTimeout(() => {
        for (const editor of created) void editor.highlight(path);
      });
    });

    // Both columns have the same lines and headers: scroll positions map one to one.
    const cleanups: (() => void)[] = [];
    if (created.length === 2) {
      const [a, b] = created as [DiffEditor, DiffEditor];
      // Comparing positions (not a "syncing" flag) stops the echo without dropping events.
      const link = (from: DiffEditor, to: DiffEditor) => {
        const onScroll = () => {
          const source = from.view.scrollDOM;
          const target = to.view.scrollDOM;
          if (target.scrollTop !== source.scrollTop) target.scrollTop = source.scrollTop;
          if (target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft;
        };
        from.view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
        cleanups.push(() => {
          from.view.scrollDOM.removeEventListener('scroll', onScroll);
        });
      };
      // Same content width on both sides, so horizontal positions match up to the end.
      const equalize = () => {
        // Wrapped lines fit the pane: a minimum width kept from before would hide their end.
        if (wrapRef.current) return;
        const width = Math.max(a.view.contentDOM.scrollWidth, b.view.contentDOM.scrollWidth);
        for (const editor of [a, b]) editor.view.contentDOM.style.minWidth = `${String(width)}px`;
      };
      const observer = new ResizeObserver(equalize);
      observer.observe(a.view.contentDOM);
      observer.observe(b.view.contentDOM);
      cleanups.push(() => {
        observer.disconnect();
      });
      link(a, b);
      link(b, a);
      heights.attach(a.view, b.view);
    }
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(highlightTimer);
      heights.destroy();
      cleanups.forEach((cleanup) => {
        cleanup();
      });
      for (const editor of created) editor.destroy();
      editors.current = [];
    };
  }, [model, labels, path, t, hunksOf, selectable, onRowPress, onRowDrag, onKeyDown]);

  useEffect(() => {
    for (const editor of editors.current)
      editor.view.dispatch({ effects: setSelectedRows.of(rows) });
  }, [rows, model, labels, selectable]);

  useEffect(() => {
    wrapRef.current = wrap;
    for (const editor of editors.current) editor.setWrap(wrap);
    sync.current?.reset();
  }, [wrap, model, labels, selectable]);

  useImperativeHandle(
    ref,
    () => ({
      navigate(direction) {
        const first = editors.current[0];
        if (!first) return false;
        const top = topLine(first);
        const from = current.current ?? (top === 0 ? null : top);
        const next = adjacentStop(stops, from, direction);
        if (next === null) return false;
        current.current = next;
        for (const editor of editors.current) revealLine(editor, next);
        return true;
      },
      clearSelection() {
        if (rowsRef.current.size === 0) return false;
        selectRows(NO_ROWS);
        return true;
      },
    }),
    [stops, selectRows],
  );

  const applySelection = (action: HunkActionKind) => {
    if (!onHunks) return;
    const hunks = selectionToHunks(rows, sides, model.hunks);
    onHunks(action, hunks, selectedLineCount(hunks, model.hunks));
  };

  useEffect(() => {
    keyHandler.current = (event) => {
      if (!selectable || event.metaKey || event.ctrlKey || event.altKey) return false;
      const rowKey: SelectionKey | null =
        event.key === 'ArrowDown' || event.key === 'ArrowUp'
          ? { kind: 'move', direction: event.key === 'ArrowDown' ? 1 : -1, extend: event.shiftKey }
          : event.key === ' ' && !event.shiftKey && cursor.current !== null
            ? { kind: 'toggle' }
            : null;
      if (rowKey) {
        const next = applySelectionKey(
          selectable,
          ordered,
          { cursor: cursor.current, anchor: anchor.current, rows: rowsRef.current },
          rowKey,
        );
        anchor.current = next.anchor;
        moveCursor(next.cursor);
        if (next.rows !== rowsRef.current) selectRows(next.rows);
        if (next.cursor !== null) {
          const number = lineNumber(sides, next.cursor);
          setAnnouncement(
            t(next.rows.has(next.cursor) ? 'diff.row.selected' : 'diff.row.unselected', {
              line: number,
            }),
          );
        }
        return true;
      }
      if (event.shiftKey || rowsRef.current.size === 0) return false;
      const keyed =
        event.key === 'Enter'
          ? worktree === 'staged'
            ? 'unstage'
            : 'stage'
          : (event.key === 'Backspace' || event.key === 'Delete') && worktree === 'unstaged'
            ? 'discard'
            : null;
      if (!keyed) return false;
      if (!actionsDisabled) applySelection(keyed);
      return true;
    };
  });
  const count =
    rows.size === 0
      ? 0
      : selectedLineCount(selectionToHunks(rows, sides, model.hunks), model.hunks);

  return (
    <div className={styles.view}>
      {count > 0 && worktree && (
        <div className={styles.selection} role="toolbar" aria-label={t('diff.lines.label')}>
          <div className={styles.selectionText}>
            <span className={styles.selectionCount} role="status">
              {t('diff.lines.selected', { count })}
            </span>
            {actionsDisabled && <span className={styles.selectionNotice}>{actionsDisabled}</span>}
          </div>
          {worktree === 'unstaged' && (
            <Button
              size="sm"
              variant="ghost"
              aria-disabled={actionsDisabled !== null}
              aria-keyshortcuts="Backspace"
              title={actionsDisabled ?? undefined}
              onClick={() => {
                if (!actionsDisabled) applySelection('discard');
              }}
            >
              {t('diff.lines.discard')}
              <Kbd shortcut="Backspace" />
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            aria-disabled={actionsDisabled !== null}
            aria-keyshortcuts="Enter"
            title={actionsDisabled ?? undefined}
            onClick={() => {
              if (!actionsDisabled) applySelection(worktree === 'staged' ? 'unstage' : 'stage');
            }}
          >
            {worktree === 'staged' ? t('diff.lines.unstage') : t('diff.lines.stage')}
            <Kbd shortcut="Enter" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              selectRows(NO_ROWS);
            }}
          >
            {t('diff.lines.clear')}
            <Kbd shortcut="Escape" />
          </Button>
        </div>
      )}
      <div className={styles.srOnly} aria-live="polite">
        {announcement}
      </div>
      <div className={styles.code} data-view={view}>
        <div ref={leftRef} className={styles.pane} />
        {view === 'split' && <div ref={rightRef} className={styles.pane} />}
      </div>
    </div>
  );
}

/** A split row is a change when either side changed. */
function mergeSides<T extends { kind: string; hunk: number }>(left: T[], right: T[]): T[] {
  return left.map((line, i) => {
    const other = right[i];
    return line.kind === 'context' && other && other.kind !== 'context' ? other : line;
  });
}

/** Line number to announce for a row: the new file's, else the old file's. */
function lineNumber(sides: readonly (readonly DiffLine[])[], row: number): number {
  for (const side of [...sides].reverse()) {
    const line = side[row];
    const number = line?.newNo ?? line?.oldNo;
    if (number != null) return number;
  }
  return row + 1;
}
