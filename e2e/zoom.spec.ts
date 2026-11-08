import { expect, test, type Page } from '@playwright/test';

/** Zoom of the interface: shortcuts, palette, Preferences › Display, canvas sharpness. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`zoom-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
}

/** The CSS zoom the browser fallback applies (the webview zoom in the app). */
const zoomOf = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('zoom'));

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 800 } });

    test('shortcuts step through the levels and the layout still fits', async ({ page }) => {
      await openRepo(page);
      expect(await zoomOf(page)).toBe('');
      await page.keyboard.press('Control+Equal');
      await expect.poll(() => zoomOf(page)).toBe('1.1');
      await page.keyboard.press('Control+Equal');
      await expect.poll(() => zoomOf(page)).toBe('1.25');

      // The graph tiles are drawn for the zoom: as many bitmap pixels as screen pixels.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const tile = [...document.querySelectorAll('canvas')].find(
              (canvas) => canvas.style.visibility === 'visible',
            );
            if (!tile) return null;
            return tile.width / (parseFloat(tile.style.width) * window.devicePixelRatio);
          }),
        )
        .toBeCloseTo(1.25, 2);
      // Nothing is pushed out of the window: no horizontal or vertical page scroll.
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          x: root.scrollWidth - root.clientWidth,
          y: root.scrollHeight - root.clientHeight,
        };
      });
      expect(overflow.x).toBeLessThanOrEqual(0);
      expect(overflow.y).toBeLessThanOrEqual(0);
      await expect(page.getByRole('tab', { selected: true })).toBeInViewport();
      await capture(page, theme, '125');

      // Ctrl+Shift+= is "Ctrl++" on a US keyboard.
      await page.keyboard.press('Control+Shift+Equal');
      await expect.poll(() => zoomOf(page)).toBe('1.5');
      // The top level stays.
      await page.keyboard.press('Control+Equal');
      await expect.poll(() => zoomOf(page)).toBe('1.5');
      await page.keyboard.press('Control+Minus');
      await expect.poll(() => zoomOf(page)).toBe('1.25');

      // Kept across launches.
      await page.reload();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await expect.poll(() => zoomOf(page)).toBe('1.25');

      await page.keyboard.press('Control+0');
      await expect.poll(() => zoomOf(page)).toBe('');
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Control+Minus');
      await expect.poll(() => zoomOf(page)).toBe('0.8');
      await capture(page, theme, '80');
    });

    test('Preferences › Display has a Zoom row', async ({ page }) => {
      await openRepo(page);
      await page.keyboard.press('Control+,');
      const prefs = page.getByRole('dialog', { name: 'Preferences' });
      await prefs.getByPlaceholder(/Search/).fill('zoom');
      const value = prefs.getByTestId('zoom-value');
      await expect(value).toHaveText('100 %');
      await expect(prefs.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
      await prefs.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect(value).toHaveText('110 %');
      await expect.poll(() => zoomOf(page)).toBe('1.1');
      await capture(page, theme, 'preferences');
      await prefs.getByRole('button', { name: 'Zoom out', exact: true }).click();
      await prefs.getByRole('button', { name: 'Zoom out', exact: true }).click();
      await expect(value).toHaveText('90 %');
      await prefs.getByRole('button', { name: 'Reset', exact: true }).click();
      await expect(value).toHaveText('100 %');
      await expect.poll(() => zoomOf(page)).toBe('');
    });

    test('the palette lists the zoom actions with their shortcuts', async ({ page }) => {
      await openRepo(page);
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox', { name: 'Command palette' }).fill('zoom');
      const options = page.getByRole('listbox', { name: 'Command palette' }).getByRole('option');
      await expect(options.filter({ hasText: 'Zoom in' }).first()).toBeVisible();
      await expect(options.filter({ hasText: 'Zoom out' })).toBeVisible();
      await expect(options.filter({ hasText: 'Reset the zoom (100 %)' })).toBeVisible();
      await capture(page, theme, 'palette');
      await options.filter({ hasText: 'Zoom in' }).first().click();
      await expect.poll(() => zoomOf(page)).toBe('1.1');
    });
  });
}
