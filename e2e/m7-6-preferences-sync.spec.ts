import { expect, test, type Page } from '@playwright/test';

/** M7-6: preferences and shortcuts import / export (F-326). */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`m7-6-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });

async function openPrefs(page: Page) {
  await page.keyboard.press('Control+,');
  const prefs = dialog(page, 'Preferences');
  await expect(prefs).toBeVisible();
  return prefs;
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 900 } });

    test('the import preview lists the changes, then applies them in one step', async ({
      page,
    }) => {
      await start(page);
      const prefs = await openPrefs(page);
      // The file sets the dark theme: it is applied at once, no restart needed.
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const follow = prefs.getByRole('switch', { name: /Follow the system theme/ });
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'Appearance', exact: true })
        .click();
      await expect(follow).toBeChecked();
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'General', exact: true })
        .click();
      await prefs.getByRole('button', { name: 'Import…' }).click();

      const review = dialog(page, 'Import preferences');
      await expect(review).toBeVisible();
      await expect(review.getByText('Text size')).toBeVisible();
      await expect(review.getByText('New tab')).toBeVisible();
      await expect(review.getByText('editor, gitPath')).toBeVisible();
      await expect(review.getByText('commitGraphStyle')).toBeVisible();
      await capture(page, theme, 'import-preview');

      await review.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(review).toBeHidden();
      await expect(page.getByText('Preferences and shortcuts imported').first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'Appearance', exact: true })
        .click();
      await expect(follow).not.toBeChecked();
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'Display', exact: true })
        .click();
      await expect(prefs.getByLabel('Text size')).toHaveValue('15');
      await capture(page, theme, 'import-applied');

      // Applied: the same file now changes nothing.
      await prefs
        .getByRole('navigation', { name: 'Preference sections' })
        .getByRole('button', { name: 'General', exact: true })
        .click();
      await prefs.getByRole('button', { name: 'Import…' }).click();
      await expect(review.getByText('This file changes nothing')).toBeVisible();
      await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
      await capture(page, theme, 'import-nothing');
    });

    test('an invalid file is refused with a message and changes nothing', async ({ page }) => {
      await start(page);
      await page.evaluate(() =>
        window.__yagguiMock?.setPickedPreferencesFile(
          '{"format":"yaggui-preferences","version":1,"preferences":{"fontSize":99}}',
        ),
      );
      const prefs = await openPrefs(page);
      await prefs.getByRole('button', { name: 'Import…' }).click();
      await expect(
        page.getByText('Could not import the file', { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText('This is not a valid yaggui preferences file').first(),
      ).toBeVisible();
      await expect(dialog(page, 'Import preferences')).toBeHidden();
      await capture(page, theme, 'import-invalid');
    });

    test('a file from a newer version is refused', async ({ page }) => {
      await start(page);
      await page.evaluate(() =>
        window.__yagguiMock?.setPickedPreferencesFile(
          '{"format":"yaggui-preferences","version":2,"preferences":{}}',
        ),
      );
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox').fill('import preferences');
      await page.keyboard.press('Enter');
      await expect(page.getByText(/format version 2/).first()).toBeVisible();
    });

    test('export writes the file and says what was left out', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page);
      // Cancelling the save dialog writes nothing and says nothing (M7-10).
      await page.evaluate(() => window.__yagguiMock?.setPickedExportPath(null));
      await prefs.getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Preferences and shortcuts exported')).toHaveCount(0);
      expect(await page.evaluate(() => window.__yagguiMock?.exportedPreferences())).toBeNull();
      await prefs.getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByText('Preferences and shortcuts exported').first()).toBeVisible();
      const exported = await page.evaluate(() => window.__yagguiMock?.exportedPreferences());
      const file = JSON.parse(exported ?? '{}') as {
        format: string;
        preferences: Record<string, unknown>;
      };
      expect(file.format).toBe('yaggui-preferences');
      expect(file.preferences).toHaveProperty('fontSize');
      expect(file.preferences).not.toHaveProperty('gitPath');
    });
  });
}
