import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { FileHistoryEntry } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { DiffView } from '../diff/DiffView';
import { STATUS_LETTER } from '../diff/format';
import { shortOid } from '../repo/repoStatus';
import { FileInspectButtons } from './FileInspectButtons';
import { useFileHistory, useInspectRefresh } from './inspectQueries';
import { closeInspect } from './inspectStore';
import { errorOf } from './ipcError';
import { useEscapeToClose } from './useEscapeToClose';
import styles from './FileHistory.module.css';
import common from './Inspect.module.css';

const ROW_HEIGHT = 56;
/** Rows from the end at which the next page is asked for. */
const PREFETCH_ROWS = 50;

function EntryRow({
  entry,
  top,
  selected,
  now,
  onSelect,
}: {
  entry: FileHistoryEntry;
  top: number;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const merge = entry.parents.length > 1;
  const status = merge ? 'merge' : entry.status;
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

/**
 * History of a file across renames (F-220): its commits on the left, the selected commit's
 * change to the file on the right (the diff view). `j` / `k` and ↑ / ↓ step through commits.
 */
export function FileHistoryView({
  repoId,
  path,
  rev,
}: {
  repoId: number;
  path: string;
  rev: string | null;
}) {
  const t = useT();
  const now = useNow();
  const query = useFileHistory(repoId, path, rev);
  useInspectRefresh(repoId);
  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const found = selectedSha === null ? -1 : entries.findIndex((e) => e.sha === selectedSha);
  const index = found >= 0 ? found : entries.length > 0 ? 0 : -1;
  const selected = index >= 0 ? entries[index] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const close = () => {
    closeInspect(repoId);
  };
  // The diff view handles `Esc` while it is shown.
  useEscapeToClose(close, selected === undefined);

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
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastShown >= entries.length - PREFETCH_ROWS) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastShown, entries.length]);

  const go = (target: number) => {
    const next = entries[target];
    if (!next) return;
    setSelectedSha(next.sha);
    virtualizer.scrollToIndex(target, { align: 'auto' });
  };
  const step = (direction: 1 | -1) => {
    go(index + direction);
  };
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

  const count = hasNextPage ? `${String(entries.length)}+` : String(entries.length);
  let right;
  if (selected) {
    right = (
      <DiffView
        key={`${selected.sha}:${selected.path}`}
        selection={{
          repoId,
          target: { kind: 'commits', from: null, to: selected.sha },
          path: selected.path,
          oldPath: selected.oldPath,
        }}
        onClose={close}
        onSelect={() => undefined}
        stepper={{
          onStep: step,
          canPrevious: index > 0,
          canNext: index < entries.length - 1,
          position: { index, total: entries.length },
          labels: { previous: t('inspect.history.newer'), next: t('inspect.history.older') },
        }}
        actions={
          <FileInspectButtons
            repoId={repoId}
            path={selected.path}
            rev={selected.status === 'deleted' ? `${selected.sha}^` : selected.sha}
            history={false}
          />
        }
      />
    );
  } else {
    right = (
      <div className={common.centered}>
        {query.isPending ? (
          <Spinner />
        ) : query.isError ? (
          <ErrorPanel
            title={t('inspect.history.failed')}
            error={errorOf(query.error)}
            context={{ retry: () => void query.refetch() }}
          />
        ) : (
          <span>{t('inspect.history.empty', { path })}</span>
        )}
        <Button size="sm" variant="ghost" onClick={close}>
          <Icon name="back" />
          {t('diff.back')}
          <Kbd shortcut="Escape" />
        </Button>
      </div>
    );
  }

  return (
    <section className={common.view} aria-label={t('inspect.history.label', { path })}>
      <div className={styles.layout}>
        <div className={styles.list}>
          <header className={common.toolbar}>
            <span className={common.title}>
              <Icon name="history" className={common.titleIcon} />
              <span className={common.path} title={path}>
                {path}
              </span>
            </span>
            <span className={common.spacer} />
            {rev !== null && <span className={common.chip}>{shortOid(rev)}</span>}
            {!query.isPending && (
              <span className={common.muted}>
                {t('inspect.history.count', { count: entries.length, shown: count })}
              </span>
            )}
          </header>
          <div
            ref={scrollRef}
            className={common.scroll}
            role="listbox"
            aria-label={t('inspect.history.commits')}
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
            {isFetchingNextPage && (
              <div className={common.loadingMore}>
                <Spinner />
              </div>
            )}
          </div>
        </div>
        <div className={styles.diff}>{right}</div>
      </div>
    </section>
  );
}
