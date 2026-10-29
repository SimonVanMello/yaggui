import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as renderUi, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { initI18n } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { initTheme, useThemeStore } from '../../theme/themeStore';
import { getAction } from './actionRegistry';
import { registerBuiltinActions } from './builtinActions';
import { CommandPalette } from './CommandPalette';
import { usePaletteStore } from './paletteStore';

let off: () => void;
beforeEach(async () => {
  mockBackend.reset();
  await loadPreferences();
  initI18n('en');
  initTheme({ theme: 'dark', style: 'standard' });
  off = registerBuiltinActions();
});
afterEach(() => {
  act(() => {
    usePaletteStore.getState().setOpen(false);
  });
  off();
});

const render = (ui: React.ReactElement) =>
  renderUi(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const input = () => screen.getByRole('combobox', { name: 'Color theme' });

describe('theme picker of the palette', () => {
  it('opens from its action, keeping the palette open', () => {
    render(<CommandPalette />);
    act(() => {
      usePaletteStore.getState().setOpen(true);
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Command palette' }), {
      target: { value: 'theme' },
    });
    // "theme" + Enter: the picker, not one of the light / dark actions.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command palette' }), { key: 'Enter' });
    expect(usePaletteStore.getState()).toMatchObject({ open: true, view: 'themes' });
    expect(input()).toBeInTheDocument();
    expect(getAction('view.theme.pick')?.keepsPaletteOpen).toBe(true);
  });

  it('previews while moving, applies on Enter', () => {
    render(<CommandPalette />);
    act(() => {
      usePaletteStore.getState().openView('themes');
    });
    // Starts on the current theme.
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Graphite');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(useThemeStore.getState().preview).toBe('terminal');
    expect(document.documentElement.dataset.theme).toBe('terminal');
    fireEvent.change(input(), { target: { value: 'latte' } });
    expect(useThemeStore.getState().preview).toBe('latte');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(usePaletteStore.getState().open).toBe(false);
    expect(useThemeStore.getState()).toMatchObject({
      preview: null,
      preference: 'light',
      lightTheme: 'latte',
      theme: 'latte',
    });
  });

  it('comes back to the current theme when closed without a choice', () => {
    render(<CommandPalette />);
    act(() => {
      usePaletteStore.getState().openView('themes');
    });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(document.documentElement.dataset.theme).toBe('terminal');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(usePaletteStore.getState().open).toBe(false);
    expect(useThemeStore.getState()).toMatchObject({ preview: null, theme: 'graphite' });
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('says when no theme matches', () => {
    render(<CommandPalette />);
    act(() => {
      usePaletteStore.getState().openView('themes');
    });
    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(screen.getByRole('status')).toHaveTextContent('No theme matches “zzz”.');
    expect(useThemeStore.getState().preview).toBeNull();
  });
});
