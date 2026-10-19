import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * Shared helpers for the docs screenshots: each test runs once per theme (projects `dark`,
 * `light`) and writes `website/src/assets/screens/<name>-<theme>.png`.
 *
 * French captures (for the French docs): `DOCS_LOCALE=fr pnpm screenshots:docs` writes
 * `<name>-fr-<theme>.png` instead. The tests still drive the app in English (their selectors are
 * English labels); the UI switches to French just before each capture.
 */

export const MOCK_NOW_MS = 1_791_795_600_000;
const SCREENS = 'website/src/assets/screens';
const LOCALE = process.env.DOCS_LOCALE === 'fr' ? 'fr' : 'en';

/** Margin kept around a cropped element, in CSS pixels. */
const PAD = 12;

/** Output file of a capture, for the current theme and locale. */
export function screenPath(testInfo: TestInfo, name: string): string {
  const locale = LOCALE === 'en' ? '' : `-${LOCALE}`;
  return `${SCREENS}/${name}${locale}-${testInfo.project.name}.png`;
}

/** Switches the UI language, then waits for fonts, the canvas graph and lists to settle. */
export async function settle(page: Page) {
  if (LOCALE !== 'en') {
    await page.evaluate(async (locale) => {
      // Same module instance as the app's: the dev server serves it under this URL.
      const url = '/src/i18n/i18n.ts';
      const i18n = (await import(url)) as {
        useI18nStore: { setState: (state: { locale: string }) => void };
      };
      i18n.useI18nStore.setState({ locale });
      document.documentElement.lang = locale;
    }, LOCALE);
  }
  await page.evaluate(() => document.fonts.ready);
  // Let the canvas graph, virtualized lists and transitions settle after the last interaction.
  await page.waitForTimeout(400);
}

/**
 * Saves `<name>-<theme>.png`: the whole window, or the region of `target` plus a margin of `pad`
 * pixels (clipped to the viewport) so dialogs and panels keep their surroundings readable. Thin
 * full-width targets (banners) use `pad: 0`: a margin would only show half-cut neighbouring rows.
 */
export async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  target?: Locator,
  { pad = PAD }: { pad?: number } = {},
) {
  await settle(page);
  const path = screenPath(testInfo, name);
  if (!target) {
    await page.screenshot({ path, animations: 'disabled' });
    return;
  }
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name}: crop target is not visible`);
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = {
    x,
    y,
    width: Math.min(viewport.width, box.x + box.width + pad) - x,
    height: Math.min(viewport.height, box.y + box.height + pad) - y,
  };
  await page.screenshot({ path, clip, animations: 'disabled' });
}

/** Loads the app at the fixed mock time, optionally preparing the mock before it starts. */
export async function start(page: Page, setup?: string) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  if (setup) {
    await page.addInitScript(`window.__yagguiMockSetup = ${setup};`);
  }
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

/** Opens a fixture repository from the welcome screen (yaggui, linux, blog). */
export async function openRepo(page: Page, name: RegExp = /^yaggui\b/) {
  await page.getByRole('option', { name }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(name);
}
