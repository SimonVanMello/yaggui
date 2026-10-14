import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { compareCommits, jumpToMergeBase } from '../compare/compareActions';
import { cherryPickCommits, currentBranchOf } from '../history/historyOps';
import type { GraphSource } from './graphSource';
import styles from './SelectionBar.module.css';

/**
 * Appears while several commits are selected (⌘ / ⇧-click): says how many and offers the
 * actions that take the whole selection, so they are reachable without the context menu.
 */
export function SelectionBar({
  source,
  repoId,
  busy,
}: {
  source: GraphSource;
  repoId: number;
  busy: boolean;
}) {
  const t = useT();
  const count = source.picks.picked.size;
  if (count < 2) return null;
  const branch = currentBranchOf(repoId) ?? 'HEAD';
  return (
    <div className={styles.bar} role="region" aria-label={t('graph.selection.label')}>
      <span className={styles.count}>{t('graph.selection.count', { count })}</span>
      <Button
        size="sm"
        variant="primary"
        aria-disabled={busy}
        onClick={() => {
          if (busy) return;
          void cherryPickCommits(repoId, {
            shas: source.commitsToApply().map((c) => c.sha),
            target: null,
            mainline: null,
          });
        }}
      >
        {t('graph.menu.cherryPickMany', { count, branch })}
      </Button>
      {count === 2 && (
        <>
          <Button
            size="sm"
            onClick={() => {
              compareCommits(repoId, source.selectedCommits());
            }}
          >
            {t('graph.selection.compare')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const [a, b] = source.selectedCommits();
              if (a && b) void jumpToMergeBase(repoId, a.sha, b.sha);
            }}
          >
            {t('graph.selection.mergeBase')}
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          source.collapseSelection();
        }}
      >
        {t('graph.selection.clear')}
      </Button>
    </div>
  );
}
