import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'dark', locale: 'en-US' });

test('imports M0-1 localStorage preferences once', async ({ page }) => {
  await page.addInitScript(() => {
    // Simulates a user upgrading from M0-1, before the first launch with the SQLite store.
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('yaggui.theme', 'light');
      localStorage.setItem('yaggui.locale', 'fr');
    }
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  expect(await page.evaluate(() => localStorage.getItem('yaggui.theme'))).toBeNull();

  // Still applied after a reload, now from the (mock) store.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
});
