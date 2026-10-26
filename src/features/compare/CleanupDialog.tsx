import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { YagguiIpcError, ipc, unwrap, type BranchCleanup, type YagguiError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import { toast } from '../../ui/toastStore';
import { useControlHeight } from '../graph/useRowHeight';
import { refreshRefs } from '../refs/refOps';
import { shortOid } from '../repo/repoStatus';
import { closeBranchTools } from './branchToolsStore';
import { cleanupCommand, cleanupEffect, defaultSelection } from './cleanupModel';
import styles from './BranchTools.module.css';

function BranchList({
  cleanup,
  selected,
  onToggle,
}: {
  cleanup: BranchCleanup;
  selected: ReadonlySet<string>;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  // `.row` is `--control-height-md` tall: the same token sizes the virtual rows.
  const rowHeight = useControlHeight();
  const virtualizer = useVirtualizer({
    count: cleanup.branches.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  return (
    <div ref={scrollRef} className={styles.list} role="group" aria-label={t('cleanup.list')}>
      <div className={styles.listInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const branch = cleanup.branches[item.index];
          if (!branch) return null;
          return (
            <label
              key={branch.name}
              className={styles.row}
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              <input
                type="checkbox"
                checked={selected.has(branch.name)}
                onChange={(event) => {
                  onToggle(branch.name, event.target.checked);
                }}
              />
              <span className={styles.name}>{branch.name}</span>
              {branch.merged && (
                <span className={styles.badge} data-kind="merged">
                  {t('cleanup.merged')}
                </span>
              )}
              {branch.gone && (
                <span
                  className={styles.badge}
                  data-kind="gone"
                  title={branch.upstream ?? undefined}
                >
                  {t('cleanup.gone')}
                </span>
              )}
              {branch.unmerged > 0 && (
                <span className={styles.unmerged}>
                  {t('cleanup.unmergedCount', { count: branch.unmerged })}
                </span>
              )}
              <code className={styles.sha}>{shortOid(branch.sha)}</code>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Cleanup of local branches (F-105): merged into HEAD or whose upstream is gone, chosen with
 * checkboxes, deleted locally in one undoable operation. The current, checked out and
 * protected branches are never offered.
 */
export function CleanupDialog({ repoId }: { repoId: number }) {
  const t = useT();
  const query = useQuery({
    queryKey: ['branch-cleanup', repoId],
    queryFn: () => unwrap(ipc.commands.branchCleanup(repoId)),
    staleTime: 0,
    gcTime: 0,
  });
  const cleanup = query.data;
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YagguiError | null>(null);
  const selected = picked ?? (cleanup ? defaultSelection(cleanup.branches) : new Set<string>());
  const effect = cleanup ? cleanupEffect(cleanup.branches, selected) : null;
  const names = cleanup
    ? cleanup.branches.filter((b) => selected.has(b.name)).map((b) => b.name)
    : [];

  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(name);
    else next.delete(name);
    setPicked(next);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    const result = await ipc.commands.deleteBranches(repoId, names);
    setBusy(false);
    if (result.status === 'error') {
      setError(result.error);
      return;
    }
    refreshRefs(repoId);
    toast({
      variant: 'success',
      title: t('cleanup.done', { count: result.data.deleted.length }),
      description: t('cleanup.doneHint'),
    });
    closeBranchTools();
  };

  let body;
  if (query.isError) {
    const err = query.error instanceof YagguiIpcError ? query.error.error : null;
    body = (
      <p className={styles.status} data-state="invalid" role="alert">
        {err ? localize(err.message) : query.error.message}
      </p>
    );
  } else if (!cleanup || !effect) {
    body = (
      <div className={styles.loading} role="status">
        <Spinner />
      </div>
    );
  } else if (cleanup.branches.length === 0) {
    body = <p className={styles.empty}>{t('cleanup.nothing')}</p>;
  } else {
    const all = selected.size === cleanup.branches.length;
    body = (
      <>
        <label className={styles.selectAll}>
          <input
            type="checkbox"
            checked={all}
            ref={(input) => {
              if (input) input.indeterminate = !all && selected.size > 0;
            }}
            onChange={(event) => {
              setPicked(
                event.target.checked ? new Set(cleanup.branches.map((b) => b.name)) : new Set(),
              );
            }}
          />
          <span>{t('cleanup.selectAll', { count: cleanup.branches.length })}</span>
        </label>
        <BranchList cleanup={cleanup} selected={selected} onToggle={toggle} />
        <div className={styles.effect} role="status">
          <b>{t('cleanup.effect', { count: effect.count })}</b>
          {effect.unmergedCommits > 0 ? (
            <span className={styles.warning}>
              {t('cleanup.effectUnmerged', { count: effect.unmergedCommits })}
            </span>
          ) : (
            effect.count > 0 && <span>{t('cleanup.effectSafe')}</span>
          )}
          <span>{t('cleanup.effectLocal')}</span>
        </div>
        {effect.count > 0 && <code className={styles.command}>{cleanupCommand(names)}</code>}
      </>
    );
  }

  const skipped = cleanup ? [...cleanup.protected, ...cleanup.checkedOut] : [];
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeBranchTools();
      }}
      title={t('cleanup.title')}
      description={
        cleanup?.into
          ? t('cleanup.description', { branch: cleanup.into })
          : t('cleanup.descriptionDetached')
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeBranchTools}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            aria-disabled={busy || !effect || effect.count === 0}
            onClick={() => {
              if (!busy && effect && effect.count > 0) void run();
            }}
          >
            {t('cleanup.confirm', { count: effect?.count ?? 0 })}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {body}
        {skipped.length > 0 && (
          <p className={styles.skipped}>
            {cleanup && cleanup.protected.length > 0 && (
              <span>{t('cleanup.protected', { names: cleanup.protected.join(', ') })}</span>
            )}
            {cleanup && cleanup.checkedOut.length > 0 && (
              <span>{t('cleanup.checkedOut', { names: cleanup.checkedOut.join(', ') })}</span>
            )}
          </p>
        )}
        {error && (
          <p className={styles.status} data-state="invalid" role="alert">
            {localize(error.message)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
