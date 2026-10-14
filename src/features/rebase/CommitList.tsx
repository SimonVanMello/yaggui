import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { useNow } from '../../ui/useNow';
import { CommitRow } from './CommitRow';
import styles from './CommitList.module.css';
import { flipIndex, isNoopSlot, moveFocus, moveOnScreen, moveToSlot, slotAt } from './rebaseLayout';
import {
  ACTION_KEYS,
  preview,
  setAction,
  setMessage,
  validate,
  type RebaseRow,
} from './rebaseModel';

interface CommitListProps {
  rows: readonly RebaseRow[];
  onRows: (rows: RebaseRow[]) => void;
  upstream: string | null;
  label: string;
}

interface Drag {
  /** Todo index of the dragged row. */
  from: number;
  slot: number;
}

const SCROLL_EDGE = 32;
const SCROLL_STEP = 16;

/**
 * The todo as a listbox, newest commit on top (F-142). Rows move by pointer drag (pointer
 * events with capture, since HTML5 drag and drop does not survive the native file-drop
 * handling of the window on Windows) and by keyboard: ↑ ↓ move the focus, Alt+↑ Alt+↓ move
 * the commit, `p r s f d e` set its action, Enter edits its message.
 */
export function CommitList({ rows, onRows, upstream, label }: CommitListProps) {
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const count = rows.length;
  const [focus, setFocus] = useState(count - 1);
  const [editing, setEditing] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const element = useRef<HTMLUListElement | null>(null);

  const result = useMemo(() => preview(rows), [rows]);
  const validation = useMemo(() => validate(rows), [rows]);
  // Row index → the commit it ends up in, to tell what a squash / fixup melds into.
  const groups = useMemo(() => {
    const byRow = new Map<number, (typeof result.commits)[number]>();
    for (const commit of result.commits) {
      byRow.set(commit.index, commit);
      for (const { index } of commit.melded) byRow.set(index, commit);
    }
    return byRow;
  }, [result]);

  useEffect(() => {
    element.current?.focus();
  }, []);

  const focused = Math.min(focus, count - 1);
  const rowId = (index: number) => `rebase-row-${rows[index]?.commit.sha ?? String(index)}`;

  useEffect(() => {
    const row = element.current?.querySelector(`[data-index="${String(focused)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [focused, rows]);

  useEffect(() => {
    if (!drag) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drag]);

  const slotFor = (y: number): number => {
    const list = element.current;
    if (!list) return 0;
    const middles = [...list.querySelectorAll('[data-row]')].map((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    return slotAt(y, middles);
  };

  const track = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const gripDown = (event: PointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0 || editing !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setFocus(index);
    track({ from: index, slot: slotFor(event.clientY) });
  };

  const gripMove = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const list = element.current;
    if (list) {
      const box = list.getBoundingClientRect();
      if (event.clientY < box.top + SCROLL_EDGE) list.scrollTop -= SCROLL_STEP;
      else if (event.clientY > box.bottom - SCROLL_EDGE) list.scrollTop += SCROLL_STEP;
    }
    const slot = slotFor(event.clientY);
    if (slot !== current.slot) track({ ...current, slot });
  };

  const gripEnd = (event: PointerEvent<HTMLElement>, apply: boolean) => {
    const current = dragRef.current;
    if (!current) return;
    track(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!apply || isNoopSlot(current.from, current.slot, count)) return;
    const moved = moveToSlot(rows, current.from, current.slot);
    onRows(moved.rows);
    setFocus(moved.index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea')) return;
    if (event.metaKey || event.ctrlKey) return;
    const direction = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
    if (direction) {
      event.preventDefault();
      if (event.altKey) {
        const moved = moveOnScreen(rows, focused, direction);
        if (moved.index !== focused) onRows(moved.rows);
        setFocus(moved.index);
      } else {
        setFocus(moveFocus(focused, count, direction));
      }
      return;
    }
    if (event.altKey) return;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setFocus(event.key === 'Home' ? count - 1 : 0);
      return;
    }
    if (event.key === 'Enter') {
      const group = groups.get(focused);
      if (group?.messageRow !== null && group?.messageRow !== undefined) {
        event.preventDefault();
        setFocus(group.messageRow);
        setEditing(group.messageRow);
      }
      return;
    }
    const action = ACTION_KEYS[event.key.toLowerCase()];
    if (action && !event.shiftKey) {
      event.preventDefault();
      onRows(setAction(rows, focused, action));
    }
  };

  const refocus = () => {
    element.current?.focus();
  };

  return (
    <ul
      ref={element}
      className={styles.list}
      role="listbox"
      aria-label={label}
      aria-activedescendant={count > 0 ? rowId(focused) : undefined}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {rows.map((_, screen) => {
        const index = flipIndex(screen, count);
        const row = rows[index];
        if (!row) return null;
        const group = groups.get(index);
        const holdsMessage = group?.messageRow === index;
        const dropSlot = drag && !isNoopSlot(drag.from, drag.slot, count) ? drag.slot : null;
        return (
          <CommitRow
            key={row.commit.sha}
            id={rowId(index)}
            row={row}
            index={index}
            focused={index === focused}
            dragging={drag?.from === index}
            drop={
              dropSlot === screen
                ? 'before'
                : dropSlot === count && screen === count - 1
                  ? 'after'
                  : null
            }
            issue={validation.rows.get(index)}
            meldedInto={group && group.index !== index ? group.head.commit.summary : null}
            hasMelded={group?.index === index && group.melded.length > 0}
            finalMessage={group && holdsMessage ? group.message : null}
            editing={editing === index}
            upstream={upstream}
            now={now}
            locale={locale}
            onSelect={(next) => {
              setFocus(next);
              refocus();
            }}
            onAction={(next, action) => {
              onRows(setAction(rows, next, action));
              setFocus(next);
              refocus();
            }}
            onEdit={(next) => {
              setEditing(next);
              if (next === null) refocus();
            }}
            onMessage={(next, message) => {
              onRows(setMessage(rows, next, message));
            }}
            onGripDown={gripDown}
            onGripMove={gripMove}
            onGripEnd={gripEnd}
          />
        );
      })}
    </ul>
  );
}
