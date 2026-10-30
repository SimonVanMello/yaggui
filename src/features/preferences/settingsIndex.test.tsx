import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadPreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { mockBackend } from '../../ipc/mockClient';
import { AppearanceSection } from './AppearanceSection';
import { DisplaySection } from './DisplaySection';
import { GeneralSection } from './GeneralSection';
import { GitConfigSection } from './GitConfigSection';
import { KeybindingsSection } from './KeybindingsSection';
import { SafetySection } from './SafetySection';
import { SyncSection } from './SyncSection';
import { ToolsSection } from './ToolsSection';
import {
  SECTIONS,
  SETTINGS,
  countBySection,
  foldText,
  namesMatch,
  searchSettings,
  type SectionId,
} from './settingsIndex';
import { SettingsFilterContext } from './settingsFilter';

describe('searchSettings', () => {
  it('shows everything without a query', () => {
    expect(searchSettings('   ')).toBeNull();
  });

  it('finds a setting in either language, without accents or case', () => {
    expect(searchSettings('Densité')).toEqual(searchSettings('density'));
    expect(searchSettings('THEME')?.has('theme')).toBe(true);
    expect(searchSettings('theme')?.has('theme')).toBe(true);
  });

  it('finds Git keys and keywords, every word of the query must match', () => {
    expect(searchSettings('autocrlf')).toEqual(new Set(['core.autocrlf']));
    expect([...(searchSettings('pull rebase') ?? [])]).toContain('pullStrategy');
    expect(searchSettings('pull nothing-like-this')?.size).toBe(0);
  });

  it('searches the extra words given for a setting', () => {
    expect(searchSettings('dracula')?.has('theme')).toBe(false);
    expect(searchSettings('dracula', { theme: 'Dracula Classics' })).toEqual(new Set(['theme']));
  });

  it('counts the matches per section', () => {
    const found = searchSettings('pull') ?? new Set();
    const counts = countBySection(found);
    expect(counts.get('sync')).toBeGreaterThan(0);
    expect(counts.get('gitconfig')).toBeGreaterThan(0);
    expect(counts.has('display')).toBe(false);
  });

  it('matches names loosely', () => {
    expect(namesMatch('rose', ['Rosé Pine'])).toBe(true);
    expect(namesMatch('', ['Rosé Pine'])).toBe(false);
    expect(foldText('Élan')).toBe('elan');
  });
});

const CONTENT: Record<SectionId, () => React.ReactElement> = {
  general: () => <GeneralSection />,
  appearance: () => <AppearanceSection />,
  display: () => <DisplaySection />,
  keybindings: () => <KeybindingsSection />,
  tools: () => <ToolsSection />,
  sync: () => <SyncSection />,
  safety: () => <SafetySection />,
  gitconfig: () => <GitConfigSection />,
};

describe('the index and the sections agree', () => {
  beforeEach(async () => {
    mockBackend.reset();
    queryClient.clear();
    await loadPreferences();
  });

  it.each(SECTIONS.map((s) => s.id))('%s renders every setting the index puts in it', (id) => {
    const { container } = render(
      <QueryClientProvider client={queryClient}>{CONTENT[id]()}</QueryClientProvider>,
    );
    const rendered = [...container.querySelectorAll('[data-setting]')].map((el) =>
      el.getAttribute('data-setting'),
    );
    expect(rendered).toEqual(SETTINGS.filter((s) => s.section === id).map((s) => s.id));
  });

  it('a search keeps only the matching settings and their group', () => {
    const found = new Set(['prune']);
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SettingsFilterContext.Provider value={{ query: 'prune', found }}>
          <SyncSection />
        </SettingsFilterContext.Provider>
      </QueryClientProvider>,
    );
    expect([...container.querySelectorAll('[data-setting]')]).toHaveLength(1);
  });
});
