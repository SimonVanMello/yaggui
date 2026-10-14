import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend } from '../ipc/mockClient';
import { initTheme, resolveTheme, useThemeStore } from './themeStore';

describe('resolveTheme', () => {
  it('maps explicit preferences', () => {
    expect(resolveTheme('dark', false)).toBe('graphite');
    expect(resolveTheme('light', true)).toBe('paper');
  });

  it('follows the OS for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('graphite');
    expect(resolveTheme('system', false)).toBe('paper');
  });
});

describe('useThemeStore', () => {
  beforeEach(() => {
    mockBackend.reset();
  });

  it('applies the stored preference at startup', () => {
    initTheme('dark');
    expect(useThemeStore.getState().preference).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('applies and persists the chosen preference', async () => {
    useThemeStore.getState().setPreference('dark');
    expect(document.documentElement.dataset.theme).toBe('graphite');
    await expect(mockBackend.commands.getPreferences()).resolves.toMatchObject({
      data: { theme: 'dark' },
    });
    expect(localStorage.getItem('yaggui.theme')).toBeNull();

    useThemeStore.getState().setPreference('light');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(useThemeStore.getState().theme).toBe('paper');
  });
});

describe('first-paint theme cache', () => {
  it('caches every applied preference for public/boot-theme.js', async () => {
    const { THEME_CACHE_KEY } = await import('../app/preferences');
    initTheme('light');
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('light');
    useThemeStore.getState().setPreference('dark');
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('dark');
    // Never the M0-1 key, which the migration treats as legacy data and deletes.
    expect(localStorage.getItem('yaggui.theme')).toBeNull();
  });
});

describe('Terminal style (F-320)', () => {
  beforeEach(() => {
    mockBackend.reset();
  });

  it('wins over the light / dark preference', () => {
    expect(resolveTheme('light', false, 'terminal')).toBe('terminal');
    expect(resolveTheme('system', true, 'terminal')).toBe('terminal');
    expect(resolveTheme('light', false, 'standard')).toBe('paper');
  });

  it('applies, caches and persists the style', async () => {
    initTheme('light', 'standard');
    useThemeStore.getState().setStyle('terminal');
    expect(document.documentElement.dataset.theme).toBe('terminal');
    expect(localStorage.getItem('yaggui.styleCache')).toBe('terminal');
    await expect(mockBackend.commands.getPreferences()).resolves.toMatchObject({
      data: { style: 'terminal' },
    });
    useThemeStore.getState().setStyle('standard');
    expect(document.documentElement.dataset.theme).toBe('paper');
  });
});
