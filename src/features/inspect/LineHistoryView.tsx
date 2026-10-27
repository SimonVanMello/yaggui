import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';

import { queryClient } from '../../app/queryClient';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { modalOpen } from '../../app/shellActions';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { DiffViewMode, LineHistoryEntry, LineHistoryRequest } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { matchShortcut } from '../../ui/shortcuts';
import { useNow } from '../../ui/useNow';
import type { CodeDiffHandle } from '../diff/CodeDiff';
import { CodeDiffLoader } from '../diff/CodeDiffLoader';
import { toggleDiffView, useDiffView } from '../diff/diffStore';
import { splitPath } from '../diff/fileTree';
import { STATUS_LETTER } from '../diff/format';
import { revealCommit } from '../repo/graphNavigation';
import { shortOid } from '../repo/repoStatus';
import { FileInspectButtons } from './FileInspectButtons';
import { inspectKeys, useInspectRefresh, useLineHistory } from './inspectQueries';
import { closeInspect, openLineHistory } from './inspectStore';
import { errorOf } from './ipcError';
import { entrySpan, type LineSpan } from './lineRange';
import { useEscapeToClose } from './useEscapeToClose';
import styles from './FileHistory.module.css';
import common from './Inspect.module.css';
import own from './LineHistory.module.css';

const ROW_HEIGHT = 56;
/** Rows from the end at which the next page is asked for. */
const PREFETCH_ROWS = 50;

function useLinesLabel(): (span: LineSpan) => string {
  const t = useT();
  return (span) =>
    span.start === span.end
      ? t('inspect.lines.single', { line: span.start })
      : t('inspect.lines.range', { start: span.start, end: span.end });
}

function EntryRow({
  entry,
  top,
  selected,
  now,
  onSelect,
}: {
  entry: LineHistoryEntry;
  top: number;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const lines = useLinesLabel();
  const merge = entry.diff === null;
  const status = merge ? 'merge' : entry.status;
  const span = entrySpan(entry);
  return (
    <div
      role="option"
      aria-selected={selected}
      className={styles.row}
      style={{ transform: `translateY(${String(top)}px)` }}
      onClick={onSelect}
      title={entry.summary}
    >
      <span
        className={`${common.status} ${styles.badge}`}
        data-status={status}
        aria-label={merge ? t('inspect.history.merge') : t(`diff.status.${entry.status}`)}
      >
        {merge ? '⑂' : STATUS_LETTER[entry.status]}
      </span>
      <span className={styles.summary}>{entry.summary}</span>
      <span className={styles.sha}>{shortOid(entry.sha)}</span>
      <span className={styles.meta}>
        {entry.authorName} ·{' '}
        {entry.authorTime === null ? '' : formatRelativeTime(entry.authorTime, now, locale)}
        {span && ` · ${lines(span)}`}
        {entry.oldPath && entry.oldPath !== entry.path && (
          <>
            {' · '}
            <span className={styles.renamed}>{t('diff.from', { path: entry.oldPath })}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** The selected commit's change to the range: notices, then the code of the range. */
function EntryDiff({
  repoId,
  entry,
  view,
  code,
}: {
  repoId: number;
  entry: LineHistoryEntry;
  view: DiffViewMode;
  code: Ref<CodeDiffHandle>;
}) {
  const t = useT();
  if (!entry.diff) {
    return (
      <div className={common.centered}>
        <span className={common.status} data-status="merge" aria-hidden="true">
          ⑂
        </span>
        <span>{t('inspect.lineHistory.merge')}</span>
      </div>
    );
  }
  return (
    <>
      {(entry.origin || entry.oldPath !== null) && (
        <div className={own.notices}>
          {entry.oldPath !== null && (
            <p className={own.notice}>
              <Icon name="info" />
              {t('inspect.lineHistory.renamed', { from: entry.oldPath, to: entry.path })}
            </p>
          )}
          {entry.origin && (
            <p className={own.notice}>
              <Icon name="info" />
              {entry.status === 'added'
                ? t('inspect.lineHistory.originFile')
                : t('inspect.lineHistory.origin')}
            </p>
          )}
        </div>
      )}
      <div className={own.code}>
        <CodeDiffLoader
          diff={entry.diff}
          view={view}
          path={entry.path}
          worktree={null}
          ref={code}
          onLineHistory={(span) => {
            openLineHistory(repoId, { path: entry.path, rev: entry.sha, ...span });
          }}
        />
      </div>
    </>
  );
}

/**
 * History of a line range (F-223): the commits that changed the lines on the left, the
 * selected commit's change to the range on the right. `j` / `k` and ↑ / ↓ step through
 * commits. The walk can be stopped while it runs (`git log -L` reads the whole history).
 */
export function LineHistoryView({
  repoId,
  request,
}: {
  repoId: number;
  request: LineHistoryRequest;
}) {
  const t = useT();
  const now = useNow();
  const lines = useLinesLabel();
  const view = useDiffView();
  const query = useLineHistory(repoId, request);
  useInspectRefresh(repoId);
  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  const range = query.data?.pages[0]?.range;
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // Stopped by the user: the next pages are only loaded on demand.
  const [stopped, setStopped] = useState(false);
  const found = selectedSha === null ? -1 : entries.findIndex((e) => e.sha === selectedSha);
  const index = found >= 0 ? found : entries.length > 0 ? 0 : -1;
  const selected = index >= 0 ? entries[index] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const code = useRef<CodeDiffHandle>(null);
  const close = () => {
    // A line selection in the diff goes first.
    if (code.current?.clearSelection()) return;
    closeInspect(repoId);
  };
  const stop = () => {
    setStopped(true);
    void queryClient.cancelQueries({ queryKey: inspectKeys.lineHistory(repoId, request) });
  };

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => entries[i]?.sha ?? i,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastShown = items[items.length - 1]?.index ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  // While a page is being searched, `Esc` stops the walk first.
  const searching = (query.isPending && query.fetchStatus === 'fetching') || isFetchingNextPage;
  useEscapeToClose(searching ? stop : close);
  useEffect(() => {
    if (
      !stopped &&
      hasNextPage &&
      !isFetchingNextPage &&
      lastShown >= entries.length - PREFETCH_ROWS
    ) {
      void fetchNextPage();
    }
  }, [stopped, hasNextPage, isFetchingNextPage, fetchNextPage, lastShown, entries.length]);

  const go = (target: number) => {
    const next = entries[target];
    if (!next) return;
    setSelectedSha(next.sha);
    virtualizer.scrollToIndex(target, { align: 'auto' });
  };
  // `j` / `k` anywhere in the view, like the file history's diff.
  const step = useRef<(direction: 1 | -1) => void>(() => undefined);
  useEffect(() => {
    step.current = (direction) => {
      go(index + direction);
    };
  });
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      if (modalOpen() || document.querySelector('[role="menu"][data-state="open"]')) return;
      if (matchShortcut(event, 'Mod+D')) {
        toggleDiffView();
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === 'j' || event.key === 'k')
      ) {
        step.current(event.key === 'j' ? 1 : -1);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? entries.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    go(target);
  };

  const requested = { start: request.start, end: request.end };
  const count = hasNextPage ? `${String(entries.length)}+` : String(entries.length);
  const cancelled = query.isPending && query.fetchStatus === 'idle';
  const retry = () => {
    setStopped(false);
    void query.refetch();
  };

  let right;
  if (selected) {
    right = (
      <div className={own.pane}>
        <header className={common.toolbar}>
          <Button size="sm" variant="ghost" onClick={close}>
            <Icon name="back" />
            {t('diff.back')}
            <Kbd shortcut="Escape" />
          </Button>
          <span className={common.spacer} />
          <IconButton
            icon="chevronUp"
            size="sm"
            label={t('inspect.history.newer')}
            disabled={index <= 0}
            onClick={() => {
              go(index - 1);
            }}
          />
          <span className={common.muted}>
            {t('diff.position', { index: index + 1, total: count })}
          </span>
          <IconButton
            icon="chevronDown"
            size="sm"
            label={t('inspect.history.older')}
            disabled={index >= entries.length - 1}
            onClick={() => {
              go(index + 1);
            }}
          />
          <IconButton
            icon="commit"
            size="sm"
            label={t('inspect.showInGraph')}
            onClick={() => {
              closeInspect(repoId);
              revealCommit(repoId, selected.sha, null);
            }}
          />
          <FileInspectButtons
            repoId={repoId}
            path={selected.path}
            rev={selected.sha}
            history={true}
          />
          <IconButton
            icon={view === 'split' ? 'diffUnified' : 'diffSplit'}
            size="sm"
            label={view === 'split' ? t('diff.unified') : t('diff.split')}
            shortcut="Mod+D"
            onClick={toggleDiffView}
          />
        </header>
        <EntryDiff key={selected.sha} repoId={repoId} entry={selected} view={view} code={code} />
      </div>
    );
  } else {
    right = (
      <div className={common.centered}>
        {query.isError ? (
          <ErrorPanel
            title={t('inspect.lineHistory.failed')}
            error={errorOf(query.error)}
            context={{ retry }}
          />
        ) : cancelled ? (
          <>
            <span>{t('inspect.lineHistory.stopped')}</span>
            <Button size="sm" variant="secondary" onClick={retry}>
              <Icon name="retry" />
              {t('inspect.lineHistory.retry')}
            </Button>
          </>
        ) : query.isPending ? (
          <>
            <Spinner />
            <span role="status">
              {t('inspect.lineHistory.loading', { lines: lines(requested) })}
            </span>
            <Button size="sm" variant="secondary" onClick={stop}>
              {t('inspect.lineHistory.stop')}
              <Kbd shortcut="Escape" />
            </Button>
          </>
        ) : (
          <span>{t('inspect.lineHistory.empty')}</span>
        )}
        {!query.isPending || cancelled ? (
          <Button size="sm" variant="ghost" onClick={close}>
            <Icon name="back" />
            {t('diff.back')}
            <Kbd shortcut="Escape" />
          </Button>
        ) : null}
      </div>
    );
  }

  const shown = range ?? { ...requested, rev: request.rev, path: request.path };
  return (
    <section
      className={common.view}
      aria-label={t('inspect.lineHistory.label', { lines: lines(requested), path: request.path })}
    >
      <div className={styles.layout}>
        <div className={styles.list}>
          <header className={common.toolbar}>
            <span className={common.title}>
              <Icon name="history" className={common.titleIcon} />
              <span className={common.path} title={shown.path}>
                {splitPath(shown.path).name}
              </span>
            </span>
            <span className={common.chip}>{lines(shown)}</span>
            <span className={common.spacer} />
            <span className={common.chip} title={shown.rev ?? undefined}>
              {shown.rev ? shortOid(shown.rev) : t('inspect.workingTree')}
            </span>
            {!query.isPending && (
              <span className={common.muted}>
                {t('inspect.history.count', { count: entries.length, shown: count })}
              </span>
            )}
          </header>
          {request.rev === null &&
            range &&
            (range.start !== request.start || range.end !== request.end) && (
              <p className={own.mapped}>
                {t('inspect.lineHistory.mapped', {
                  from: lines(requested),
                  to: lines(range),
                })}
              </p>
            )}
          <div
            ref={scrollRef}
            className={common.scroll}
            role="listbox"
            aria-label={t('inspect.lineHistory.commits')}
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            <div
              className={common.inner}
              style={{ height: `${String(virtualizer.getTotalSize())}px` }}
            >
              {items.map((item) => {
                const entry = entries[item.index];
                if (!entry) return null;
                return (
                  <EntryRow
                    key={item.key}
                    entry={entry}
                    top={item.start}
                    selected={item.index === index}
                    now={now}
                    onSelect={() => {
                      setSelectedSha(entry.sha);
                    }}
                  />
                );
              })}
            </div>
            {isFetchingNextPage ? (
              <div className={own.more} role="status">
                <Spinner />
                <span>{t('inspect.lineHistory.loadingMore', { count: entries.length })}</span>
                <Button size="sm" variant="ghost" onClick={stop}>
                  {t('inspect.lineHistory.stop')}
                </Button>
              </div>
            ) : (
              stopped &&
              hasNextPage && (
                <div className={own.more}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void fetchNextPage();
                    }}
                  >
                    {t('inspect.lineHistory.more')}
                  </Button>
                </div>
              )
            )}
          </div>
        </div>
        <div className={styles.diff}>{right}</div>
      </div>
    </section>
  );
}
