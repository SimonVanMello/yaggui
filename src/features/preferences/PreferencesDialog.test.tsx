import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { useShellStore } from '../../app/shellStore';
import { initI18n } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { initTheme, useThemeStore } from '../../theme/themeStore';
import { PreferencesDialog } from './PreferencesDialog';

beforeEach(async () => {
  mockBackend.reset();
  queryClient.clear();
  await loadPreferences();
  initI18n('en');
  initTheme({ theme: 'dark', style: 'standard' });
});
afterEach(() => {
  act(() => {
    useShellStore.getState().setPreferencesOpen(false);
  });
  vi.useRealTimers();
});

function open(tab?: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <PreferencesDialog />
    </QueryClientProvider>,
  );
  act(() => {
    useShellStore.getState().setPreferencesOpen(true, tab);
  });
  return screen.getByRole('dialog', { name: 'Preferences' });
}

const nav = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('navigation', { name: 'Preference sections' }));

describe('Preferences dialog', () => {
  it('opens on General, or on the section asked for', () => {
    const dialog = open();
    expect(nav(dialog).getByRole('button', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    act(() => {
      useShellStore.getState().setPreferencesOpen(false);
      useShellStore.getState().setPreferencesOpen(true, 'keybindings');
    });
    expect(
      nav(screen.getByRole('dialog')).getByRole('button', { name: 'Shortcuts' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('switches section from the sidebar', () => {
    const dialog = open();
    fireEvent.click(nav(dialog).getByRole('button', { name: 'Fetch and pull' }));
    expect(within(dialog).getByRole('heading', { name: 'Fetch and pull' })).toBeVisible();
    expect(within(dialog).getByText('Prune on fetch')).toBeVisible();
  });

  it('searches every section, with a count per section', () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'pull' },
    });
    expect(within(dialog).getByRole('heading', { name: 'Results' })).toBeVisible();
    expect(within(dialog).getByText('Default pull strategy')).toBeVisible();
    expect(within(dialog).getByText('Pull strategy (pull.rebase)')).toBeVisible();
    expect(within(dialog).queryByText('Prune on fetch')).toBeNull();
    const sync = nav(dialog).getByRole('button', { name: /Fetch and pull/ });
    expect(sync).toHaveTextContent('2');

    // "Open the section" leaves the search for the section.
    fireEvent.click(
      within(within(dialog).getByRole('region', { name: 'Fetch and pull' })).getByRole('button', {
        name: 'Open the section',
      }),
    );
    expect(within(dialog).getByText('Prune on fetch')).toBeVisible();
    expect(within(dialog).getByRole('searchbox')).toHaveValue('');
  });

  it('says when nothing matches', () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'qwxz' } });
    expect(within(dialog).getByText(/No setting matches “qwxz”/)).toBeVisible();
  });

  it('a search naming a theme shows the gallery filtered on it', () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'dracula' } });
    const cards = dialog.querySelectorAll('[data-theme-id]');
    expect([...cards].map((card) => card.getAttribute('data-theme-id'))).toEqual(['dracula']);
  });

  it('previews a theme on hover, applies it on click, Esc ends a preview only', () => {
    vi.useFakeTimers();
    const dialog = open('appearance');
    const card = dialog.querySelector<HTMLElement>('[data-theme-id="nord"]');
    if (!card) throw new Error('no Nord card');
    fireEvent.pointerEnter(card);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Preview: Nord');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(document.documentElement.dataset.theme).toBe('graphite');
    expect(screen.getByRole('dialog', { name: 'Preferences' })).toBeInTheDocument();

    fireEvent.click(card);
    expect(useThemeStore.getState()).toMatchObject({ darkTheme: 'nord', theme: 'nord' });
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });

  it('turning "Follow the system theme" on shows the theme of each mode', () => {
    const dialog = open('appearance');
    fireEvent.click(within(dialog).getByRole('switch', { name: /Follow the system theme/ }));
    expect(useThemeStore.getState().preference).toBe('system');
    expect(within(dialog).getByText('Light mode')).toBeVisible();
    expect(within(dialog).getAllByText('Paper').length).toBeGreaterThan(1);
  });
});
