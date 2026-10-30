import { expect, test, type Page } from '@playwright/test';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await page.goto('/#primitives');
      // The default `system` preference follows the emulated OS color scheme.
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(page.getByTestId('app-info')).toHaveText('yaggui 0.3.0 · git 2.47.1');
      await page.evaluate(() => document.fonts.ready);
    });

    test('primitives page', async ({ page }) => {
      await capture(page, name, 'primitives');
    });

    test('tooltip', async ({ page }) => {
      await page.getByLabel('Push', { exact: true }).hover();
      await expect(page.getByRole('tooltip')).toContainText('Push');
      await capture(page, name, 'tooltip');
    });

    test('a tooltip wraps an unbreakable string inside its box', async ({ page }) => {
      await page.getByLabel(/nyx_rest_acme/).hover();
      const tooltip = page.locator('[data-radix-popper-content-wrapper] > *');
      await expect(tooltip).toBeVisible();
      const overflow = await tooltip.evaluate((box) => {
        const outer = box.getBoundingClientRect();
        return [...box.querySelectorAll('*')].some((child) => {
          const inner = child.getBoundingClientRect();
          return inner.left < outer.left - 0.5 || inner.right > outer.right + 0.5;
        });
      });
      expect(overflow).toBe(false);
      expect(await tooltip.evaluate((box) => box.scrollWidth <= box.clientWidth)).toBe(true);
      await capture(page, name, 'tooltip-long');
    });

    test('menu', async ({ page }) => {
      await page.getByRole('button', { name: 'Branch actions' }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: /Merge into main/ }).hover();
      await capture(page, name, 'menu');
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    });

    test('dialog', async ({ page }) => {
      await page.getByRole('button', { name: 'Open dialog' }).click();
      const dialog = page.getByRole('dialog', { name: 'Discard changes?' });
      await expect(dialog).toBeVisible();
      await capture(page, name, 'dialog');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
    });

    test('toast', async ({ page }) => {
      await page.getByRole('button', { name: 'Show toast' }).click();
      await expect(
        page.locator('ol > li').filter({ hasText: 'Pushed to origin/main' }),
      ).toBeVisible();
      await capture(page, name, 'toast');
    });
  });
}

test.describe('preferences', () => {
  test.use({ colorScheme: 'dark' });

  test('switches theme and language', async ({ page }) => {
    await page.goto('/#primitives');
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');

    await page.getByRole('radio', { name: 'Français' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("Primitives d'interface");
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(page.getByRole('radio', { name: 'Système' })).toBeVisible();
  });
});
