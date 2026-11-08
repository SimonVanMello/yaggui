import { useShortcut } from '../../features/keybindings/registry';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { closeTabAndRepo, closeTabsAndRepos } from '../../features/repo/repoSessions';
import { useRepoSessions } from '../../features/repo/repoSessions';
import { useRenameRepo } from '../../features/repo/renameRepoStore';
import { useKnownRepos } from '../../features/repo/useKnownRepos';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { IconButton } from '../../ui/IconButton';
import { matchBinding } from '../../features/keybindings/registry';
import { toast } from '../../ui/toastStore';
import { reopenClosedTab } from '../tabs/reopenClosedTab';
import { openNewTab, useTabsStore, type ShellTab } from '../tabs/tabsStore';
import { TabItem } from './TabItem';
import styles from './TabStrip.module.css';

/** Pointer travel before a press becomes a drag, in px. */
const DRAG_THRESHOLD = 4;

interface DragState {
  id: string;
  /** Pointer offset inside the grabbed tab. */
  grab: number;
  pointerX: number;
  active: boolean;
}

function tabElements(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')];
}

/**
 * Moves the dragged tab under the pointer, relative to its current layout position, within its
 * group: pinned tabs and the others never cross.
 */
function applyDragTransform(strip: HTMLElement, drag: DragState): void {
  const elements = tabElements(strip);
  const element = elements.find((el) => el.dataset.tabId === drag.id);
  if (!element) return;
  const group = elements.filter((el) => el.dataset.pinned === element.dataset.pinned);
  const first = group[0] ?? element;
  const last = group.at(-1) ?? element;
  const stripLeft = strip.getBoundingClientRect().left - strip.scrollLeft;
  const min = first.offsetLeft;
  const max = last.offsetLeft + last.offsetWidth - element.offsetWidth;
  const left = Math.min(max, Math.max(min, drag.pointerX - stripLeft - drag.grab));
  element.style.transform = `translateX(${left - element.offsetLeft}px)`;
}

/** Index the dragged tab should take: how many other tabs have their center before its center. */
function dropIndex(strip: HTMLElement, drag: DragState): number {
  const elements = tabElements(strip);
  const dragged = elements.find((el) => el.dataset.tabId === drag.id);
  if (!dragged) return 0;
  const stripLeft = strip.getBoundingClientRect().left - strip.scrollLeft;
  const center = drag.pointerX - stripLeft - drag.grab + dragged.offsetWidth / 2;
  return elements.filter((el) => el !== dragged && el.offsetLeft + el.offsetWidth / 2 < center)
    .length;
}

/** Tabs of the title bar (F-004): drag to reorder, middle click to close, arrows to navigate. */
export function TabStrip() {
  const t = useT();
  const newTabShortcut = useShortcut('tab.new');
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Keep the dragged tab under the pointer after each reorder re-render.
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (drag?.active && stripRef.current) applyDragTransform(stripRef.current, drag);
  });

  // Keyboard navigation moves focus with the selection; the active tab is always visible.
  useEffect(() => {
    const strip = stripRef.current;
    const element = strip?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`);
    if (!strip || !element) return;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (strip.contains(document.activeElement)) element.focus();
  }, [activeTabId]);

  const onPointerDown = (tab: ShellTab) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const store = useTabsStore.getState();
    store.activate(tab.id);
    const strip = stripRef.current;
    if (!strip) return;
    const startX = event.clientX;
    const drag: DragState = {
      id: tab.id,
      grab: startX - event.currentTarget.getBoundingClientRect().left,
      pointerX: startX,
      active: false,
    };
    dragRef.current = drag;

    const onMove = (move: PointerEvent) => {
      drag.pointerX = move.clientX;
      if (!drag.active) {
        if (Math.abs(move.clientX - startX) < DRAG_THRESHOLD) return;
        drag.active = true;
        setDraggingId(tab.id);
        // Hides tooltips while dragging (see Tooltip.module.css).
        document.body.dataset.dragging = 'tab';
      }
      const index = dropIndex(strip, drag);
      const current = useTabsStore.getState().tabs.findIndex((t) => t.id === tab.id);
      if (index !== current) useTabsStore.getState().moveTab(tab.id, index);
      applyDragTransform(strip, drag);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const element = tabElements(strip).find((el) => el.dataset.tabId === tab.id);
      if (element) element.style.transform = '';
      dragRef.current = null;
      setDraggingId(null);
      delete document.body.dataset.dragging;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (tab: ShellTab, index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    const store = useTabsStore.getState();
    if (matchBinding(event, 'tab.moveLeft')) store.moveTab(tab.id, index - 1);
    else if (matchBinding(event, 'tab.moveRight')) store.moveTab(tab.id, index + 1);
    else if (event.key === 'ArrowLeft') store.activateRelative(-1);
    else if (event.key === 'ArrowRight') store.activateRelative(1);
    else if (event.key === 'Home') store.activateIndex(0);
    else if (event.key === 'End') store.activateIndex(8);
    else if (event.key === 'Delete') closeTabAndRepo(tab.id);
    else return;
    event.preventDefault();
    if (event.key.startsWith('Arrow') && event.shiftKey) {
      // Reordering keeps focus on the moved tab.
      requestAnimationFrame(() => {
        stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"]`)?.focus();
      });
    }
  };

  return (
    <div className={styles.container}>
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t('tab.list')}
        className={styles.strip}
        data-tauri-drag-region
        onWheel={(event) => {
          // A vertical wheel scrolls the overflowing tabs horizontally.
          if (event.deltaY !== 0 && event.deltaX === 0) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
      >
        {tabs.map((tab, index) => (
          <TabContextMenu key={tab.id} tab={tab} index={index} tabs={tabs}>
            <TabItem
              tab={tab}
              active={tab.id === activeTabId}
              dragging={tab.id === draggingId}
              onPointerDown={onPointerDown(tab)}
              onKeyDown={onKeyDown(tab, index)}
              onClose={() => {
                closeTabAndRepo(tab.id);
              }}
            />
          </TabContextMenu>
        ))}
      </div>
      <IconButton
        icon="plus"
        label={t('tab.newTab')}
        shortcut={newTabShortcut}
        size="sm"
        className={styles.add}
        onClick={openNewTab}
      />
    </div>
  );
}

interface TabContextMenuProps {
  tab: ShellTab;
  index: number;
  tabs: readonly ShellTab[];
  children: React.ReactElement;
}

function TabContextMenu({ tab, index, tabs, children }: TabContextMenuProps) {
  const t = useT();
  const closeTabShortcut = useShortcut('tab.close');
  const reopenShortcut = useShortcut('tab.reopenClosed');
  const canReopen = useTabsStore((state) => state.closedTabs.length > 0);
  // Pinned tabs stay put on "Close others" / "Close to the right", and move among themselves.
  const pinnedCount = tabs.filter((other) => other.pinned).length;
  const closesOthers = tabs.some((other) => other.id !== tab.id && !other.pinned);
  const closesRight = tabs.slice(index + 1).some((other) => !other.pinned);
  const [groupStart, groupEnd] = tab.pinned ? [0, pinnedCount - 1] : [pinnedCount, tabs.length - 1];
  const session = useRepoSessions((state) =>
    tab.repoId === null ? undefined : state.sessions[tab.repoId],
  );
  const known = useKnownRepos().data?.find((repo) => repo.id === tab.repoId);
  const path = session?.status === 'open' ? session.info.path : known?.path;

  return (
    <ContextMenu
      content={
        <>
          <ContextMenuItem
            icon="close"
            shortcut={closeTabShortcut}
            onSelect={() => {
              closeTabAndRepo(tab.id);
            }}
          >
            {t('tab.menu.close')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!closesOthers}
            onSelect={() => {
              closeTabsAndRepos(() => {
                useTabsStore.getState().closeOtherTabs(tab.id);
              });
            }}
          >
            {t('tab.menu.closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!closesRight}
            onSelect={() => {
              closeTabsAndRepos(() => {
                useTabsStore.getState().closeTabsToRight(tab.id);
              });
            }}
          >
            {t('tab.menu.closeRight')}
          </ContextMenuItem>
          <ContextMenuItem
            shortcut={reopenShortcut}
            disabled={!canReopen}
            onSelect={() => {
              void reopenClosedTab();
            }}
          >
            {t('tab.menu.reopenClosed')}
          </ContextMenuItem>
          {tab.repoId !== null && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon="pin"
                onSelect={() => {
                  useTabsStore.getState().setPinned(tab.id, !tab.pinned);
                }}
              >
                {tab.pinned ? t('tab.menu.unpin') : t('tab.menu.pin')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="pencil"
                disabled={!known}
                onSelect={() => {
                  if (tab.repoId !== null) useRenameRepo.getState().open(tab.repoId);
                }}
              >
                {t('tab.menu.rename')}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="chevronRight"
            disabled={index >= groupEnd}
            onSelect={() => {
              useTabsStore.getState().moveTab(tab.id, index + 1);
            }}
          >
            {t('tab.menu.moveRight')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={index <= groupStart}
            onSelect={() => {
              useTabsStore.getState().moveTab(tab.id, index - 1);
            }}
          >
            {t('tab.menu.moveLeft')}
          </ContextMenuItem>
          {path && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon="copy"
                onSelect={() => {
                  void navigator.clipboard.writeText(path).then(() => {
                    toast({ variant: 'success', title: t('tab.menu.pathCopied') });
                  });
                }}
              >
                {t('tab.menu.copyPath')}
              </ContextMenuItem>
            </>
          )}
        </>
      }
    >
      {children}
    </ContextMenu>
  );
}
