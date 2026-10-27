import { memo } from 'react';

import type { Locale } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { BisectMarkPill } from '../bisect/BisectMarkPill';
import type { BisectRowMark } from '../bisect/bisectModel';
import { Avatar } from './Avatar';
import type { GraphRow } from './pageCache';
import type { RemoteTagMap } from './remoteTags';
import { RefPills } from './RefPills';
import { SignedMark } from './SignedMark';
import type { PillMetrics } from './usePillMetrics';
import styles from './GraphRowView.module.css';

export interface RowColumns {
  author: boolean;
  /** Under ~64 px only the avatar is shown. */
  authorName: boolean;
  date: boolean;
  sha: boolean;
}

interface Props {
  repoId: number;
  index: number;
  data: GraphRow | undefined;
  top: number;
  selected: boolean;
  match: boolean;
  activeMatch: boolean;
  columns: RowColumns;
  /** Width of the message column, px: the ref pills share it with the summary. */
  messageWidth: number;
  pillMetrics: PillMetrics;
  /** Tags on a remote (opt-in), `null` when not shown. */
  remoteTags: RemoteTagMap | null;
  now: number;
  locale: Locale;
  /** Bisect mark of the commit, when a bisect is in progress (F-263). */
  bisect?: BisectRowMark;
  /** Label of `bisect`, measured to leave the ref pills the rest of the message column. */
  bisectLabel?: string;
}

const dateFormats = new Map<Locale, Intl.DateTimeFormat>();

function absoluteDate(epochSeconds: number, locale: Locale): string {
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'medium' });
    dateFormats.set(locale, format);
  }
  return format.format(epochSeconds * 1000);
}

/** One commit row. Memoized: scrolling and selection changes only re-render the rows involved. */
export const GraphRowView = memo(function GraphRowView({
  repoId,
  index,
  data,
  top,
  selected,
  match,
  activeMatch,
  columns,
  messageWidth,
  pillMetrics,
  remoteTags,
  now,
  locale,
  bisect,
  bisectLabel,
}: Props) {
  const classes = [
    styles.row,
    selected ? styles.selected : '',
    match ? styles.match : '',
    activeMatch ? styles.activeMatch : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (!data) {
    return (
      <div
        className={`${styles.row} ${styles.skeleton}`}
        style={{ transform: `translateY(${String(top)}px)` }}
        data-row={index}
        role="presentation"
      >
        <span className={styles.bar} style={{ width: `${String(30 + ((index * 37) % 40))}%` }} />
      </div>
    );
  }
  const time = data.authorTime;
  const markWidth =
    bisect && bisectLabel
      ? pillMetrics.measure(bisectLabel, false) + pillMetrics.padding + pillMetrics.messageGap
      : 0;
  return (
    <div
      className={classes}
      style={{ transform: `translateY(${String(top)}px)` }}
      data-row={index}
      data-sha={data.sha}
      role="option"
      aria-selected={selected}
      id={`graph-row-${String(index)}`}
    >
      <span className={styles.message}>
        {bisect && bisectLabel && <BisectMarkPill mark={bisect} label={bisectLabel} />}
        <RefPills
          repoId={repoId}
          labels={data.refs}
          color={data.color}
          space={{
            width: messageWidth - markWidth,
            signed: data.signature !== null,
            summary: data.summary,
            metrics: pillMetrics,
            remoteTags,
          }}
        />
        {data.signature && <SignedMark kind={data.signature} locale={locale} />}
        <span className={styles.summary}>{data.summary}</span>
      </span>
      {columns.author && (
        <span className={styles.author} title={`${data.authorName} <${data.authorEmail}>`}>
          <Avatar name={data.authorName} email={data.authorEmail} />
          {columns.authorName && <span className={styles.authorName}>{data.authorName}</span>}
        </span>
      )}
      {columns.date && (
        <span
          className={styles.date}
          title={time === null ? undefined : absoluteDate(time, locale)}
        >
          {time === null ? '' : formatRelativeTime(time, now, locale)}
        </span>
      )}
      {columns.sha && <span className={styles.sha}>{data.sha.slice(0, 7)}</span>}
    </div>
  );
});
