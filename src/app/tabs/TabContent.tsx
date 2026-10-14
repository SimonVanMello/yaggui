import { useMemo, useState } from 'react';

import { KeptView } from './KeptView';
import { sameIds, touchRecent } from './keepAlive';
import { TabBody } from './TabBody';
import styles from './TabContent.module.css';
import { useTabsStore, type ShellTab } from './tabsStore';

/**
 * Views of the recently shown tabs (`KEEP_ALIVE_TABS`), most recent first. Welcome tabs are
 * cheap to rebuild and only kept while active.
 */
function useMountedTabIds(tabs: readonly ShellTab[], activeId: string): readonly string[] {
  const keepable = useMemo(
    () => new Set(tabs.filter((tab) => tab.repoId !== null).map((tab) => tab.id)),
    [tabs],
  );
  const [recent, setRecent] = useState<readonly string[]>([activeId]);
  const next = touchRecent(recent, activeId, keepable);
  // Updated during render, so the switch commits in a single pass.
  if (!sameIds(next, recent)) setRecent(next);
  return next;
}

/** The tab panel: the active tab's view, and the recent ones kept hidden (P-07). */
export function TabContent() {
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeTabId);
  const mounted = useMountedTabIds(tabs, activeId);
  return (
    <div
      id="tab-panel"
      role="tabpanel"
      aria-labelledby={`tab-${activeId}`}
      className={styles.panel}
    >
      {/* Tab order, not recency: a switch never moves DOM nodes. A tab whose repository changes
          (welcome → repo) gets a fresh view. */}
      {tabs
        .filter((tab) => mounted.includes(tab.id))
        .map((tab) => (
          <KeptView
            key={`${tab.id}:${String(tab.repoId)}`}
            id={tab.id}
            active={tab.id === activeId}
          >
            <TabBody tab={tab} />
          </KeptView>
        ))}
    </div>
  );
}
