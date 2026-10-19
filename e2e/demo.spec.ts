import { expect, test, type Page } from '@playwright/test';

/** W-5: the app on the mocked backend, as served at /demo/ by the built website. */

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

/** Console errors and requests leaving the site, collected until the end of the test. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`exception: ${error.message}`));
  page.on('request', (request) => {
    const { protocol, origin } = new URL(request.url());
    if (protocol.startsWith('http') && origin !== 'http://localhost:4321') {
      problems.push(`external request: ${request.url()}`);
    }
  });
  return problems;
}

for (const { name: theme, colorScheme } of THEMES) {
  test(`opens the sample repository with a banner, ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const problems = watch(page);
    await page.goto('/demo/');

    const banner = page.getByRole('region', { name: 'Demo' });
    await expect(banner).toContainText('Demo on sample data');
    await expect(banner.getByRole('link', { name: 'Download yaggui' })).toHaveAttribute(
      'href',
      '/',
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const graph = page.getByRole('listbox', { name: 'Commit graph' });
    await expect(graph.getByRole('option').first()).toBeVisible();
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/yaggui/);

    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath(`demo-${theme}.png`) });
    expect(problems).toEqual([]);
  });
}

test('the banner can be dismissed', async ({ page }) => {
  await page.goto('/demo/');
  const banner = page.getByRole('region', { name: 'Demo' });
  await banner.getByRole('button', { name: 'Dismiss the banner' }).click();
  await expect(banner).toBeHidden();
});

test('/fr/demo/ redirects to the demo in French', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/fr/demo/');
  await expect(page).toHaveURL(/\/demo\/\?lang=fr$/);
  await expect(page.getByRole('region', { name: 'Demo' })).toContainText('Démo sur des données');
  await expect(page.getByRole('link', { name: 'Télécharger yaggui' })).toHaveAttribute(
    'href',
    '/fr/',
  );
  expect(problems).toEqual([]);
});

test('desktop-only features say so', async ({ page }) => {
  await page.goto('/demo/');
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+K');
  await page.getByRole('combobox', { name: 'Command palette' }).fill('external terminal');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Available in the desktop app').first()).toBeVisible();
});
