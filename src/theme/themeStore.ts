import { create } from 'zustand';

import { cacheThemePreference, cacheThemeStyle, savePreferences } from '../app/preferences';
import type { ThemePreference, ThemeStyle } from '../ipc';

export type { ThemePreference } from '../ipc';
export type ThemeName = 'graphite' | 'paper' | 'terminal';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The Terminal style (D) is dark only: it ignores the light / dark choice. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
  style: ThemeStyle = 'standard',
): ThemeName {
  if (style === 'terminal') return 'terminal';
  if (preference === 'system') return systemPrefersDark ? 'graphite' : 'paper';
  return preference === 'dark' ? 'graphite' : 'paper';
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  preference: ThemePreference;
  style: ThemeStyle;
  theme: ThemeName;
  setPreference: (preference: ThemePreference) => void;
  setStyle: (style: ThemeStyle) => void;
}

function applyPreference(preference: ThemePreference, style: ThemeStyle): ThemeName {
  const theme = resolveTheme(preference, systemPrefersDark(), style);
  applyTheme(theme);
  cacheThemePreference(preference);
  cacheThemeStyle(style);
  return theme;
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  preference: 'system',
  style: 'standard',
  theme: resolveTheme('system', systemPrefersDark()),
  setPreference: (next) => {
    set({ preference: next, theme: applyPreference(next, get().style) });
    savePreferences({ theme: next });
  },
  setStyle: (next) => {
    set({ style: next, theme: applyPreference(get().preference, next) });
    savePreferences({ style: next });
  },
}));

/** Applies the stored preference and follows OS changes while the preference is `system`. */
export function initTheme(preference: ThemePreference, style: ThemeStyle = 'standard'): void {
  useThemeStore.setState({ preference, style, theme: applyPreference(preference, style) });
  window.matchMedia(DARK_QUERY).addEventListener('change', (event) => {
    const { preference: current, style: currentStyle } = useThemeStore.getState();
    if (current !== 'system') return;
    const theme = resolveTheme('system', event.matches, currentStyle);
    applyTheme(theme);
    useThemeStore.setState({ theme });
  });
}
