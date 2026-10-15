import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { create } from 'zustand';

import { useT } from '../../../i18n/useT';
import { IconButton } from '../../../ui/IconButton';
import type { CodeDiffHandle } from '../CodeDiff';
import { diffMarkdown, type DiffUnit, type MarkdownDiff as MarkdownDiffResult } from './blockDiff';
import { listItemNumber, MarkdownBlockView } from './MarkdownBlockView';
import styles from './MarkdownDiff.module.css';

/** Whether removed text is shown, kept for the session from one file to the next. */
const useShowRemoved = create<{ show: boolean }>(() => ({ show: true }));

interface MarkdownDiffProps {
  ref?: Ref<CodeDiffHandle>;
  oldText: string;
  newText: string;
}

interface Counts {
  added: number;
  removed: number;
  changed: number;
}

interface UnitViewProps {
  unit: DiffUnit;
  diff: MarkdownDiffResult;
  /** Index of the change the block belongs to; set on the first block of the change only. */
  change: number | null;
  active: boolean;
}

function UnitView({ unit, diff, change, active }: UnitViewProps) {
  const text = unit.status === 'removed' ? diff.old.text : diff.new.text;
  const marks = unit.status === 'changed' ? unit.marks : null;
  const content = <MarkdownBlockView text={text} block={unit.block} marks={marks} />;
  const attributes = {
    className: styles.unit,
    'data-status': unit.status,
    'data-change': change ?? undefined,
    'data-active': active ? '' : undefined,
  };
  if (unit.block.type === 'ListItem') {
    const value =
      unit.block.list?.kind === 'ordered' ? listItemNumber(text, unit.block) : undefined;
    return (
      <li {...attributes} value={value}>
        {content}
      </li>
    );
  }
  return <div {...attributes}>{content}</div>;
}

/**
 * Rendered Markdown with its changes (F-089): the new version of the document, each changed
 * block marked in the margin, inserted words highlighted and removed ones struck through
 * where they stood.
 */
export function MarkdownDiff({ ref, oldText, newText }: MarkdownDiffProps) {
  const t = useT();
  const showRemoved = useShowRemoved((state) => state.show);
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const diff = useMemo(() => diffMarkdown(oldText, newText), [oldText, newText]);

  // A change is a run of consecutive changed blocks.
  const { groupOf, changes, counts } = useMemo(() => {
    const groupOf: (number | null)[] = [];
    const counts: Counts = { added: 0, removed: 0, changed: 0 };
    let changes = 0;
    let previous: DiffUnit['status'] = 'same';
    for (const unit of diff.units) {
      if (unit.status === 'same') groupOf.push(null);
      else {
        counts[unit.status]++;
        if (previous === 'same') changes++;
        groupOf.push(changes - 1);
      }
      previous = unit.status;
    }
    return { groupOf, changes, counts };
  }, [diff]);

  const unitView = (unit: DiffUnit, at: number) => {
    const group = groupOf[at] ?? null;
    return (
      <UnitView
        key={at}
        unit={unit}
        diff={diff}
        change={group !== null && groupOf[at - 1] !== group ? group : null}
        active={group !== null && group === current}
      />
    );
  };

  const goTo = (index: number) => {
    const target = scroller.current?.querySelector(`[data-change="${String(index)}"]`);
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: 'center' });
    setCurrent(index);
  };

  const navigate = (direction: 1 | -1): boolean => {
    if (changes === 0) return false;
    const next = current === null ? (direction === 1 ? 0 : changes - 1) : current + direction;
    if (next < 0 || next >= changes) return false;
    goTo(next);
    return true;
  };

  useImperativeHandle(ref, () => ({ navigate, clearSelection: () => false }));

  // Consecutive items of a list share one `<ul>` / `<ol>`, whatever their status.
  const body: ReactNode[] = [];
  let index = 0;
  while (index < diff.units.length) {
    const unit = diff.units[index];
    if (!unit) break;
    const kind = unit.block.type === 'ListItem' ? unit.block.list?.kind : undefined;
    if (!kind) {
      body.push(unitView(unit, index));
      index++;
      continue;
    }
    const start = index;
    const items: ReactNode[] = [];
    for (; index < diff.units.length; index++) {
      const item = diff.units[index];
      if (!item || item.block.type !== 'ListItem' || item.block.list?.kind !== kind) break;
      items.push(unitView(item, index));
    }
    body.push(kind === 'ordered' ? <ol key={start}>{items}</ol> : <ul key={start}>{items}</ul>);
  }

  const parts = [
    counts.added > 0
      ? { status: 'added', label: t('diff.markdown.added', { count: counts.added }) }
      : null,
    counts.removed > 0
      ? { status: 'removed', label: t('diff.markdown.removed', { count: counts.removed }) }
      : null,
    counts.changed > 0
      ? { status: 'changed', label: t('diff.markdown.changed', { count: counts.changed }) }
      : null,
  ].filter((part) => part !== null);

  return (
    <div className={styles.view}>
      <div className={styles.strip}>
        {parts.length === 0 ? (
          <span>{t('diff.markdown.noVisibleChange')}</span>
        ) : (
          parts.map((part) => (
            <span key={part.status} className={styles.count} data-status={part.status}>
              {part.label}
            </span>
          ))
        )}
        <span className={styles.spacer} />
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(event) => {
              useShowRemoved.setState({ show: event.currentTarget.checked });
            }}
          />
          {t('diff.markdown.showRemoved')}
        </label>
        {changes > 0 && (
          <>
            <span className={styles.position}>
              {current === null
                ? t('diff.markdown.changes', { count: changes })
                : t('diff.markdown.position', { index: current + 1, total: changes })}
            </span>
            <IconButton
              icon="chevronUp"
              size="sm"
              label={t('diff.markdown.previousChange')}
              shortcut="P"
              disabled={current !== null && current <= 0}
              onClick={() => {
                navigate(-1);
              }}
            />
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('diff.markdown.nextChange')}
              shortcut="N"
              disabled={current !== null && current >= changes - 1}
              onClick={() => {
                navigate(1);
              }}
            />
          </>
        )}
      </div>
      <div ref={scroller} className={styles.scroller}>
        <article
          className={styles.document}
          data-hide-removed={showRemoved ? undefined : ''}
          aria-label={t('diff.markdown.label')}
        >
          {body}
        </article>
      </div>
    </div>
  );
}
