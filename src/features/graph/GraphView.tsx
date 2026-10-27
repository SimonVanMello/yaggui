import { observeElementOffset, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { modalOpen } from '../../app/shellActions';
import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { RepoState } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { matchBinding } from '../keybindings/registry';
import { useNow } from '../../ui/useNow';
import { BISECT_MARK_LABELS } from '../bisect/BisectMarkPill';
import { bisectMarks } from '../bisect/bisectModel';
import { useBisectState } from '../bisect/useBisectState';
import { startPress } from '../history/dnd/pointerDrag';
import { changedFiles, shortOid } from '../repo/repoStatus';
import { CommitContextMenu, copyText } from './CommitContextMenu';
import { fitColumns } from './columns';
import { autoGraphWidth } from './geometry';
import { GraphCanvas } from './GraphCanvas';
import { GraphFilterBar } from './GraphFilterBar';
import { GraphHeader } from './GraphHeader';
import { GraphRowView, type RowColumns } from './GraphRowView';
import { usePillMetrics } from './usePillMetrics';
import { GraphSearchBar } from './GraphSearchBar';
import { HistoryWalkStatus } from './HistoryWalkStatus';
import { useGraphSource } from './graphSource';
import { directionalRange } from './overscan';
import type { GraphRow } from './pageCache';
import { refOfEvent, type MenuRef } from './refLabels';
import { useRemoteTags } from './remoteTags';
import styles from './GraphView.module.css';
import { ScrollMapper } from './scrollMapper';
import { useRowHeight } from './useRowHeight';
import { toast } from '../../ui/toastStore';
import { SelectionBar } from './SelectionBar';

const OVERSCAN = 8;
const SKELETON_ROWS = 40;

function rowOfEvent(event: { target: EventTarget }): HTMLElement | null {
  return event.target instanceof Element ? event.target.closest<HTMLElement>('[data-row]') : null;
}

/** The commit graph (F-020…F-031): canvas lanes, virtualized rows, header, search. */
export function GraphView({
  tab,
  repoId,
  state,
}: {
  tab: ShellTab;
  repoId: number;
  state: RepoState;
}) {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const now = useNow();
  const source = useGraphSource(repoId);
  const setColumns = useTabsStore((s) => s.setColumns);
  const rowHeight = useRowHeight();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [menuTarget, setMenuTarget] = useState<GraphRow | null>(null);
  const [menuRef, setMenuRef] = useState<MenuRef | null>(null);
  const handledScroll = useRef(0);

  const { cache } = source;
  const totalRows = cache.totalRows;
  const dirty = changedFiles(state) > 0;
  const wipShown = dirty && cache.wip !== null && totalRows > 0;
  const wipHeight = wipShown ? rowHeight : 0;
  const hasRows = totalRows > 0;

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const wrapper = wrapperRef.current;
    if (!scroller || !wrapper) return;
    const measure = () => {
      setSize({ width: scroller.clientWidth, height: scroller.clientHeight });
      wrapper.style.setProperty(
        '--scrollbar-width',
        `${String(scroller.offsetWidth - scroller.clientWidth)}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [cache.version]);

  // Rows and the virtualizer work in logical offsets; above ~10 M px the scroll area is capped
  // and rows are placed at `logical - offset` (see ScrollMapper).
  const [mapper] = useState(() => new ScrollMapper());
  mapper.configure(wipHeight + totalRows * rowHeight, size.height);
  const [offset, setOffset] = useState(0);
  const shownOffset = useRef(0);

  // The compositor paints the new scroll offset before the scroll listener runs: rows rendered
  // half a viewport ahead (in the last scroll direction) cover a fast flick until the next
  // render, which the virtualizer does synchronously in the scroll event (its default
  // `useFlushSync`). A whole viewport costs frames on slow CPUs for no visible gain.
  const ahead = Math.max(OVERSCAN, Math.ceil(size.height / 2 / rowHeight));
  const scrolled = useRef({ offset: 0, forward: true });
  const rangeExtractor = useCallback(
    (range: Range) => directionalRange(range, scrolled.current.forward, ahead, OVERSCAN),
    [ahead],
  );
  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    rangeExtractor,
    paddingStart: wipHeight,
    observeElementOffset: (instance, notify) =>
      observeElementOffset(instance, (_physical, isScrolling) => {
        const scroller = instance.scrollElement;
        const logical = scroller ? mapper.sync(scroller) : 0;
        if (mapper.offset !== shownOffset.current) {
          shownOffset.current = mapper.offset;
          // Rare (a jump or the window moving back to the middle): rows must move in the
          // same frame as the new scrollTop.
          flushSync(() => {
            setOffset(mapper.offset);
          });
        }
        if (logical !== scrolled.current.offset)
          scrolled.current = { offset: logical, forward: logical > scrolled.current.offset };
        notify(logical, isScrolling);
      }),
  });
  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = items.at(-1)?.index ?? Math.max(0, SKELETON_ROWS);

  useEffect(() => {
    source.ensure(firstIndex, lastIndex);
  }, [source, firstIndex, lastIndex, source.version]);

  // Back on the tab: same scroll position.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && source.scrollTop > 0) mapper.scrollTo(scroller, source.scrollTop);
  }, [source, mapper, hasRows]);

  const scrollToRow = (row: number, align: 'start' | 'center' | 'auto') => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (row === 0 && align !== 'center') {
      mapper.scrollTo(scroller, 0);
      return;
    }
    const view = mapper.sync(scroller);
    const top = wipHeight + row * rowHeight;
    const viewport = size.height;
    if (align === 'start') mapper.scrollTo(scroller, top);
    else if (align === 'center') mapper.scrollTo(scroller, top - (viewport - rowHeight) / 2);
    else if (top < view) mapper.scrollTo(scroller, top);
    else if (top + rowHeight > view + viewport)
      mapper.scrollTo(scroller, top + rowHeight - viewport);
  };

  useEffect(() => {
    const request = source.scrollRequest;
    if (!request || request.id === handledScroll.current || totalRows === 0) return;
    handledScroll.current = request.id;
    scrollToRow(request.row, request.align);
  });

  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const logical = mapper.sync(scroller);
    source.scrollTop = logical;
    source.topSha =
      source.cache.row(Math.max(0, Math.floor((logical - wipHeight) / rowHeight)))?.sha ??
      source.topSha;
  }, [source, mapper, wipHeight, rowHeight]);

  const columns = tab.columns;
  const graphWidth = columns.graph ?? autoGraphWidth(cache.laneCount);
  const widths = fitColumns(columns, graphWidth, size.width);
  const pillMetrics = usePillMetrics();
  const remoteTags = useRemoteTags(repoId);
  const bisectState = useBisectState(repoId).data;
  // One map per bisect state: each visible row only looks its SHA up (P-04).
  const marks = useMemo(() => bisectMarks(bisectState), [bisectState]);
  const messageWidth = Math.max(
    0,
    size.width - widths.graph - widths.author - widths.date - widths.sha - pillMetrics.rowPadding,
  );
  const rowColumns = useMemo<RowColumns>(
    () => ({
      author: widths.author > 0,
      authorName: widths.author >= 64,
      date: widths.date > 0,
      sha: widths.sha > 0,
    }),
    [widths.author, widths.date, widths.sha],
  );
  const gridTemplate = [
    `${String(widths.graph)}px`,
    'minmax(0, 1fr)',
    widths.author > 0 ? `${String(widths.author)}px` : '',
    widths.date > 0 ? `${String(widths.date)}px` : '',
    widths.sha > 0 ? `${String(widths.sha)}px` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const selection = source.selection;
  const selectedRow = source.selectedRow();
  const search = source.search;

  const moveSelection = (delta: number) => {
    if (selection?.kind === 'wip') {
      if (delta > 0) source.selectRow(0);
      return;
    }
    if (selectedRow === null) {
      source.selectRow(delta > 0 ? firstVisibleRow(source.scrollTop) : 0);
      return;
    }
    if (selectedRow === 0 && delta < 0 && wipShown) {
      source.selectWip();
      if (scrollRef.current) mapper.scrollTo(scrollRef.current, 0);
      return;
    }
    source.selectRow(selectedRow + delta);
  };
  const firstVisibleRow = (scrollTop: number) =>
    Math.max(0, Math.ceil((scrollTop - wipHeight) / rowHeight));
  const pageRows = Math.max(1, Math.floor(size.height / rowHeight) - 1);

  function openMenuFromKeyboard() {
    if (selectedRow === null) return;
    const rowElement = wrapperRef.current?.querySelector<HTMLElement>(
      `[data-row="${String(selectedRow)}"]`,
    );
    if (!rowElement) return;
    const rect = rowElement.getBoundingClientRect();
    rowElement.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 48,
        clientY: rect.bottom - 2,
      }),
    );
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const extend = event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (extend && event.key === 'ArrowDown') source.extendSelection(1);
    else if (extend && event.key === 'ArrowUp') source.extendSelection(-1);
    else if (plain && !event.shiftKey && event.key === 'ArrowDown') moveSelection(1);
    else if (plain && !event.shiftKey && event.key === 'ArrowUp') moveSelection(-1);
    else if (plain && event.key === 'PageDown') moveSelection(pageRows);
    else if (plain && event.key === 'PageUp') moveSelection(-pageRows);
    else if (plain && event.key === 'Home') source.selectRow(0);
    else if (plain && event.key === 'End') source.selectRow(totalRows - 1);
    else if (matchBinding(event, 'graph.copySha') && source.picks.picked.size > 1) {
      const shas = source.selectedCommits().map((c) => c.sha);
      copyText(shas.join('\n'), t('graph.menu.shasCopied', { count: shas.length }));
    } else if (matchBinding(event, 'graph.copySha') && selectedRow !== null) {
      const row = cache.row(selectedRow);
      if (row) copyText(row.sha, t('graph.menu.shaCopied'));
    } else if (matchBinding(event, 'graph.copyMessage') && selectedRow !== null) {
      const row = cache.row(selectedRow);
      if (row) copyText(row.summary, t('graph.menu.messageCopied'));
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      // The webview would open its own menu (WebKitGTK does): open ours on the selected row.
      openMenuFromKeyboard();
    } else if (event.key === 'Escape' && source.collapseSelection()) {
      // Back to a single commit.
    } else if (event.key === 'Escape' && search.open) source.closeSearch();
    else return;
    event.preventDefault();
  };

  // `⌘F` and `⌘⇧H` work wherever the focus is in the repo view.
  useEffect(() => {
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || modalOpen()) return;
      if (matchBinding(event, 'graph.search')) {
        event.preventDefault();
        source.openSearch();
      } else if (matchBinding(event, 'graph.goToHead')) {
        event.preventDefault();
        void source.goToHead();
      }
    };
    window.addEventListener('keydown', onWindowKey);
    return () => {
      window.removeEventListener('keydown', onWindowKey);
    };
  }, [source]);

  const onClick = (event: React.MouseEvent) => {
    const element = rowOfEvent(event);
    if (!element) return;
    if (element.dataset.wip !== undefined) {
      source.selectWip();
      return;
    }
    const row = Number(element.dataset.row);
    const toggle = event.metaKey || event.ctrlKey;
    if (toggle || event.shiftKey) {
      source.pickRow(row, { toggle, range: event.shiftKey });
      return;
    }
    const data = cache.row(row);
    if (data) source.selectCommit(data.sha, row);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const element = rowOfEvent(event);
    if (!element || element.dataset.wip !== undefined) return;
    const row = Number(element.dataset.row);
    startPress(event, () => {
      const data = cache.row(row);
      if (!data) return null;
      // Dragging a commit outside the selection drags that commit alone (and selects it).
      if (!source.pickedRows.has(row)) source.selectCommit(data.sha, row);
      const picked = source.selectedCommits();
      return {
        repoId,
        payload: { kind: 'commits', shas: picked.map((c) => c.sha) },
        label:
          picked.length > 1
            ? t('dnd.commits', { count: picked.length })
            : `${shortOid(data.sha)} ${data.summary}`,
      };
    });
  };

  const onContextMenuCapture = (event: React.MouseEvent) => {
    const element = rowOfEvent(event);
    const row = element && element.dataset.wip === undefined ? Number(element.dataset.row) : null;
    const data = row === null ? undefined : cache.row(row);
    if (!data || row === null) {
      // Nothing to act on: no menu.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // A right click inside the multi-selection keeps it; elsewhere it selects that commit.
    if (!source.pickedRows.has(row) || source.picks.picked.size < 2)
      source.selectCommit(data.sha, row);
    setMenuTarget(data);
    setMenuRef(refOfEvent(event));
  };

  if (cache.version === null && source.loadError) {
    return (
      <div className={styles.view}>
        <ErrorPanel
          title={t('graph.loadFailed')}
          error={source.loadError}
          context={{
            retry: () => {
              source.retry();
            },
          }}
        />
      </div>
    );
  }

  const empty = cache.version !== null && totalRows === 0;

  return (
    <div
      ref={wrapperRef}
      className={styles.view}
      style={
        {
          '--graph-grid': gridTemplate,
          '--graph-col': `${String(widths.graph)}px`,
          '--author-col': `${String(widths.author)}px`,
          '--date-col': `${String(widths.date)}px`,
          '--sha-col': `${String(widths.sha)}px`,
        } as React.CSSProperties
      }
    >
      <GraphFilterBar repoId={repoId} />
      <GraphHeader
        columns={columns}
        widths={widths}
        onChange={(next) => {
          setColumns(tab.id, next);
        }}
      />
      <CommitContextMenu
        repoId={repoId}
        target={menuTarget}
        refLabel={menuRef}
        picked={source.selectedCommits()}
        busy={state.operation !== null}
        current={state.head.kind === 'branch' ? state.head.name : null}
        onOpenChange={() => undefined}
      >
        <div
          ref={scrollRef}
          className={styles.scroller}
          tabIndex={0}
          role="listbox"
          aria-multiselectable
          aria-label={t('graph.label')}
          aria-activedescendant={
            // The id exists only while the row is in the virtualized window.
            selectedRow !== null && items.some((item) => item.index === selectedRow)
              ? `graph-row-${String(selectedRow)}`
              : undefined
          }
          aria-busy={cache.version === null}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onContextMenuCapture={onContextMenuCapture}
        >
          {cache.version === null && !source.loadError && (
            <div role="status" aria-label={t('graph.loading')}>
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <GraphRowView
                  key={i}
                  repoId={repoId}
                  index={i}
                  data={undefined}
                  top={i * rowHeight}
                  selected={false}
                  match={false}
                  activeMatch={false}
                  columns={rowColumns}
                  messageWidth={messageWidth}
                  pillMetrics={pillMetrics}
                  remoteTags={remoteTags}
                  now={now}
                  locale={locale}
                />
              ))}
            </div>
          )}
          {empty && (
            <div className={styles.empty}>
              <Icon name="commit" size="lg" />
              <p className={styles.emptyTitle}>{t('graph.empty.title')}</p>
              <p className={styles.emptyText}>{t('graph.empty.text')}</p>
            </div>
          )}
          {totalRows > 0 && (
            <div className={styles.content} style={{ height: mapper.physicalHeight }}>
              <GraphCanvas
                source={source}
                scrollRef={scrollRef}
                mapper={mapper}
                rowHeight={rowHeight}
                wipHeight={wipHeight}
                width={widths.graph}
                viewportHeight={size.height}
                totalRows={totalRows}
                dataVersion={source.version}
              />
              {wipShown && (
                <div
                  className={`${styles.wip} ${selection?.kind === 'wip' ? styles.wipSelected : ''}`}
                  data-row="wip"
                  data-wip=""
                  style={offset > 0 ? { transform: `translateY(${String(-offset)}px)` } : undefined}
                  role="option"
                  aria-selected={selection?.kind === 'wip'}
                >
                  <span />
                  <span className={styles.wipText}>
                    <span className={styles.wipLabel}>{t('graph.wip')}</span>
                    <span className={styles.wipCount}>
                      {t('graph.wipFiles', { count: changedFiles(state) })}
                    </span>
                  </span>
                </div>
              )}
              {items.map((item) => {
                const row = cache.row(item.index);
                const mark = row && marks.size > 0 ? marks.get(row.sha) : undefined;
                return (
                  <GraphRowView
                    key={item.index}
                    repoId={repoId}
                    index={item.index}
                    data={row}
                    top={item.start - offset}
                    selected={selectedRow === item.index || source.pickedRows.has(item.index)}
                    match={search.matches.length > 0 && source.isMatch(item.index)}
                    activeMatch={search.active >= 0 && search.matches[search.active] === item.index}
                    columns={rowColumns}
                    messageWidth={messageWidth}
                    pillMetrics={pillMetrics}
                    remoteTags={remoteTags}
                    now={now}
                    locale={locale}
                    bisect={mark}
                    bisectLabel={mark && t(BISECT_MARK_LABELS[mark])}
                  />
                );
              })}
            </div>
          )}
        </div>
      </CommitContextMenu>
      {search.open && <GraphSearchBar source={source} state={search} />}
      {!cache.totalExact && totalRows > 0 && <HistoryWalkStatus rows={totalRows} />}
      <SelectionBar source={source} repoId={repoId} busy={state.operation !== null} />
      {source.loadError && cache.version !== null && (
        <div className={styles.toastError} role="alert">
          {t('graph.loadFailed')}
          <button
            type="button"
            className={styles.retry}
            onClick={() => {
              source.retry();
              toast({ title: t('graph.retrying'), duration: 1500 });
            }}
          >
            {t('error.action.retry')}
          </button>
        </div>
      )}
    </div>
  );
}
