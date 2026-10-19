import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Shared helpers for the docs screenshots: each test runs once per theme (projects `dark`, `light`). */

export const MOCK_NOW_MS = 1_791_795_600_000;
const SCREENS = 'website/src/assets/screens';

/** Margin kept around a cropped element, in CSS pixels. */
const PAD = 12;

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // Let the canvas graph, virtualized lists and transitions settle after the last interaction.
  await page.waitForTimeout(400);
}

/**
 * Saves `<name>-<theme>.png`: the whole window, or the region of `target` plus a small margin
 * (clipped to the viewport) so dialogs and panels keep their surroundings readable.
 */
export async function capture(page: Page, testInfo: TestInfo, name: string, target?: Locator) {
  await settle(page);
  const path = `${SCREENS}/${name}-${testInfo.project.name}.png`;
  if (!target) {
    await page.screenshot({ path, animations: 'disabled' });
    return;
  }
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name}: crop target is not visible`);
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  const clip = {
    x,
    y,
    width: Math.min(viewport.width, box.x + box.width + PAD) - x,
    height: Math.min(viewport.height, box.y + box.height + PAD) - y,
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
