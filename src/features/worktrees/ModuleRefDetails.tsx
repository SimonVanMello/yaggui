import { useT } from '../../i18n/useT';
import type { LocalBranch, SubmoduleRef, WorktreeRef } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { shortOid } from '../repo/repoStatus';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { submoduleStatusOf, useSubmoduleStatus } from '../submodules/submoduleQueries';
import styles from '../submodules/Submodules.module.css';
import { otherWorktreeOf } from './worktreeOps';

/** State of a submodule row: not initialized, moved off the recorded commit, modified (F-260). */
export function SubmoduleDetails({
  repoId,
  submodule,
  notInitialized,
}: {
  repoId: number;
  submodule: SubmoduleRef;
  notInitialized: string;
}) {
  const t = useT();
  const status = submoduleStatusOf(useSubmoduleStatus(repoId).data, submodule.path);
  if (!submodule.initialized) {
    return (
      <span className={styles.chip} data-state="uninitialized">
        {notInitialized}
      </span>
    );
  }
  if (!status) return null;
  const moved = status.head !== null && status.head !== status.expected;
  return (
    <>
      {moved && (
        <span
          className={styles.chip}
          data-tone="warning"
          data-state="moved"
          title={t('sidebar.submodule.movedTitle', {
            expected: status.expected ? shortOid(status.expected) : '—',
            head: status.head ? shortOid(status.head) : '—',
          })}
        >
          {t('sidebar.submodule.moved')}
        </span>
      )}
      {status.dirty && (
        <span
          className={styles.chip}
          data-tone="warning"
          data-state="dirty"
          title={t('sidebar.submodule.dirtyTitle')}
        >
          {t('sidebar.submodule.dirty')}
        </span>
      )}
    </>
  );
}

/** A worktree whose folder is gone (prunable) or which is locked. */
export function WorktreeDetails({
  worktree,
  lockClass,
}: {
  worktree: WorktreeRef;
  lockClass?: string;
}) {
  const t = useT();
  if (worktree.prunable) {
    return (
      <span className={styles.chip} data-tone="warning" title={t('sidebar.worktree.missingTitle')}>
        {t('sidebar.worktree.missing')}
      </span>
    );
  }
  return worktree.locked ? <Icon name="lock" className={lockClass} /> : null;
}

/** Marks a local branch checked out in another worktree: it cannot be checked out here. */
export function BranchWorktreeMark({
  repoId,
  branch,
  className,
}: {
  repoId: number;
  branch: LocalBranch;
  className?: string;
}) {
  const t = useT();
  const refs = useRepoRefs(repoId).data;
  if (branch.isHead) return null;
  const other = otherWorktreeOf(refs, branch.name);
  if (!other) return null;
  const label = t('sidebar.branch.inWorktree', { path: other.path });
  return (
    <span className={className} title={label} aria-label={label} data-worktree={other.path}>
      <Icon name="folder" />
    </span>
  );
}
