import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { queryClient } from '../../app/queryClient';
import { useRepoEvent } from '../../app/tabs/tabSuspension';
import { useT } from '../../i18n/useT';
import {
  COMPARE_MAX_COMMITS,
  YagguiIpcError,
  ipc,
  unwrap,
  type ChangedFile,
  type ComparedCommit,
  type Comparison,
  type DiffTarget,
  type YagguiError,
} from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { ChangedFileList } from '../diff/ChangedFileList';
import { useChangedFiles } from '../diff/diffQueries';
import { closeDiff, openDiff, useDiffSelection } from '../diff/diffStore';
import { Avatar } from '../graph/Avatar';
import { useRowHeight } from '../graph/useRowHeight';
import { revealCommit } from '../repo/graphNavigation';
import { shortOid } from '../repo/repoStatus';
import { closeCompare, swapCompare, type CompareRequest } from './compareStore';
import styles from './ComparePanel.module.css';

const compareKey = (repoId: number, request: CompareRequest) =>
  ['compare', repoId, request.a.rev, request.b.rev] as const;

function asYagguiError(error: Error): YagguiError {
  return error instanceof YagguiIpcError
    ? error.error
    : {
        code: 'internal',
        message: { en: error.message, fr: error.message },
        action: null,
        detail: null,
        payload: null,
      };
}

type Row =
  | { kind: 'heading'; side: 'a' | 'b'; label: string; count: number }
  | { kind: 'commit'; commit: ComparedCommit }
  | { kind: 'more'; count: number }
  | { kind: 'none' };

function rowsOf(cmp: Comparison, labels: { a: string; b: string }): Row[] {
  const rows: Row[] = [];
  const side = (key: 'a' | 'b', list: ComparedCommit[], count: number) => {
    rows.push({ kind: 'heading', side: key, label: labels[key], count });
    if (list.length === 0) rows.push({ kind: 'none' });
    for (const commit of list) rows.push({ kind: 'commit', commit });
    if (count > list.length) rows.push({ kind: 'more', count: count - list.length });
  };
  side('a', cmp.onlyA, cmp.onlyACount);
  side('b', cmp.onlyB, cmp.onlyBCount);
  return rows;
}

/** Commits of each side, one virtualized list (up to `COMPARE_MAX_COMMITS` per side). */
function CommitLists({
  repoId,
  cmp,
  labels,
}: {
  repoId: number;
  cmp: Comparison;
  labels: { a: string; b: string };
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = rowsOf(cmp, labels);
  // The rows are `--row-height` tall (22 px in compact density): the estimate must follow.
  const rowHeight = useRowHeight();
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  return (
    <div ref={scrollRef} className={styles.list}>
      <div className={styles.listInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const style = { transform: `translateY(${String(item.start)}px)` };
          switch (row.kind) {
            case 'heading':
              return (
                <h3 key={item.key} className={styles.heading} style={style}>
                  <span className={styles.headingLabel}>
                    {t('compare.only', { name: row.label })}
                  </span>
                  <span className={styles.count}>{row.count}</span>
                </h3>
              );
            case 'none':
              return (
                <p key={item.key} className={styles.none} style={style}>
                  {t('compare.none')}
                </p>
              );
            case 'more':
              return (
                <p key={item.key} className={styles.none} style={style}>
                  {t('compare.more', { count: row.count, max: COMPARE_MAX_COMMITS })}
                </p>
              );
            case 'commit':
              return (
                <button
                  key={item.key}
                  type="button"
                  className={styles.commit}
                  style={style}
                  title={row.commit.summary}
                  onClick={() => {
                    revealCommit(repoId, row.commit.sha, row.commit.row, cmp.version);
                  }}
                >
                  <Avatar name={row.commit.authorName} email={row.commit.authorEmail} />
                  <span className={styles.summary}>{row.commit.summary}</span>
                  <code className={styles.sha}>{shortOid(row.commit.sha)}</code>
                </button>
              );
          }
        })}
      </div>
    </div>
  );
}

function Files({ repoId, tabId, cmp }: { repoId: number; tabId: string; cmp: Comparison }) {
  const t = useT();
  // What A has that B lacks, as `git diff B A`.
  const target: DiffTarget = { kind: 'commits', from: cmp.b, to: cmp.a };
  const query = useChangedFiles(repoId, target);
  const selection = useDiffSelection(tabId);
  const selectedPath =
    selection?.repoId === repoId &&
    selection.target.kind === 'commits' &&
    selection.target.from === cmp.b &&
    selection.target.to === cmp.a
      ? selection.path
      : null;
  if (query.isError) {
    return (
      <ErrorPanel
        compact
        title={t('graph.detail.filesFailed')}
        error={asYagguiError(query.error)}
        context={{ retry: () => void query.refetch() }}
      />
    );
  }
  const files = query.data;
  return (
    <ChangedFileList
      title={t('compare.files', { a: shortOid(cmp.b), b: shortOid(cmp.a) })}
      files={files?.files ?? []}
      statsSkipped={files?.statsSkipped}
      lfsPaths={files?.lfs}
      selectedPath={selectedPath}
      onDeselect={() => {
        closeDiff(tabId);
      }}
      onSelect={(file: ChangedFile) => {
        openDiff(tabId, { repoId, target, path: file.path, oldPath: file.oldPath });
      }}
      emptyText={files ? t('compare.noFiles') : undefined}
    />
  );
}

/**
 * Right panel comparing two revisions (two commits picked in the graph, F-029, or two
 * branches, F-104): commits only on each side, then the global diff.
 */
export function ComparePanel({
  repoId,
  tabId,
  request,
}: {
  repoId: number;
  tabId: string;
  request: CompareRequest;
}) {
  const t = useT();
  const [view, setView] = useState<'commits' | 'files'>('commits');
  const query = useQuery({
    queryKey: compareKey(repoId, request),
    queryFn: () => unwrap(ipc.commands.compareRevisions(repoId, request.a.rev, request.b.rev)),
    staleTime: Infinity,
  });
  // Branch names move with new commits: compare again when refs change.
  useRepoEvent('refsChanged', repoId, () => {
    void queryClient.invalidateQueries({ queryKey: ['compare', repoId] });
  });
  const labels = { a: request.a.label, b: request.b.label };
  const cmp = query.data;

  let body;
  if (query.isError) {
    body = (
      <ErrorPanel
        compact
        title={t('compare.failed')}
        error={asYagguiError(query.error)}
        context={{ retry: () => void query.refetch() }}
      />
    );
  } else if (!cmp) {
    body = (
      <div className={styles.loading} role="status">
        <Spinner />
      </div>
    );
  } else if (view === 'commits') {
    body = <CommitLists repoId={repoId} cmp={cmp} labels={labels} />;
  } else {
    body = <Files repoId={repoId} tabId={tabId} cmp={cmp} />;
  }

  return (
    <section className={styles.panel} aria-label={t('compare.label')}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{t('compare.title')}</h2>
          <IconButton
            icon="close"
            size="sm"
            label={t('compare.close')}
            onClick={() => {
              closeCompare(repoId);
            }}
          />
        </div>
        <div className={styles.sides}>
          <span className={styles.side} title={request.a.rev} data-side="a">
            {request.a.label}
          </span>
          <IconButton
            icon="compare"
            size="sm"
            label={t('compare.swap')}
            onClick={() => {
              swapCompare(repoId);
            }}
          />
          <span className={styles.side} title={request.b.rev} data-side="b">
            {request.b.label}
          </span>
        </div>
        {cmp && (
          <p className={styles.base}>
            {cmp.mergeBase === null ? (
              t('compare.unrelated')
            ) : (
              <>
                {t('compare.mergeBase')}{' '}
                <button
                  type="button"
                  className={styles.baseLink}
                  onClick={() => {
                    if (cmp.mergeBase) revealCommit(repoId, cmp.mergeBase, null, null);
                  }}
                >
                  {shortOid(cmp.mergeBase)}
                </button>
              </>
            )}
          </p>
        )}
        <SegmentedControl
          label={t('compare.view')}
          value={view}
          options={[
            { value: 'commits', label: t('compare.commits') },
            { value: 'files', label: t('compare.filesTab') },
          ]}
          onChange={setView}
        />
      </header>
      <div className={styles.body}>{body}</div>
    </section>
  );
}
