import type { Density, Preferences } from '../ipc';

/** The size `--text-md` has at scale 1 (src/theme/tokens.css). */
export const BASE_FONT_SIZE = 13;

const DEFAULT_UI_STACK =
  "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const DEFAULT_CODE_STACK = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace";

export type AppearancePreferences = Pick<
  Preferences,
  'highContrast' | 'density' | 'uiFont' | 'codeFont' | 'fontSize'
>;

/** `family` first (quoted: names may contain spaces), then the bundled stack as a fallback. */
export function fontStack(family: string | null, fallback: string): string | null {
  const name = family?.trim();
  if (!name) return null;
  // The backend refuses quotes and CSS punctuation; strip them again for a mock or old value.
  const safe = name.replace(/["'\\;{}<>]/g, '');
  return safe ? `"${safe}", ${fallback}` : null;
}

export function fontScale(fontSize: number): number {
  return Math.round((fontSize / BASE_FONT_SIZE) * 1000) / 1000;
}

function setOrRemove(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

/** Applies density, contrast, fonts and text size to the document, without a reload. */
export function applyAppearance(
  prefs: AppearancePreferences,
  root: HTMLElement = document.documentElement,
): void {
  const density: Density = prefs.density;
  root.dataset.density = density;
  if (prefs.highContrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  setOrRemove(root, '--font-ui', fontStack(prefs.uiFont, DEFAULT_UI_STACK));
  setOrRemove(root, '--font-code', fontStack(prefs.codeFont, DEFAULT_CODE_STACK));
  setOrRemove(
    root,
    '--font-scale',
    prefs.fontSize === BASE_FONT_SIZE ? null : String(fontScale(prefs.fontSize)),
  );
}
