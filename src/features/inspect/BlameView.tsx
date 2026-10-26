import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { BlameCommit, BlameContent } from '../../ipc';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { copyText } from '../graph/CommitContextMenu';
import { formatBytes } from '../diff/format';
import { revealCommit } from '../repo/graphNavigation';
import { shortOid } from '../repo/repoStatus';
import { blameRows, chunkBounds } from './blameModel';
import { useBlame, useInspectRefresh } from './inspectQueries';
import {
  blameAnother,
  blameBack,
  closeInspect,
  openFileHistory,
  openLineHistory,
  type BlameTarget,
} from './inspectStore';
import { errorOf } from './ipcError';
import { usePublishedLines } from './lineSelection';
import { inSpan, spanOf, type LineSpan } from './lineRange';
import { useCssPixels } from './useCssPixels';
import { useEscapeToClose } from './useEscapeToClose';
import styles from './Blame.module.css';
import common from './Inspect.module.css';

type TextBlame = Extract<BlameContent, { kind: 'text' }>;

/** Selects the commit in the graph (the details panel shows it) and goes back to the graph. */
function showInGraph(repoId: number, sha: string): void {
  closeInspect(repoId);
  revealCommit(repoId, sha, null);
}

function countTabs(line: string): number {
  let tabs = 0;
  for (let i = line.indexOf('\t'); i >= 0; i = line.indexOf('\t', i + 1)) tabs++;
  return tabs;
}

/** The line of a row event target (`data-line`), `null` outside the rows. */
function lineOf(target: EventTarget): number | null {
  const row = target instanceof Element ? target.closest<HTMLElement>('[data-line]') : null;
  return row ? Number(row.dataset.line) : null;
}

interface BlameRowProps {
  line: number;
  top: number;
  text: string;
  commit: BlameCommit | undefined;
  /** First line of a chunk: shows the commit. */
  first: boolean;
  ageStep: number;
  selected: boolean;
  /** In the line range selected for its history. */
  inRange: boolean;
  date: string;
  uncommittedLabel: string;
}

/**
 * One line. Memoized: while scrolling, only the rows entering the window render (events are
 * delegated to the grid, so no handler changes between renders).
 */
const BlameRow = memo(function BlameRow({
  line,
  top,
  text,
  commit,
  first,
  ageStep,
  selected,
  inRange,
  date,
  uncommittedLabel,
}: BlameRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={line + 1}
      className={styles.row}
      data-line={line}
      data-age={ageStep}
      data-chunk={first}
      data-selected={selected}
      data-range={inRange}
      data-uncommitted={commit?.uncommitted === true}
      style={{ transform: `translateY(${String(top)}px)` }}
    >
      <span className={styles.age} aria-hidden="true" />
      <span className={styles.info} role="gridcell">
        {first && commit && (
          <>
            <span className={styles.summary} title={commit.summary}>
              {commit.uncommitted ? uncommittedLabel : commit.summary}
            </span>
            {!commit.uncommitted && <span className={styles.author}>{commit.authorName}</span>}
            <span className={styles.date}>{date}</span>
          </>
        )}
      </span>
      <span className={styles.number} role="gridcell">
        {line + 1}
      </span>
      <span className={styles.code} role="gridcell">
        {text}
      </span>
    </div>
  );
});

function BlameLines({
  repoId,
  path,
  rev,
  content,
  focusLine,
}: {
  repoId: number;
  path: string;
  /** Version blamed (full SHA), `null` for the working tree. */
  rev: string | null;
  content: TextBlame;
  focusLine: number | undefined;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const { lines, commits, chunks } = content;
  const rows = useMemo(() => blameRows(lines.length, commits, chunks), [lines, commits, chunks]);
  const [selected, setSelected] = useState<number | null>(null);
  const [menuLine, setMenuLine] = useState<number | null>(null);
  /** Lines selected for their history (0-based): a click sets both ends, `Shift` the focus. */
  const [range, setRange] = useState<{ anchor: number; focus: number } | null>(null);
  const span = range && spanOf(range.anchor, range.focus);
  // The palette's "History of the selected lines" (F-223) opens the same range.
  usePublishedLines(repoId, span ? { path, rev, ...span } : null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useCssPixels('--blame-row-height', 20);
  const digits = String(lines.length).length;
  // Monospace: the widest line in characters gives the content width, so rows can have a fixed
  // size (`contain: strict`) and still scroll horizontally.
  const columns = useMemo(
    () => lines.reduce((max, line) => Math.max(max, line.length + 3 * countTabs(line)), 0),
    [lines],
  );

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
  });
  const relative = (time: number | null) =>
    time === null ? '' : formatRelativeTime(time, now, locale);
  const uncommittedLabel = t('inspect.blame.uncommitted');
  useEffect(() => {
    if (focusLine !== undefined && focusLine < lines.length) {
      virtualizer.scrollToIndex(focusLine, { align: 'center' });
    }
  }, [focusLine, lines.length, virtualizer]);

  const select = (line: number) => {
    const index = rows.commitOf[line] ?? 0;
    setSelected(index);
    const commit = commits[index];
    // The details panel follows the graph selection.
    if (commit && !commit.uncommitted) revealCommit(repoId, commit.sha, null);
  };
  const blameParent = (commit: BlameCommit, line: number) => {
    if (!commit.previous) return;
    const [first] = chunkBounds(rows, line);
    const chunk = chunks.find((c) => c.start === first);
    blameAnother(repoId, {
      path: commit.previous.path,
      rev: commit.previous.sha,
      line: chunk?.sourceStart ?? line,
    });
  };
  const historyOf = (lines: LineSpan) => {
    openLineHistory(repoId, { path, rev, ...lines });
  };
  /** The range a menu opened on `line` acts on: the selection when it holds the line. */
  const menuSpan = (line: number): LineSpan =>
    span && inSpan(span, line) ? span : spanOf(line, line);
  const spanLabel = (lines: LineSpan) =>
    lines.start === lines.end
      ? t('inspect.blame.lineHistorySingle', { line: lines.start })
      : t('inspect.blame.lineHistory', { start: lines.start, end: lines.end });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (event.shiftKey) {
      // Extends the line range by one line.
      const start = selected === null ? 0 : Math.max(0, rows.commitOf.indexOf(selected));
      const anchor = range?.anchor ?? start;
      const from = range?.focus ?? anchor;
      const focus = Math.min(
        lines.length - 1,
        Math.max(0, from + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      setRange({ anchor, focus });
      virtualizer.scrollToIndex(focus, { align: 'auto' });
      return;
    }
    const current = selected === null ? -1 : rows.commitOf.indexOf(selected);
    // Moves to the next / previous chunk.
    let line = current;
    if (event.key === 'ArrowDown') {
      line = current < 0 ? 0 : chunkBounds(rows, current)[1] + 1;
    } else if (current > 0) {
      line = chunkBounds(rows, chunkBounds(rows, current)[0] - 1)[0];
    }
    if (line < 0 || line >= lines.length) return;
    select(line);
    setRange({ anchor: line, focus: line });
    virtualizer.scrollToIndex(line, { align: 'auto' });
  };

  const menuCommit = menuLine === null ? undefined : commits[rows.commitOf[menuLine] ?? 0];
  const selectedCommit = selected === null ? undefined : commits[selected];
  const selectedLine = selected === null ? -1 : rows.commitOf.indexOf(selected);

  return (
    <>
      <ContextMenu
        content={
          menuCommit &&
          menuLine !== null && (
            <>
              <ContextMenuItem
                icon="blame"
                disabled={!menuCommit.previous}
                hint={menuCommit.previous ? undefined : t('inspect.blame.noParent')}
                onSelect={() => {
                  blameParent(menuCommit, menuLine);
                }}
              >
                {t('inspect.blame.parent')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="commit"
                disabled={menuCommit.uncommitted}
                onSelect={() => {
                  showInGraph(repoId, menuCommit.sha);
                }}
              >
                {t('inspect.showInGraph')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="history"
                onSelect={() => {
                  historyOf(menuSpan(menuLine));
                }}
              >
                {spanLabel(menuSpan(menuLine))}
              </ContextMenuItem>
              <ContextMenuItem
                icon="history"
                onSelect={() => {
                  openFileHistory(repoId, path);
                }}
              >
                {t('inspect.action.history')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon="copy"
                disabled={menuCommit.uncommitted}
                hint={<code>{shortOid(menuCommit.sha)}</code>}
                onSelect={() => {
                  copyText(menuCommit.sha, t('graph.menu.shaCopied'));
                }}
              >
                {t('graph.menu.copySha')}
              </ContextMenuItem>
            </>
          )
        }
      >
        <div
          ref={scrollRef}
          className={styles.lines}
          role="grid"
          aria-label={t('inspect.blame.lines', { path })}
          aria-rowcount={lines.length}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onMouseDown={(event) => {
            // Shift-click extends the line range, not the text selection.
            if (event.shiftKey) event.preventDefault();
          }}
          onClick={(event) => {
            const line = lineOf(event.target);
            if (line === null) return;
            if (event.shiftKey && range) {
              setRange({ anchor: range.anchor, focus: line });
              return;
            }
            select(line);
            setRange({ anchor: line, focus: line });
          }}
          onContextMenu={(event) => {
            setMenuLine(lineOf(event.target));
          }}
          style={{ '--digits': digits, '--columns': columns } as CSSProperties}
        >
          <div
            className={styles.inner}
            style={{ height: `${String(virtualizer.getTotalSize())}px` }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const line = item.index;
              const index = rows.commitOf[line] ?? 0;
              const first = rows.chunkStart[line] === 1;
              return (
                <BlameRow
                  key={item.key}
                  line={line}
                  top={item.start}
                  text={lines[line] ?? ''}
                  commit={commits[index]}
                  first={first}
                  ageStep={rows.ageStep[index] ?? 0}
                  selected={selected === index}
                  inRange={inSpan(span, line)}
                  date={first ? relative(commits[index]?.authorTime ?? null) : ''}
                  uncommittedLabel={uncommittedLabel}
                />
              );
            })}
          </div>
        </div>
      </ContextMenu>
      {selectedCommit && (
        <div className={styles.bar} aria-label={t('inspect.blame.selected')}>
          {selectedCommit.uncommitted ? (
            <span className={styles.barSummary}>{t('inspect.blame.uncommittedLong')}</span>
          ) : (
            <>
              <span className={styles.barSha}>{shortOid(selectedCommit.sha)}</span>
              <span className={styles.barSummary}>{selectedCommit.summary}</span>
              <span className={common.muted}>
                {selectedCommit.authorName} ·{' '}
                {selectedCommit.authorTime === null
                  ? ''
                  : formatRelativeTime(selectedCommit.authorTime, now, locale)}
              </span>
            </>
          )}
          <span className={common.spacer} />
          {span && (
            <Button
              size="sm"
              variant="ghost"
              title={t('inspect.blame.rangeHint')}
              onClick={() => {
                historyOf(span);
              }}
            >
              <Icon name="history" />
              {spanLabel(span)}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!selectedCommit.previous}
            title={selectedCommit.previous ? undefined : t('inspect.blame.noParent')}
            onClick={() => {
              blameParent(selectedCommit, selectedLine);
            }}
          >
            <Icon name="blame" />
            {t('inspect.blame.parent')}
          </Button>
          {!selectedCommit.uncommitted && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                showInGraph(repoId, selectedCommit.sha);
              }}
            >
              <Icon name="commit" />
              {t('inspect.showInGraph')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Blame of a file (F-221): each line with the commit that last changed it, shaded by age.
 * A click selects the commit in the graph; "Blame of the parent" goes one version back.
 */
export function BlameView({
  repoId,
  target,
  trail,
}: {
  repoId: number;
  target: BlameTarget;
  trail: readonly BlameTarget[];
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const query = useBlame(repoId, target);
  useInspectRefresh(repoId);
  const close = () => {
    closeInspect(repoId);
  };
  useEscapeToClose(close);
  // A placeholder (the previous version) stays shown while the next one loads.
  const blame = query.data;
  const content = blame?.content;
  const previous = trail[trail.length - 1];

  let body;
  if (query.isError) {
    body = (
      <div className={common.centered}>
        <ErrorPanel
          title={t('inspect.blame.failed')}
          error={errorOf(query.error)}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  } else if (!content) {
    body = (
      <div className={common.centered} role="status">
        <Spinner />
        <span>{t('inspect.blame.loading')}</span>
      </div>
    );
  } else if (content.kind === 'binary') {
    body = (
      <div className={common.centered}>
        <Icon name="file" size="lg" />
        <span>{t('inspect.blame.binary', { size: formatBytes(content.size ?? 0, locale) })}</span>
      </div>
    );
  } else if (content.kind === 'notCommitted') {
    body = (
      <div className={common.centered}>
        <Icon name="file" size="lg" />
        <span>{t('inspect.blame.notCommitted')}</span>
      </div>
    );
  } else if (content.lines.length === 0) {
    body = (
      <div className={common.centered}>
        <span>{t('inspect.blame.empty')}</span>
      </div>
    );
  } else {
    body = (
      <BlameLines
        key={`${blame.path}@${blame.rev ?? ''}`}
        repoId={repoId}
        path={blame.path}
        rev={blame.rev}
        content={content}
        focusLine={target.line}
      />
    );
  }

  return (
    <section className={common.view} aria-label={t('inspect.blame.label', { path: target.path })}>
      <header className={common.toolbar}>
        <Button size="sm" variant="ghost" onClick={close}>
          <Icon name="back" />
          {t('diff.back')}
          <Kbd shortcut="Escape" />
        </Button>
        {previous && (
          <IconButton
            icon="undo"
            size="sm"
            label={t('inspect.blame.backTo', {
              version: previous.rev ? shortOid(previous.rev) : t('inspect.workingTree'),
            })}
            onClick={() => {
              blameBack(repoId);
            }}
          />
        )}
        <span className={common.title}>
          <Icon name="blame" className={common.titleIcon} />
          <span className={common.path} title={target.path}>
            {target.path}
          </span>
        </span>
        <span className={common.chip} title={target.rev ?? undefined}>
          {target.rev ? shortOid(target.rev) : t('inspect.workingTree')}
        </span>
        {content?.kind === 'text' && content.encoding === 'windows1252' && (
          <span className={common.chip}>{t('diff.notice.encoding')}</span>
        )}
        {query.isFetching && <Spinner />}
        <span className={common.spacer} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            openFileHistory(repoId, target.path, target.rev);
          }}
        >
          <Icon name="history" />
          {t('inspect.action.history')}
        </Button>
      </header>
      {body}
    </section>
  );
}
