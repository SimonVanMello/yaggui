import { Dialog, VisuallyHidden } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { matchBinding } from '../keybindings/registry';
import { Spinner } from '../../ui/Spinner';
import { openDiff } from '../diff/diffStore';
import { repoDisplayName, useRepoSessions } from '../repo/repoSessions';
import { useKnownRepos } from '../repo/useKnownRepos';
import { useRepoRefs } from '../sidebar/useRepoRefs';
import { Highlight } from '../welcome/Highlight';
import styles from './CommandPalette.module.css';
import { listActions } from './actionRegistry';
import {
  KIND_ICON,
  KIND_LABEL,
  kindMatchesMode,
  parseQuery,
  rankItems,
  type PaletteItem,
} from './paletteItems';
import {
  buildActionItems,
  buildCommitItems,
  buildFileItems,
  buildTabItems,
  refItemsFor,
} from './paletteSources';
import { usePaletteStore } from './paletteStore';
import { ThemePicker } from './ThemePicker';
import { useCommitHits, useFileSources } from './usePaletteData';

/** Command palette (F-280): fuzzy search over actions, refs, commits, files and tabs. */
export function CommandPalette() {
  const open = usePaletteStore((state) => state.open);
  const view = usePaletteStore((state) => state.view);
  const setOpen = usePaletteStore((state) => state.setOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined} data-modal="">
          {view === 'themes' ? <ThemePicker /> : <PaletteBody />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody() {
  const t = useT();
  const listId = 'palette-list';
  const inputRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState('');
  const [active, setActive] = useState(0);
  const { mode, text } = parseQuery(raw);

  const tabs = useTabsStore((state) => state.tabs);
  const activeTab = useTabsStore(selectActiveTab);
  const sessions = useRepoSessions((state) => state.sessions);
  const known = useKnownRepos().data;
  const recents = usePaletteStore((state) => state.recents);
  const repoId =
    activeTab.repoId !== null && sessions[activeTab.repoId]?.status === 'open'
      ? activeTab.repoId
      : null;

  const refs = useRepoRefs(repoId ?? -1).data;
  const files = useFileSources(repoId, mode === 'all' || mode === 'file');
  const commits = useCommitHits(
    repoId,
    text,
    (mode === 'all' && text.length >= 2) || mode === 'commit',
  );

  // Rebuilt only when their data changes, not on each keystroke: a repository can hold 10k refs.
  const actionItems = useMemo(() => buildActionItems(listActions(), t), [t]);
  const refItems = useMemo(
    () => (refs && repoId !== null ? refItemsFor(refs, repoId) : []),
    [refs, repoId],
  );
  const tabItems = useMemo(
    () =>
      buildTabItems(
        tabs.map((tab) => ({
          tab,
          name:
            tab.repoId === null
              ? t('palette.tab.new')
              : (repoDisplayName(
                  sessions[tab.repoId],
                  known?.find((repo) => repo.id === tab.repoId),
                ) ?? t('tab.loading')),
        })),
        activeTab.id,
        (tabId) => {
          useTabsStore.getState().activate(tabId);
        },
      ),
    [tabs, activeTab.id, sessions, known, t],
  );
  const fileItems = useMemo(
    () =>
      buildFileItems(files, (target, file) => {
        if (repoId !== null) {
          openDiff(activeTab.id, { repoId, target, path: file.path, oldPath: file.oldPath });
        }
      }),
    [files, repoId, activeTab.id],
  );
  const commitItems = useMemo(
    () => (repoId === null ? [] : buildCommitItems(commits.hits, repoId)),
    [commits.hits, repoId],
  );

  const pool = useMemo(
    () =>
      [...actionItems, ...tabItems, ...refItems, ...fileItems, ...commitItems].filter((item) =>
        kindMatchesMode(item.kind, mode),
      ),
    [actionItems, tabItems, refItems, fileItems, commitItems, mode],
  );
  const { items, total } = useMemo(() => rankItems(pool, text, recents), [pool, text, recents]);
  const activeIndex = Math.min(active, items.length - 1);
  const activeKey = items[activeIndex]?.item.key;

  useEffect(() => {
    const element = document.getElementById(optionId(activeKey));
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  const choose = (item: PaletteItem) => {
    if (item.disabled) return;
    usePaletteStore.getState().remember(item.key);
    if (item.keepsPaletteOpen) {
      item.activate();
      return;
    }
    usePaletteStore.getState().setOpen(false);
    // After the dialog unmounts, so focus restoration cannot undo what the item focuses.
    setTimeout(item.activate, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The global shortcut ignores keys while a dialog is open: toggling back is ours.
    if (matchBinding(event.nativeEvent, 'app.palette')) {
      event.preventDefault();
      usePaletteStore.getState().setOpen(false);
      return;
    }
    const last = items.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        setActive(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case 'ArrowUp':
        setActive(activeIndex <= 0 ? last : activeIndex - 1);
        break;
      case 'Home':
        if (event.currentTarget.value !== '') return;
        setActive(0);
        break;
      case 'End':
        if (event.currentTarget.value !== '') return;
        setActive(last);
        break;
      case 'Enter': {
        const entry = items[activeIndex];
        if (entry) choose(entry.item);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <>
      <VisuallyHidden.Root asChild>
        <Dialog.Title>{t('palette.title')}</Dialog.Title>
      </VisuallyHidden.Root>
      <div className={styles.search}>
        <Icon name="search" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className={styles.input}
          value={raw}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.title')}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeKey === undefined ? undefined : optionId(activeKey)}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(event) => {
            setRaw(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {commits.loading && <Spinner />}
      </div>
      {items.length === 0 ? (
        <div className={styles.empty} role="status">
          {commits.loading ? t('palette.loading') : t('palette.empty', { query: raw.trim() })}
        </div>
      ) : (
        <ul id={listId} role="listbox" aria-label={t('palette.title')} className={styles.list}>
          {items.map(({ item, indices }, index) => (
            <li
              key={item.key}
              id={optionId(item.key)}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={item.disabled === true}
              data-active={index === activeIndex ? '' : undefined}
              data-kind={item.kind}
              className={styles.option}
              onMouseMove={() => {
                if (index !== activeIndex) setActive(index);
              }}
              onClick={() => {
                choose(item);
              }}
            >
              <Icon name={KIND_ICON[item.kind]} className={styles.icon} />
              <span
                className={item.kind === 'file' ? `${styles.label} ${styles.file}` : styles.label}
              >
                <Highlight text={item.label} indices={indices} />
              </span>
              <span className={styles.detail}>
                {item.disabled
                  ? t(item.disabledReason ?? 'palette.disabled.unavailable')
                  : item.detail}
              </span>
              {item.shortcut ? (
                <Kbd shortcut={item.shortcut} />
              ) : (
                <span className={styles.kind}>{t(KIND_LABEL[item.kind])}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.footer}>
        <span className={styles.hint}>
          <Kbd shortcut="↑" />
          <Kbd shortcut="↓" />
        </span>
        <span className={styles.hint}>
          <Kbd shortcut="Enter" />
        </span>
        <span className={styles.hint}>{t('palette.hint')}</span>
        <span className={styles.spacer} />
        <span aria-live="polite">{t('palette.results', { count: total })}</span>
      </div>
    </>
  );
}

function optionId(key: string | undefined): string {
  return `palette-option-${(key ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
