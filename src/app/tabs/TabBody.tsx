import { memo } from 'react';

import { WelcomeScreen } from '../../features/welcome/WelcomeScreen';
import { RepoView } from '../RepoView';
import { useRevealGuard } from './tabSuspension';
import type { ShellTab } from './tabsStore';

/** Memoized: showing or hiding a kept view must not re-render it, only toggle its wrapper. */
export const TabBody = memo(function TabBody({ tab }: { tab: ShellTab }) {
  useRevealGuard();
  return tab.repoId === null ? (
    <WelcomeScreen tabId={tab.id} />
  ) : (
    <RepoView tab={tab} repoId={tab.repoId} />
  );
});
