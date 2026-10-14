import { expect, test, type Page } from '@playwright/test';

/** UI polish pass: SHA copy, HEAD badge, commit summary grid, branch selector dismissal. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`polish-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openYaggui(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('HEAD badge in the graph', async ({ page }) => {
      await openYaggui(page);
      await page.waitForTimeout(500);
      await capture(page, theme, 'head-badge');
    });

    test('commit detail: aligned summary, SHA copy', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openYaggui(page);
      await page.getByRole('listbox', { name: 'Commit graph' }).getByRole('option').nth(1).click();
      const panel = page.getByRole('region', { name: 'Commit details' });
      await expect(panel).toBeVisible();
      const sha = panel.getByRole('button', { name: 'Copy SHA' });
      await expect(sha).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Copy SHA' })).toHaveCount(1);
      await capture(page, theme, 'detail');

      const before = await sha.boundingBox();
      await sha.click();
      await expect(panel.getByRole('status')).toHaveText('Copied');
      const during = await sha.boundingBox();
      expect(during).toEqual(before);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^[0-9a-f]{40}$/);
      await capture(page, theme, 'detail-copied');
      await expect(panel.getByRole('status')).toHaveText('', { timeout: 3000 });
    });

    test('branch selector closes on outside click and Escape', async ({ page }) => {
      await openYaggui(page);
      const trigger = page.getByRole('toolbar').getByRole('button', { name: /^Current branch/ });
      await trigger.click();
      await expect(page.getByRole('combobox')).toBeVisible();
      await capture(page, theme, 'branch-selector');
      await page.mouse.click(600, 400);
      await expect(page.getByRole('combobox')).toBeHidden();

      await trigger.click();
      await expect(page.getByRole('combobox')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('combobox')).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  });
}
