import { useT } from '../../i18n/useT';
import type { RefLabel } from '../../ipc';
import { Icon, type IconName } from '../../ui/Icon';
import { startPress } from '../history/dnd/pointerDrag';
import { checkout } from '../refs/refOps';
import { displayRefs, splitOverflow, type DisplayRef } from './refLabels';
import styles from './RefPills.module.css';

const ICONS: Record<DisplayRef['kind'], IconName> = {
  head: 'check',
  local: 'laptop',
  remote: 'cloud',
  tag: 'tag',
  stash: 'stash',
};

/** Branch labels shown before the message at most; the rest folds into a `+N` chip. */
const MAX_PILLS = 3;

function Pill({ repoId, ref_, color }: { repoId: number; ref_: DisplayRef; color: number }) {
  const t = useT();
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
      <span className={styles.name}>{ref_.name}</span>
      {ref_.remote !== null && (
        <Icon name="cloud" className={styles.cloud} aria-label={ref_.remote} />
      )}
    </span>
  );
}

/** Ref labels of a row (F-023): local and remote merged, HEAD first, overflow as `+N`. */
export function RefPills({
  repoId,
  labels,
  color,
}: {
  repoId: number;
  labels: readonly RefLabel[];
  color: number;
}) {
  const t = useT();
  if (labels.length === 0) return null;
  const { shown, hidden } = splitOverflow(displayRefs(labels), MAX_PILLS);
  return (
    <span className={styles.pills}>
      {shown.map((ref_) => (
        <Pill key={ref_.key} repoId={repoId} ref_={ref_} color={color} />
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
