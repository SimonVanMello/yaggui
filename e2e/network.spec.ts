import { expect, test, type Page } from '@playwright/test';

/** M2-5: fetch, pull and push on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`network-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page, name: string) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('push shows its progress and can be cancelled', async ({ page }) => {
      await openRepo(page, 'yaggui');
      await toolbar(page).getByRole('button', { name: /^Push/ }).first().click();
      const status = page.locator('footer').getByRole('status');
      await expect(status).toContainText('Receiving objects');
      await expect(status).toContainText('/s');
      await capture(page, theme, 'progress');
      await status.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('footer')).toContainText('Push cancelled');
    });

    test('pull menu lists the strategies', async ({ page }) => {
      await openRepo(page, 'yaggui');
      await toolbar(page).getByRole('button', { name: 'Pull strategy' }).click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: /Fast-forward only/ })).toContainText(
        'default',
      );
      await expect(menu.getByRole('menuitem', { name: 'Rebase' })).toBeVisible();
      await capture(page, theme, 'pull-menu');
    });

    test('force push confirmation and protected branch', async ({ page }) => {
      await openRepo(page, 'yaggui');
      await toolbar(page).getByRole('button', { name: 'Push options' }).click();
      await page.getByRole('menuitem', { name: /Force push/ }).click();
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await expect(dialog).toContainText('Overwrite origin/feat/graph-lanes?');
      await expect(dialog).toContainText('--force-with-lease');
      await capture(page, theme, 'force-confirm');
      await dialog.getByRole('button', { name: 'Force push' }).click();
      await expect(
        page.getByText('origin/feat/graph-lanes was overwritten', { exact: true }),
      ).toBeVisible();
    });

    test('a rejected push offers pull then push', async ({ page }) => {
      // `blog` is 4 commits behind origin/main: a local commit makes the push non-fast-forward.
      await openRepo(page, 'blog');
      await page.evaluate(() => window.__yagguiMock?.simulateCommit(3));
      await toolbar(page).getByRole('button', { name: /^Push/ }).first().click();
      const toast = page.getByRole('listitem').filter({ hasText: 'Push rejected' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast.getByRole('button', { name: 'Pull then push' })).toBeVisible();
      await capture(page, theme, 'rejected');
    });
  });
}
