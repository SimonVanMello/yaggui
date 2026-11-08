import { Popover } from 'radix-ui';
import { useRef, type KeyboardEvent } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { useNow } from '../../ui/useNow';
import statusStyles from '../statusbar/StatusBar.module.css';
import styles from './ActivityCenter.module.css';
import { ActivityEntryRow } from './ActivityEntryRow';
import { activityTarget, useActivityStore, type ActivityTarget } from './activityStore';

const ENTRY = '[data-activity-entry]';

function go(target: ActivityTarget): void {
  if (target.kind === 'none') return;
  if (target.tabId !== null) useTabsStore.getState().activate(target.tabId);
  if (target.kind === 'log') useShellStore.getState().showLogEntry(target.entryId);
}

/**
 * Status bar button and popover listing the session's last notifications (every toast,
 * dismissed or not), newest first, with an unread count since the popover was last opened.
 */
export function ActivityCenter() {
  const t = useT();
  const now = useNow();
  const entries = useActivityStore((state) => state.entries);
  const unread = useActivityStore((state) => state.unread);
  const open = useActivityStore((state) => state.open);
  const setOpen = useActivityStore((state) => state.setOpen);
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const failures = useActivityStore((state) => state.failures);
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(ENTRY) ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : Math.min(index + 1, buttons.length - 1);
    else if (event.key === 'ArrowUp') next = index < 0 ? 0 : Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  const label = unread > 0 ? t('status.activity.unread', { count: unread }) : t('status.activity');

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={t('status.activity')} side="top">
        <Popover.Trigger asChild>
          <button type="button" className={statusStyles.activityToggle} aria-label={label}>
            <Icon name="bell" />
            {unread > 0 && (
              <span className={statusStyles.badge} aria-hidden="true">
                {unread}
              </span>
            )}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="top"
          align="end"
          sideOffset={4}
          aria-labelledby="activity-title"
          onOpenAutoFocus={(event) => {
            const first = listRef.current?.querySelector<HTMLButtonElement>(ENTRY);
            if (first) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <div className={styles.header}>
            <h2 id="activity-title" className={styles.title}>
              {t('activity.title')}
            </h2>
            {entries.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  useActivityStore.getState().clear();
                }}
              >
                {t('activity.clear')}
              </Button>
            )}
          </div>
          {entries.length === 0 ? (
            <p className={styles.empty}>
              <strong>{t('activity.empty')}</strong>
              {t('activity.emptyHint')}
            </p>
          ) : (
            <ul
              ref={listRef}
              className={styles.list}
              aria-label={t('activity.list')}
              onKeyDown={onKeyDown}
            >
              {entries.map((entry) => {
                const target = activityTarget(entry, failures, { tabs, activeTabId });
                return (
                  <ActivityEntryRow
                    key={entry.id}
                    entry={entry}
                    target={target}
                    now={now}
                    onOpen={() => {
                      if (target.kind === 'none') return;
                      setOpen(false);
                      go(target);
                    }}
                    onAction={() => {
                      setOpen(false);
                      entry.action?.onClick();
                    }}
                  />
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
