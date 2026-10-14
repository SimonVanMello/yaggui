import { useSyncExternalStore } from 'react';

import type { Preferences } from '../ipc';
import { currentPreferences, subscribePreferences } from './preferences';

/** The stored preferences, re-rendering when they change. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribePreferences, currentPreferences);
}
