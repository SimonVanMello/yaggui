import { useT } from '../../i18n/useT';
import type { RefLabel } from '../../ipc';
import { Icon, type IconName } from '../../ui/Icon';
import { startPress } from '../history/dnd/pointerDrag';
import { checkout } from '../refs/refOps';
import { fitPills, NAME_MIN_CH, pillArea, truncateMiddle } from './pillFit';
import { displayRefs, splitOverflow, type DisplayRef } from './refLabels';
import styles from './RefPills.module.css';
import { measureWith, type PillMetrics } from './usePillMetrics';

const ICONS: Record<DisplayRef['kind'], IconName> = {
  head: 'check',
  local: 'laptop',
  remote: 'cloud',
  tag: 'tag',
  stash: 'stash',
};

/** Without a measured width (commit detail): pills shown at most, the rest folds into `+N`. */
const MAX_PILLS = 3;

/** Room of the message column of a graph row, for the pills to share. */
export interface PillSpace {
  /** Width of the message column, px. */
  width: number;
  /** The row also shows a signature mark. */
  signed: boolean;
  /** Commit summary sharing the column: pills may use the room it does not need. */
  summary: string;
  metrics: PillMetrics;
}

interface RowLayout {
  shown: DisplayRef[];
  /** Text shown for each of `shown`, truncated in the middle when it does not fit. */
  names: string[];
  hidden: DisplayRef[];
}

function layoutRefs(labels: readonly RefLabel[], space: PillSpace): RowLayout {
  const { metrics } = space;
  const refs = displayRefs(labels);
  const pills = refs.map((ref_) => ({
    name: ref_.name,
    natural: metrics.measure(ref_.name, ref_.isHead),
    chrome:
      metrics.padding +
      (ref_.isHead ? metrics.dot : metrics.icon) +
      metrics.gap +
      (ref_.remote !== null ? metrics.gap + metrics.icon : 0),
  }));
  const extras = metrics.messageGap + (space.signed ? metrics.icon + metrics.messageGap : 0);
  const fit = fitPills(pills, {
    available: pillArea(
      space.width,
      metrics.messageCh,
      extras,
      metrics.measureMessage(space.summary),
    ),
    gap: metrics.gap,
    minName: metrics.ch * NAME_MIN_CH,
    moreChip: (count) => metrics.padding + metrics.measure(`+${String(count)}`, false),
  });
  const shown = refs.slice(0, fit.shown);
  const names = shown.map((ref_, i) => {
    const budget = fit.budgets[i] ?? 0;
    const pill = pills[i];
    return pill && budget >= pill.natural
      ? ref_.name
      : truncateMiddle(ref_.name, budget, measureWith(metrics, ref_.isHead));
  });
  return { shown, names, hidden: refs.slice(fit.shown) };
}

interface CachedLayout {
  width: number;
  signed: boolean;
  summary: string;
  metrics: PillMetrics;
  layout: RowLayout;
}

/**
 * Per row labels (stable objects of the page cache): a row scrolled back into view, or
 * re-rendered for its selection, reuses its layout instead of measuring again.
 */
const layouts = new WeakMap<readonly RefLabel[], CachedLayout>();

function cachedLayout(labels: readonly RefLabel[], space: PillSpace): RowLayout {
  const hit = layouts.get(labels);
  if (
    hit &&
    hit.width === space.width &&
    hit.signed === space.signed &&
    hit.summary === space.summary &&
    hit.metrics === space.metrics
  ) {
    return hit.layout;
  }
  const layout = layoutRefs(labels, space);
  layouts.set(labels, { ...space, layout });
  return layout;
}

function Pill({
  repoId,
  ref_,
  label,
  capped,
  color,
}: {
  repoId: number;
  ref_: DisplayRef;
  /** Text shown, `ref_.name` or a middle-truncated form of it. */
  label: string;
  capped: boolean;
  color: number;
}) {
  const t = useT();
  const truncated = label !== ref_.name;
  const classes = [styles.pill, styles[ref_.kind], ref_.isHead ? styles.current : '']
    .filter(Boolean)
    .join(' ');
  const switchable = ref_.branch !== null;
  return (
    <span
      className={classes}
      data-drop-branch={ref_.kind === 'local' ? ref_.name : undefined}
      data-drop-repo={ref_.kind === 'local' ? repoId : undefined}
      onPointerDown={
        switchable && ref_.branch !== null
          ? (event) => {
              // The pill is dragged as a branch, not as the commit row it sits in.
              event.stopPropagation();
              const name = ref_.branch ?? ref_.name;
              startPress(event, () => ({
                repoId,
                payload: { kind: 'branch', name, remote: ref_.kind === 'remote' },
                label: name,
              }));
            }
          : undefined
      }
      style={{ '--pill-color': `var(--lane-${String(color)})` } as React.CSSProperties}
      title={switchable ? `${ref_.name} — ${t('graph.checkoutHint')}` : ref_.name}
      onDoubleClick={
        switchable && ref_.branch !== null
          ? (event) => {
              event.stopPropagation();
              // The checked-out branch has nothing to switch to.
              if (ref_.isHead) return;
              void checkout(
                repoId,
                ref_.kind === 'remote'
                  ? { kind: 'remote', name: ref_.branch ?? ref_.name }
                  : { kind: 'branch', name: ref_.branch ?? ref_.name },
              );
            }
          : undefined
      }
    >
      {ref_.isHead ? (
        <span className={styles.dot} aria-hidden="true" />
      ) : (
        <Icon name={ICONS[ref_.kind]} />
      )}
      <span
        className={capped ? `${styles.name} ${styles.capped}` : styles.name}
        aria-hidden={truncated || undefined}
      >
        {label}
      </span>
      {truncated && <span className={styles.srOnly}>{ref_.name}</span>}
      {ref_.remote !== null && (
        <Icon name="cloud" className={styles.cloud} aria-label={ref_.remote} />
      )}
    </span>
  );
}

/**
 * Ref labels of a row (F-023): local and remote merged, HEAD first, overflow as `+N`. With a
 * `space` (graph rows), the pills share the message column and long names are cut in the
 * middle; without, at most `MAX_PILLS` with an end ellipsis.
 */
export function RefPills({
  repoId,
  labels,
  color,
  space,
}: {
  repoId: number;
  labels: readonly RefLabel[];
  color: number;
  space?: PillSpace;
}) {
  const t = useT();
  if (labels.length === 0) return null;
  const { shown, names, hidden } = space
    ? cachedLayout(labels, space)
    : { ...splitOverflow(displayRefs(labels), MAX_PILLS), names: null };
  return (
    <span className={styles.pills}>
      {shown.map((ref_, i) => (
        <Pill
          key={ref_.key}
          repoId={repoId}
          ref_={ref_}
          label={names?.[i] ?? ref_.name}
          capped={names === null}
          color={color}
        />
      ))}
      {hidden.length > 0 && (
        <span
          className={`${styles.pill} ${styles.more}`}
          title={hidden.map((h) => h.name).join('\n')}
          aria-label={t('graph.moreRefs', { count: hidden.length })}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
