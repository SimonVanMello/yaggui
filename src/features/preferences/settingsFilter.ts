import { createContext, useContext } from 'react';

/** Which settings a section shows: all of them, or the matches of the search. */
export interface SettingsFilter {
  /** The search, trimmed; empty outside a search. */
  query: string;
  /** Ids of the matching settings; `null` shows everything. */
  found: ReadonlySet<string> | null;
}

export const SettingsFilterContext = createContext<SettingsFilter>({ query: '', found: null });

export function useSettingsFilter(): SettingsFilter {
  return useContext(SettingsFilterContext);
}

export function isSettingVisible(filter: SettingsFilter, id: string): boolean {
  return filter.found === null || filter.found.has(id);
}
