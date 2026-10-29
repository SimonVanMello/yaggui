import { expect, test, type Page } from '@playwright/test';

/** Color themes (F-320) and the Preferences dialog: sections, search, gallery, palette picker. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`themes-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

const prefsDialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });

async function openPrefs(page: Page, section: string) {
  await page.keyboard.press('Control+,');
  const prefs = prefsDialog(page);
  await expect(prefs).toBeVisible();
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: section, exact: true })
    .click();
  return prefs;
}

const html = (page: Page) => page.locator('html');

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1440, height: 900 } });

    test('the sections of the dialog', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'General');
      await expect(prefs.getByRole('heading', { name: 'General' })).toBeVisible();
      await capture(page, theme, 'prefs-general');
      for (const section of ['Display', 'Tools', 'Fetch and pull', 'Safety', 'Git configuration']) {
        await prefs
          .getByRole('navigation', { name: 'Preference sections' })
          .getByRole('button', { name: section, exact: true })
          .click();
        await expect(prefs.getByRole('heading', { name: section })).toBeVisible();
      }
      await capture(page, theme, 'prefs-gitconfig');
    });

    test('search: results of every section, Ctrl+F and Esc', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'Display');
      await prefs.getByLabel('Code font').focus();
      await page.keyboard.press('Control+F');
      const search = prefs.getByRole('searchbox', { name: 'Search settings' });
      await expect(search).toBeFocused();
      await search.fill('pull');
      await expect(prefs.getByRole('heading', { name: 'Results' })).toBeVisible();
      await expect(prefs.getByText('Default pull strategy')).toBeVisible();
      await expect(prefs.getByText('Pull strategy (pull.rebase)')).toBeVisible();
      await capture(page, theme, 'prefs-search');

      await search.fill('qwxz');
      await expect(prefs).toContainText('No setting matches “qwxz”');
      // Esc in the field clears the search, a second one closes the dialog.
      await page.keyboard.press('Escape');
      await expect(search).toHaveValue('');
      await expect(prefs).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(prefs).toBeHidden();
    });

    test('gallery: hover previews, a click applies, leaving restores', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'Appearance');
      await expect(prefs.locator('[data-theme-id]')).toHaveCount(25);
      await page.mouse.move(0, 0);
      await capture(page, theme, 'prefs-appearance');

      await prefs.locator('[data-theme-id="mocha"]').hover();
      await expect(html(page)).toHaveAttribute('data-theme', 'mocha');
      await expect(
        prefs.getByRole('status').filter({ hasText: 'Preview: Catppuccin Mocha' }),
      ).toBeVisible();
      await capture(page, theme, 'prefs-preview');
      await page.mouse.move(0, 0);
      await expect(html(page)).toHaveAttribute('data-theme', theme);

      // Keyboard: the arrows preview, Esc ends the preview and keeps the dialog.
      await prefs.locator('[data-theme-id="graphite"]').focus();
      await page.keyboard.press('ArrowRight');
      await expect(html(page)).toHaveAttribute('data-theme', 'paper');
      await page.keyboard.press('Escape');
      await expect(html(page)).toHaveAttribute('data-theme', theme);
      await expect(prefs).toBeVisible();

      await prefs.getByRole('textbox', { name: 'Filter themes' }).fill('latte');
      await prefs.locator('[data-theme-id="latte"]').click();
      await expect(html(page)).toHaveAttribute('data-theme', 'latte');
      await page.keyboard.press('Escape');
      await capture(page, theme, 'app-latte');

      // Saved, and applied before the first paint of the next launch.
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-theme', 'latte');
    });

    test('following the system: one theme per mode', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'Appearance');
      const follow = prefs.getByRole('switch', { name: /Follow the system theme/ });
      // The mock starts on "system".
      await expect(follow).toBeChecked();
      const [same, other] =
        colorScheme === 'dark' ? ['dracula', 'github-light'] : ['github-light', 'dracula'];

      // A theme of the mode the OS is in: still following.
      await prefs.locator(`[data-theme-id="${same}"]`).click();
      await expect(html(page)).toHaveAttribute('data-theme', same);
      await expect(follow).toBeChecked();
      await page.mouse.move(0, 0);
      await capture(page, theme, 'prefs-slots');

      // One of the other mode is shown, and the OS is no longer followed.
      await prefs.locator(`[data-theme-id="${other}"]`).click();
      await expect(html(page)).toHaveAttribute('data-theme', other);
      await expect(follow).not.toBeChecked();

      // Following again: each mode has its theme.
      await follow.click();
      await expect(html(page)).toHaveAttribute('data-theme', same);
      await page.emulateMedia({ colorScheme: colorScheme === 'dark' ? 'light' : 'dark' });
      await expect(html(page)).toHaveAttribute('data-theme', other);
    });

    test('palette: "theme" then Enter lists the themes, Esc goes back', async ({ page }) => {
      await start(page);
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox', { name: 'Command palette' }).fill('theme');
      await expect(page.getByRole('option').first()).toContainText('Theme: choose a color theme…');
      await page.keyboard.press('Enter');
      const picker = page.getByRole('combobox', { name: 'Color theme' });
      await expect(picker).toBeFocused();
      await expect(page.getByRole('option', { selected: true })).toContainText(
        theme === 'graphite' ? 'Graphite' : 'Paper',
      );
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(html(page)).not.toHaveAttribute('data-theme', theme);
      await capture(page, theme, 'palette-themes');
      await page.keyboard.press('Escape');
      await expect(html(page)).toHaveAttribute('data-theme', theme);

      await page.keyboard.press('Control+K');
      await page.getByRole('combobox', { name: 'Command palette' }).fill('theme');
      await page.keyboard.press('Enter');
      await picker.fill('tokyo');
      await page.keyboard.press('Enter');
      await expect(html(page)).toHaveAttribute('data-theme', 'tokyo-night');
      await capture(page, theme, 'app-tokyo-night');
    });
  });
}
