import { Popover } from 'radix-ui';
import { useId, useMemo, useState } from 'react';

import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import type { RepoState } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { shortOid, workingBranch } from '../repo/repoStatus';
import { checkoutRef } from '../refs/refCommands';
import { revealRef } from '../sidebar/refActions';
import { pushRecent } from '../sidebar/sidebarUiState';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { Highlight } from '../welcome/Highlight';
import { allChoices, rankChoices, type BranchChoice } from './branchChoices';
import styles from './BranchSelector.module.css';

/**
 * Where HEAD is, always visible (spec §6.5), and the quick way to find a branch (F-106):
 * a fuzzy picker, recent branches first. Picking one checks it out (a remote branch gets its
 * local tracking branch); picking the current branch reveals it in the graph.
 */
export function BranchSelector({
  tab,
  repoId,
  state,
}: {
  tab: ShellTab;
  repoId: number;
  state: RepoState;
}) {
  const t = useT();
  const listId = useId();
  const refs = useRepoRefs(repoId).data;
  const updateSidebar = useTabsStore((store) => store.updateSidebar);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { head, upstream, operation } = state;
  const branch = workingBranch(state);
  const name =
    branch ?? t('branch.detached', { oid: head.kind === 'detached' ? shortOid(head.oid) : '' });
  const rebasing = operation?.kind === 'rebase' && head.kind === 'detached' && branch !== null;

  const choices = useMemo(() => (refs ? allChoices(refs) : []), [refs]);
  const { items, total } = useMemo(
    () => rankChoices(choices, query, tab.sidebar.recent),
    [choices, query, tab.sidebar.recent],
  );
  const activeIndex = Math.min(active, items.length - 1);

  const pick = (choice: BranchChoice) => {
    setOpen(false);
    updateSidebar(tab.id, (sidebar) => pushRecent(sidebar, choice.name));
    // The branch already checked out has nothing to switch to: show where it is.
    if (choice.current) revealRef(repoId, choice.target, refs?.graphVersion ?? null);
    else checkoutRef(repoId, choice.target);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActive(0);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={styles.trigger} aria-label={t('branch.current', { name })}>
          <Icon name={branch === null ? 'commit' : 'branch'} />
          <span className={styles.name}>{name}</span>
          {rebasing && <span className={styles.pill}>{t('op.rebase')}</span>}
          {upstream && (
            <span className={styles.tracking}>
              {upstream.gone ? (
                <span className={styles.gone}>{t('branch.upstreamGone')}</span>
              ) : (
                <>
                  {upstream.ahead > 0 && <span className={styles.ahead}>↑{upstream.ahead}</span>}
                  {upstream.behind > 0 && <span className={styles.behind}>↓{upstream.behind}</span>}
                </>
              )}
              <span className={styles.upstream}>{upstream.name}</span>
            </span>
          )}
          <Icon name="chevronDown" className={styles.chevron} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popover} align="end" sideOffset={4}>
          <div className={styles.search}>
            <Icon name="search" />
            <input
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                items.length > 0 ? `${listId}-${String(activeIndex)}` : undefined
              }
              aria-label={t('branch.search')}
              className={styles.input}
              value={query}
              placeholder={t('branch.search')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActive(Math.min(activeIndex + 1, items.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive(Math.max(activeIndex - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const choice = items[activeIndex];
                  if (choice) pick(choice);
                }
              }}
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t('branch.listLabel')}
            className={styles.list}
          >
            {items.map((choice, index) => (
              <div
                key={`${choice.remote ? 'r' : 'l'}:${choice.name}`}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex || undefined}
                className={styles.option}
                onMouseMove={() => {
                  if (index !== activeIndex) setActive(index);
                }}
                onClick={() => {
                  pick(choice);
                }}
              >
                <Icon name={choice.remote ? 'cloud' : 'branch'} />
                <span className={styles.optionName}>
                  <Highlight text={choice.name} indices={choice.indices} />
                </span>
                {choice.current && <span className={styles.badge}>{t('branch.currentBadge')}</span>}
                {!choice.current && !query && tab.sidebar.recent.includes(choice.name) && (
                  <span className={styles.badge}>{t('branch.recentBadge')}</span>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <p className={styles.none} role="status">
                {refs ? t('branch.noMatch') : t('branch.loading')}
              </p>
            )}
            {total > items.length && (
              <p className={styles.none}>{t('branch.more', { count: total - items.length })}</p>
            )}
          </div>
          <p className={styles.footer}>{t('branch.pickHint')}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
