import { useCallback, useRef } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import {
  clampColumn,
  HIDEABLE_COLUMNS,
  type GraphColumns,
  type HideableColumn,
  type SizedColumn,
} from './columns';
import styles from './GraphHeader.module.css';

interface Props {
  columns: GraphColumns;
  /** Widths actually laid out (hidden or dropped columns are 0). */
  widths: { graph: number; author: number; date: number; sha: number };
  onChange: (columns: GraphColumns) => void;
}

function ResizeHandle({
  column,
  width,
  grows,
  onResize,
  onReset,
  label,
}: {
  column: SizedColumn;
  width: number;
  /** `1`: dragging right widens the column (graph); `-1`: dragging left widens it. */
  grows: 1 | -1;
  onResize: (width: number) => void;
  onReset?: () => void;
  label: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (origin) onResize(clampColumn(column, origin.width + grows * (event.clientX - origin.x)));
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    onResize(clampColumn(column, width + grows * direction * 8));
  };
  return (
    <div
      className={`${styles.handle} ${grows === 1 ? styles.after : styles.before}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        start.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

/** Column titles with resize handles; right click toggles columns (F-021). */
export function GraphHeader({ columns, widths, onChange }: Props) {
  const t = useT();
  const resize = useCallback(
    (column: SizedColumn, width: number) => {
      onChange({ ...columns, [column]: width });
    },
    [columns, onChange],
  );
  const toggle = (column: HideableColumn) => {
    onChange({ ...columns, hidden: { ...columns.hidden, [column]: !columns.hidden[column] } });
  };
  const labels: Record<HideableColumn, string> = {
    author: t('graph.column.author'),
    date: t('graph.column.date'),
    sha: t('graph.column.sha'),
  };
  const resizeLabel = (column: SizedColumn) =>
    t('graph.resizeColumn', {
      column: column === 'graph' ? t('graph.column.graph') : labels[column],
    });

  return (
    <ContextMenu
      content={HIDEABLE_COLUMNS.map((column) => (
        <ContextMenuItem
          key={column}
          icon={columns.hidden[column] ? undefined : 'check'}
          onSelect={() => {
            toggle(column);
          }}
        >
          {labels[column]}
        </ContextMenuItem>
      ))}
    >
      <div className={styles.header} style={{ gridTemplateColumns: 'var(--graph-grid)' }}>
        <span className={styles.cell}>
          {t('graph.column.graph')}
          <ResizeHandle
            column="graph"
            width={widths.graph}
            grows={1}
            label={resizeLabel('graph')}
            onResize={(w) => {
              resize('graph', w);
            }}
            onReset={() => {
              onChange({ ...columns, graph: null });
            }}
          />
        </span>
        <span className={styles.cell}>{t('graph.column.message')}</span>
        {(['author', 'date', 'sha'] as const).map((column) =>
          widths[column] > 0 ? (
            <span key={column} className={styles.cell}>
              {widths[column] >= 64 || column !== 'author' ? labels[column] : null}
              <ResizeHandle
                column={column}
                width={widths[column]}
                grows={-1}
                label={resizeLabel(column)}
                onResize={(w) => {
                  resize(column, w);
                }}
              />
            </span>
          ) : null,
        )}
      </div>
    </ContextMenu>
  );
}
