import { openRepoPath } from '../features/repo/repoSessions';
import { mockBackend } from '../ipc/mockClient';
import { selectActiveTab, useTabsStore } from '../app/tabs/tabsStore';

/** The mock repository with a rich history and a work in progress. */
const SAMPLE_REPO_PATH = '/Users/alex/dev/yaggui';

/**
 * Before the app reads its preferences: no network feature (avatars, update checks), and the
 * language of the page that linked here (`?lang=fr`, the site's French pages).
 */
export function prepareDemo(): void {
  const lang = new URLSearchParams(window.location.search).get('lang');
  mockBackend.seedPreferences({
    gravatar: false,
    checkUpdates: false,
    ...(lang === 'fr' || lang === 'en' ? { locale: lang } : {}),
  });
}

/** Opens the sample repository instead of an empty welcome screen. */
export async function openSampleRepo(): Promise<void> {
  const state = useTabsStore.getState();
  if (state.tabs.some((tab) => tab.repoId !== null)) return;
  await openRepoPath(SAMPLE_REPO_PATH, selectActiveTab(state).id);
}
