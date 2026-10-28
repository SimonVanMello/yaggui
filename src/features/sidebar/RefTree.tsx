import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { useSelectedSha } from '../repo/graphNavigation';
import { useRowHeight } from '../graph/useRowHeight';
import { checkoutRef } from '../refs/refCommands';
import { useStashPreview } from '../refs/stashPreview';
import { copyText, revealRef } from './refActions';
import { FolderHideItem } from './FolderHideItem';
import { RefContextMenu } from './RefContextMenu';
import { RemoteContextMenu, type GroupMenuTarget } from './RemoteContextMenu';
import styles from './RefTree.module.css';
import { RefTreeRow } from './RefTreeRow';
import {
  targetCommit,
  targetName,
  type FolderRow,
  type RefTarget,
  type SectionRow,
  type SidebarRow,
} from './sidebarRows';

const OVERSCAN = 12;
const PAGE = 10;

interface RefTreeProps {
  repoId: number;
  rows: SidebarRow[];
  graphVersion: number | null;
  /** Checked-out branch, for the labels of the context menu. */
  current: string | null;
  onToggle: (row: SectionRow | FolderRow) => void;
  /** A printable key typed in the tree: the sidebar forwards it to the filter. */
  onTypeAhead: (char: string) => void;
  onEscape: () => void;
  treeRef: Ref<HTMLDivElement>;
}

/** Remote folders and the Remote / Tags headers have a menu of their own (M4-7c). */
function groupMenuTarget(row: SidebarRow): GroupMenuTarget | null {
  if (row.type === 'folder' && row.remote) return { kind: 'remote', name: row.path };
  if (row.type === 'section' && (row.section === 'remote' || row.section === 'tags')) {
    return { kind: 'section', section: row.section };
  }
  return null;
}

const focusable = (row: SidebarRow | undefined) => row !== undefined && row.type !== 'empty';

/**
 * Virtualized, keyboard-driven tree of refs (ARIA `tree`, focus kept on the container with
 * `aria-activedescendant`). Section headers stay pinned while their items scroll.
 */
export function RefTree({
  repoId,
  rows,
  graphVersion,
  current,
  onToggle,
  onTypeAhead,
  onEscape,
  treeRef,
}: RefTreeProps) {
  const t = useT();
  const baseId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedSha = useSelectedSha(repoId);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowHeight = useRowHeight();
  const [menuTarget, setMenuTarget] = useState<
    | { kind: 'ref'; target: RefTarget }
    | { kind: 'group'; target: GroupMenuTarget }
    | { kind: 'folder'; section: 'local' | 'remote'; path: string }
    | null
  >(null);

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      if (typeof treeRef === 'function') treeRef(element);
      else if (treeRef) treeRef.current = element;
    },
    [treeRef],
  );

  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const sectionIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.type === 'section' ? [index] : [])),
    [rows],
  );
  const stickyRef = useRef(-1);

  const rangeExtractor = useCallback(
    (range: Range) => {
      let sticky = -1;
      for (const index of sectionIndexes) {
        if (index <= range.startIndex) sticky = index;
        else break;
      }
      stickyRef.current = sticky;
      const indexes = defaultRangeExtractor(range);
      return sticky >= 0 && !indexes.includes(sticky) ? [sticky, ...indexes] : indexes;
    },
    [sectionIndexes],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  const rawActive = activeKey === null ? undefined : indexByKey.get(activeKey);
  const activeIndex = rawActive !== undefined && focusable(rows[rawActive]) ? rawActive : -1;

  const moveTo = (index: number) => {
    const row = rows[index];
    if (!row || row.type === 'empty') return;
    setActiveKey(row.key);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  const step = (from: number, delta: number): number => {
    let index = from + delta;
    while (index >= 0 && index < rows.length && !focusable(rows[index])) index += delta;
    return index >= 0 && index < rows.length ? index : from;
  };

  const press = (row: SidebarRow) => {
    if (row.type === 'empty') return;
    setActiveKey(row.key);
    if (row.type !== 'ref') {
      onToggle(row);
      return;
    }
    revealRef(repoId, row.target, graphVersion);
    // The stash diff replaces the details of its base commit (F-183).
    if (row.target.kind === 'stash') useStashPreview.getState().show(repoId, row.target.stash);
    else useStashPreview.getState().clear(repoId);
  };

  const openRow = (row: SidebarRow) => {
    if (row.type === 'ref') checkoutRef(repoId, row.target);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const row = activeIndex >= 0 ? rows[activeIndex] : undefined;
    const from = activeIndex >= 0 ? activeIndex : -1;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (event.key.toLowerCase() === 'c' && row?.type === 'ref') {
        stop();
        copyText(targetName(row.target), t('sidebar.what.name'));
      }
      return;
    }
    if (event.altKey) return;
    switch (event.key) {
      case 'ArrowDown':
        stop();
        moveTo(step(from, 1));
        return;
      case 'ArrowUp':
        stop();
        moveTo(from <= 0 ? step(rows.length, -1) : step(from, -1));
        return;
      case 'Home':
        stop();
        moveTo(step(-1, 1));
        return;
      case 'End':
        stop();
        moveTo(step(rows.length, -1));
        return;
      case 'PageDown':
        stop();
        moveTo(step(Math.min(rows.length - 1, from + PAGE) + 1, -1));
        return;
      case 'PageUp':
        stop();
        moveTo(step(Math.max(0, from - PAGE) - 1, 1));
        return;
      case 'ArrowRight':
        stop();
        if (row?.type === 'section' || row?.type === 'folder') {
          if (!row.expanded) onToggle(row);
          else if (rows[from + 1]?.parent === row.key) moveTo(from + 1);
        }
        return;
      case 'ArrowLeft':
        stop();
        if ((row?.type === 'section' || row?.type === 'folder') && row.expanded) onToggle(row);
        else if (row?.parent) {
          const parent = indexByKey.get(row.parent);
          if (parent !== undefined) moveTo(parent);
        }
        return;
      case 'Enter':
      case ' ':
        stop();
        if (row) press(row);
        return;
      case 'Escape':
        onEscape();
        return;
      case 'ContextMenu':
        stop();
        openMenuFromKeyboard();
        return;
      case 'F10':
        if (event.shiftKey) {
          stop();
          openMenuFromKeyboard();
        }
        return;
      default:
        if (event.key.length === 1) {
          stop();
          onTypeAhead(event.key);
        }
    }
  };

  function openMenuFromKeyboard() {
    if (activeIndex < 0) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${String(activeIndex)}"]`,
    );
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 24,
        clientY: rect.bottom - 2,
      }),
    );
  }

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-row-index]');
    const row = element ? rows[Number(element.dataset.rowIndex)] : undefined;
    const group = row ? groupMenuTarget(row) : null;
    if (row && group) {
      setActiveKey(row.key);
      setMenuTarget({ kind: 'group', target: group });
      return;
    }
    if (row?.type === 'folder' && (row.section === 'local' || row.section === 'remote')) {
      setActiveKey(row.key);
      setMenuTarget({ kind: 'folder', section: row.section, path: row.path });
      return;
    }
    if (!row || row.type !== 'ref') {
      // Radix skips its own handler on a prevented event: no menu outside these rows.
      event.preventDefault();
      return;
    }
    setActiveKey(row.key);
    setMenuTarget({ kind: 'ref', target: row.target });
  };

  const items = virtualizer.getVirtualItems();
  const sticky = stickyRef.current;

  return (
    <>
      <ContextMenu
        content={
          menuTarget?.kind === 'ref' ? (
            <RefContextMenu repoId={repoId} target={menuTarget.target} current={current} />
          ) : menuTarget?.kind === 'group' ? (
            <RemoteContextMenu repoId={repoId} target={menuTarget.target} />
          ) : menuTarget?.kind === 'folder' ? (
            <FolderHideItem repoId={repoId} section={menuTarget.section} path={menuTarget.path} />
          ) : null
        }
      >
        <div
          ref={setRefs}
          className={styles.tree}
          role="tree"
          aria-label={t('sidebar.label')}
          tabIndex={0}
          aria-activedescendant={activeIndex >= 0 ? `${baseId}-${String(activeIndex)}` : undefined}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            if (event.target !== event.currentTarget || activeIndex >= 0) return;
            const first = step(-1, 1);
            const row = rows[first];
            if (row) setActiveKey(row.key);
          }}
          onContextMenu={onContextMenu}
        >
          <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const pinned = item.index === sticky;
              const style: React.CSSProperties = pinned
                ? { position: 'sticky', top: 0, height: rowHeight }
                : { transform: `translateY(${String(item.start)}px)`, height: rowHeight };
              const commit = row.type === 'ref' ? targetCommit(row.target) : null;
              return (
                <RefTreeRow
                  key={row.key}
                  repoId={repoId}
                  row={row}
                  id={`${baseId}-${String(item.index)}`}
                  index={item.index}
                  active={item.index === activeIndex}
                  selected={commit !== null && commit.sha === selectedSha}
                  style={style}
                  sticky={pinned}
                  onPress={press}
                  onOpen={openRow}
                />
              );
            })}
          </div>
        </div>
      </ContextMenu>
    </>
  );
}
