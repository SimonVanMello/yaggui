import { expect, test, type Page } from '@playwright/test';

/** Window title and the quit / close guard, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`window-${state}-${theme}.png`),
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

const quits = (page: Page) => page.evaluate(() => window.__yagguiMock?.quits ?? -1);

test.describe('window title', () => {
  test.use({ locale: 'en-US' });

  // Playwright's Chromium runs on Linux here: the app name follows the title.
  test('names the active repository and its branch', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('yaggui');
    await page.getByRole('option', { name: /^yaggui\b/ }).click();
    await expect(page).toHaveTitle('yaggui · feat/graph-lanes — yaggui');

    // A welcome tab, then back to the repository.
    await page.keyboard.press('Control+T');
    await expect(page).toHaveTitle('yaggui');
    await page.getByRole('option', { name: /^blog\b/ }).click();
    await expect(page).toHaveTitle(/^blog · \S+ — yaggui$/);
    await page.getByRole('tab', { name: /^yaggui/ }).click();
    await expect(page).toHaveTitle('yaggui · feat/graph-lanes — yaggui');
  });
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('quitting while a push runs asks first', async ({ page }) => {
      await openRepo(page, 'yaggui');
      await page.evaluate(() =>
        window.__yagguiMock?.simulateOp(1, { kind: 'push', stepMs: 60_000 }),
      );
      await expect(page.getByRole('tab', { name: /^yaggui/ })).toContainText(/./);
      await expect(page.locator('footer')).toContainText(/Push/);

      // ⌘Q or the macOS Dock: the backend relays it as `quit-requested`.
      await page.evaluate(() => window.__yagguiMock?.simulateQuitRequest());
      const dialog = page.getByRole('dialog', { name: 'Quit yaggui?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('list', { name: 'What will happen' })).toContainText(
        'Push running in yaggui',
      );
      await capture(page, theme, 'quit-guard');

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(await quits(page)).toBe(0);

      await page.evaluate(() => window.__yagguiMock?.simulateQuitRequest());
      await page
        .getByRole('dialog', { name: 'Quit yaggui?' })
        .getByRole('button', { name: 'Quit anyway' })
        .click();
      await expect.poll(() => quits(page)).toBe(1);
    });
  });
}

test('quitting with nothing in progress does not ask', async ({ page }) => {
  await openRepo(page, 'blog');
  await page.evaluate(() => window.__yagguiMock?.simulateQuitRequest());
  await expect.poll(() => quits(page)).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Quit yaggui is in the command palette', async ({ page }) => {
  await openRepo(page, 'blog');
  await page.keyboard.press('Control+K');
  await page.keyboard.type('Quit yaggui');
  await page.keyboard.press('Enter');
  await expect.poll(() => quits(page)).toBe(1);
});
