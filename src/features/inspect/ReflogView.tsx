import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { ReflogEntry } from '../../ipc';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Menu } from '../../ui/Menu';
import { MenuRadioGroup } from '../../ui/MenuRadioGroup';
import { MenuRadioItem } from '../../ui/MenuRadioItem';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { useRowHeight } from '../graph/useRowHeight';
import { copyText } from '../graph/CommitContextMenu';
import { openHistoryDialog } from '../history/historyDialogsStore';
import { openRefDialog } from '../refs/refDialogsStore';
import { revealCommit } from '../repo/graphNavigation';
import { shortOid } from '../repo/repoStatus';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { useInspectRefresh, useReflog } from './inspectQueries';
import { closeInspect, openReflog } from './inspectStore';
import { errorOf } from './ipcError';
import { canResetTo, reflogSelector, splitReflogMessage } from './reflogModel';
import { useEscapeToClose } from './useEscapeToClose';
import common from './Inspect.module.css';
import styles from './Reflog.module.css';

const PREFETCH_ROWS = 50;

/** The verb of a reflog action, for its color: `commit (amend)` → `commit`. */
function actionKind(action: string): string {
  return action.split(/[\s(]/)[0] ?? action;
}

/**
 * Reflog of HEAD or of a branch (F-222): every position the reference had, newest first. An
 * entry can be restored as a new branch, or by a reset of the reference it belongs to (the
 * reset dialog of M3 shows what would be lost).
 */
export function ReflogView({ repoId, reference }: { repoId: number; reference: string }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const rowHeight = useRowHeight();
  const query = useReflog(repoId, reference);
  useInspectRefresh(repoId);
  const refs = useRepoRefs(repoId).data;
  const current = refs?.local.find((branch) => branch.isHead)?.name ?? null;
  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;
  const [selection, setSelection] = useState<{ index: number; total: number } | null>(null);
  // A new move shifts every entry (`@{n}` names change): the selection does not follow.
  const selected = selection?.total === total ? selection.index : null;
  const setSelected = (index: number | null) => {
    setSelection(index === null ? null : { index, total });
  };
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const close = () => {
    closeInspect(repoId);
  };
  useEscapeToClose(close);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
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

  const resettable = canResetTo(reference, current);
  const branchName =
    reference === 'HEAD' ? (current ?? 'HEAD') : reference.replace(/^refs\/heads\//, '');
  const select = (index: number) => {
    setSelected(index);
    const entry = entries[index];
    if (entry?.exists) revealCommit(repoId, entry.newSha, null);
  };
  const createBranch = (entry: ReflogEntry) => {
    openRefDialog({
      kind: 'createBranch',
      repoId,
      from: { kind: 'commit', sha: entry.newSha },
      fromLabel: reflogSelector(reference, entry.index),
    });
  };
  const reset = (entry: ReflogEntry) => {
    openHistoryDialog({
      kind: 'reset',
      repoId,
      target: entry.newSha,
      label: `${reflogSelector(reference, entry.index)} (${shortOid(entry.newSha)})`,
    });
  };
  const showInGraph = (entry: ReflogEntry) => {
    closeInspect(repoId);
    revealCommit(repoId, entry.newSha, null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = selected ?? -1;
    const next =
      event.key === 'ArrowDown'
        ? current + 1
        : event.key === 'ArrowUp'
          ? current - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? entries.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    if (next < 0 || next >= entries.length) return;
    select(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const actions = (entry: ReflogEntry) => ({
    branch: { label: t('inspect.reflog.createBranch') },
    reset: {
      label: t('inspect.reflog.reset', { branch: branchName }),
      why: entry.exists ? (resettable ? null : t('inspect.reflog.resetOther')) : null,
    },
  });
  const menuEntry = menuIndex === null ? undefined : entries[menuIndex];
  const chosen = selected === null ? undefined : entries[selected];
  const choices = ['HEAD', ...(refs?.local.map((b) => `refs/heads/${b.name}`) ?? [])];

  let body;
  if (query.isError) {
    body = (
      <div className={common.centered}>
        <ErrorPanel
          title={t('inspect.reflog.failed')}
          error={errorOf(query.error)}
          context={{ retry: () => void query.refetch() }}
        />
      </div>
    );
  } else if (query.isPending) {
    body = (
      <div className={common.centered} role="status">
        <Spinner />
      </div>
    );
  } else if (entries.length === 0) {
    body = (
      <div className={common.centered}>
        <span>{t('inspect.reflog.empty')}</span>
      </div>
    );
  } else {
    body = (
      <ContextMenu
        content={
          menuEntry && (
            <>
              <ContextMenuItem
                icon="plus"
                disabled={!menuEntry.exists}
                onSelect={() => {
                  createBranch(menuEntry);
                }}
              >
                {actions(menuEntry).branch.label}
              </ContextMenuItem>
              <ContextMenuItem
                icon="undo"
                disabled={!menuEntry.exists || !resettable}
                hint={actions(menuEntry).reset.why ?? undefined}
                onSelect={() => {
                  reset(menuEntry);
                }}
              >
                {actions(menuEntry).reset.label}
              </ContextMenuItem>
              <ContextMenuItem
                icon="commit"
                disabled={!menuEntry.exists}
                onSelect={() => {
                  showInGraph(menuEntry);
                }}
              >
                {t('inspect.showInGraph')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon="copy"
                hint={<code>{shortOid(menuEntry.newSha)}</code>}
                onSelect={() => {
                  copyText(menuEntry.newSha, t('graph.menu.shaCopied'));
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
          className={common.scroll}
          role="listbox"
          aria-label={t('inspect.reflog.entries')}
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
              const { action, detail } = splitReflogMessage(entry.message);
              return (
                <div
                  key={item.key}
                  role="option"
                  aria-selected={selected === item.index}
                  className={styles.row}
                  data-gone={!entry.exists}
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                  onClick={() => {
                    select(item.index);
                  }}
                  onContextMenu={() => {
                    setMenuIndex(item.index);
                  }}
                >
                  <span className={styles.selector}>{reflogSelector(reference, entry.index)}</span>
                  <span className={styles.sha}>{shortOid(entry.newSha)}</span>
                  {action && (
                    <span className={styles.action} data-action={actionKind(action)}>
                      {action}
                    </span>
                  )}
                  <span className={styles.detail} title={entry.message}>
                    {detail}
                  </span>
                  {!entry.exists && <span className={styles.gone}>{t('inspect.reflog.gone')}</span>}
                  <span className={styles.who}>{entry.committerName}</span>
                  <span className={styles.date}>
                    {entry.time === null ? '' : formatRelativeTime(entry.time, now, locale)}
                  </span>
                </div>
              );
            })}
          </div>
          {isFetchingNextPage && (
            <div className={common.loadingMore}>
              <Spinner />
            </div>
          )}
        </div>
      </ContextMenu>
    );
  }

  return (
    <section className={common.view} aria-label={t('inspect.reflog.label')}>
      <header className={common.toolbar}>
        <Button size="sm" variant="ghost" onClick={close}>
          <Icon name="back" />
          {t('diff.back')}
          <Kbd shortcut="Escape" />
        </Button>
        <span className={common.title}>
          <Icon name="history" className={common.titleIcon} />
          {t('inspect.reflog.title')}
        </span>
        <Menu
          trigger={
            <Button size="sm" variant="ghost" aria-label={t('inspect.reflog.reference')}>
              <span className={common.path}>{reference.replace(/^refs\/heads\//, '')}</span>
              <Icon name="chevronDown" />
            </Button>
          }
        >
          <MenuRadioGroup
            label={t('inspect.reflog.reference')}
            value={reference}
            onValueChange={(next) => {
              setSelected(null);
              openReflog(repoId, next);
            }}
          >
            {choices.map((choice) => (
              <MenuRadioItem key={choice} value={choice}>
                {choice.replace(/^refs\/heads\//, '')}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>
        <span className={common.spacer} />
        {!query.isPending && (
          <span className={common.muted}>{t('inspect.reflog.count', { count: total })}</span>
        )}
      </header>
      {body}
      {chosen && (
        <div className={styles.bar} aria-label={t('inspect.reflog.selected')}>
          <span className={styles.selector}>{reflogSelector(reference, chosen.index)}</span>
          <span className={styles.barText}>{chosen.message}</span>
          <span className={common.spacer} />
          {chosen.exists ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  createBranch(chosen);
                }}
              >
                <Icon name="plus" />
                {actions(chosen).branch.label}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!resettable}
                title={actions(chosen).reset.why ?? undefined}
                onClick={() => {
                  reset(chosen);
                }}
              >
                <Icon name="undo" />
                {actions(chosen).reset.label}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  showInGraph(chosen);
                }}
              >
                <Icon name="commit" />
                {t('inspect.showInGraph')}
              </Button>
            </>
          ) : (
            <span className={styles.gone}>{t('inspect.reflog.goneLong')}</span>
          )}
        </div>
      )}
    </section>
  );
}
