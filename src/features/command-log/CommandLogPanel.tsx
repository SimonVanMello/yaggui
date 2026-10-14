import { useShortcut } from '../keybindings/registry';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { showError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { useShellStore, type LogFilter } from '../../app/shellStore';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { useRepoSessions } from '../repo/repoSessions';
import { useKnownRepos } from '../repo/useKnownRepos';
import styles from './CommandLogPanel.module.css';
import { LogEntryRow } from './LogEntryRow';
import { useCommandLog } from './useCommandLog';

/** Collapsed row height estimate; expanded rows are measured. */
const ROW_ESTIMATE = 28;

/** Command log (F-300): every Git command with duration, exit code and output, copyable. */
export function CommandLogPanel() {
  const t = useT();
  const logShortcut = useShortcut('view.log');
  const log = useCommandLog();
  const height = useShellStore((state) => state.logHeight);
  const filter = useShellStore((state) => state.logFilter);
  const highlight = useShellStore((state) => state.highlightedLogEntry);
  const activeRepoId = useTabsStore((state) => selectActiveTab(state).repoId);
  const sessions = useRepoSessions((state) => state.sessions);
  const known = useKnownRepos().data;
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [flashId, setFlashId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const repoNames = useMemo(() => {
    const names = new Map<number, string>();
    known?.forEach((repo) => names.set(repo.id, repo.name));
    Object.values(sessions).forEach((session) => {
      if (session?.status === 'open') names.set(session.info.id, session.info.name);
    });
    return names;
  }, [known, sessions]);

  const effectiveFilter: LogFilter = activeRepoId === null ? 'all' : filter;
  const entries = useMemo(() => {
    const all = log.data ?? [];
    const visible =
      effectiveFilter === 'repo' ? all.filter((entry) => entry.repoId === activeRepoId) : all;
    // Newest first: the latest command is visible without scrolling.
    return [...visible].reverse();
  }, [log.data, effectiveFilter, activeRepoId]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => entries[index]?.id ?? index,
    overscan: 8,
  });

  // Opened from an error's "Open command log" action: reveal the relevant entry.
  useEffect(() => {
    if (highlight === null || !log.data) return;
    const target =
      highlight === 'lastFailed'
        ? log.data.findLast((entry) => entry.status !== 'success')
        : log.data.find((entry) => entry.id === highlight);
    useShellStore.getState().clearLogHighlight();
    if (!target) return;
    if (effectiveFilter === 'repo' && target.repoId !== activeRepoId) {
      useShellStore.getState().setLogFilter('all');
    }
    setExpanded((previous) => new Set(previous).add(target.id));
    setFlashId(target.id);
    requestAnimationFrame(() => {
      const index = entries.findIndex((entry) => entry.id === target.id);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' });
    });
  }, [highlight, log.data, entries, effectiveFilter, activeRepoId, virtualizer]);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    document.body.dataset.resizing = 'row';
    const onMove = (move: PointerEvent) => {
      useShellStore.getState().setLogHeight(startHeight + startY - move.clientY);
    };
    const onUp = () => {
      delete document.body.dataset.resizing;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const clear = async () => {
    try {
      await unwrap(ipc.commands.clearCommandLog());
      queryClient.setQueryData(queryKeys.commandLog, []);
      setExpanded(new Set());
    } catch (error) {
      showError(error);
    }
  };

  let body;
  if (log.isPending) {
    body = (
      <div className={styles.placeholder}>
        <Spinner />
      </div>
    );
  } else if (log.error) {
    body = (
      <div className={styles.placeholder}>
        <ErrorPanel
          compact
          title={t('log.loadFailed')}
          error={
            log.error instanceof YagguiIpcError
              ? log.error.error
              : {
                  code: 'internal',
                  message: { en: log.error.message, fr: log.error.message },
                  action: null,
                  detail: null,
                  payload: null,
                }
          }
          context={{ retry: () => void log.refetch() }}
        />
      </div>
    );
  } else if (entries.length === 0) {
    body = (
      <div className={styles.placeholder}>
        {effectiveFilter === 'repo' ? t('log.emptyRepo') : t('log.empty')}
      </div>
    );
  } else {
    body = (
      <div ref={scrollRef} className={styles.scroller}>
        <div className={styles.virtual} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            if (!entry) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={styles.virtualRow}
                style={{ transform: `translateY(${String(item.start)}px)` }}
              >
                <LogEntryRow
                  entry={entry}
                  repoName={
                    effectiveFilter === 'all' && entry.repoId !== null
                      ? (repoNames.get(entry.repoId) ?? null)
                      : null
                  }
                  expanded={expanded.has(entry.id)}
                  highlighted={entry.id === flashId}
                  onToggle={() => {
                    setExpanded((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(entry.id)) next.add(entry.id);
                      return next;
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section
      id="command-log"
      className={styles.panel}
      style={{ height }}
      aria-label={t('log.title')}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('log.resize')}
        className={styles.resizer}
        onPointerDown={onResizeStart}
      />
      <header className={styles.header}>
        <h2 className={styles.title}>{t('log.title')}</h2>
        {activeRepoId !== null && (
          <SegmentedControl<LogFilter>
            label={t('log.filter')}
            value={effectiveFilter}
            options={[
              { value: 'repo', label: t('log.filter.repo') },
              { value: 'all', label: t('log.filter.all') },
            ]}
            onChange={(value) => {
              useShellStore.getState().setLogFilter(value);
            }}
          />
        )}
        <span className={styles.count}>{t('log.count', { count: entries.length })}</span>
        <span className={styles.headerActions}>
          <IconButton
            icon="trash"
            size="sm"
            label={t('log.clear')}
            disabled={!log.data?.length}
            onClick={() => void clear()}
          />
          <IconButton
            icon="close"
            size="sm"
            label={t('log.hide')}
            shortcut={logShortcut}
            onClick={() => {
              useShellStore.getState().setLogOpen(false);
            }}
          />
        </span>
      </header>
      {body}
    </section>
  );
}
