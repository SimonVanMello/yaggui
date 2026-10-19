import { expect, test, type Page } from '@playwright/test';

/** "What's new": installed version in the status bar, changelog dialog and its entry points. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

async function capture(page: Page, name: string, clip?: 'statusbar') {
  await page.evaluate(() => document.fonts.ready);
  const target = clip ? page.locator('footer') : page;
  await target.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

const dialog = (page: Page) => page.getByRole('dialog', { name: "What's new" });
const versionButton = (page: Page) =>
  page.locator('footer').getByRole('button', { name: 'yaggui 0.3.0' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 800 } });

    test('the status bar version opens the changelog, installed version highlighted', async ({
      page,
    }) => {
      await start(page);
      await expect(versionButton(page)).toBeVisible();
      await capture(page, `changelog-statusbar-${theme}.png`, 'statusbar');

      await versionButton(page).click();
      const notes = dialog(page);
      await expect(notes).toBeVisible();
      await expect(notes).toContainText('yaggui 0.3.0 is installed.');

      const sections = notes.locator('section');
      await expect(sections).toHaveCount(4);
      await expect(sections.nth(0).getByRole('heading', { level: 3 })).toHaveText('Unreleased');
      await expect(sections.nth(1).getByRole('heading', { level: 3 })).toHaveText('0.3.0');
      await expect(sections.nth(1)).toHaveAttribute('data-installed', 'true');
      await expect(sections.nth(1)).toContainText('Installed');
      await expect(sections.nth(1)).toContainText('October 16, 2026');
      await expect(sections.nth(2)).not.toHaveAttribute('data-installed');

      // Groups in a fixed order, each with its entries; code spans rendered as code.
      await expect(sections.nth(2).getByRole('heading', { level: 4 })).toHaveText([
        'New features',
        'Fixes',
        'Other changes',
      ]);
      await expect(sections.nth(2).locator('code')).toHaveText('yaggui-bin');
      await capture(page, `changelog-dialog-${theme}.png`);

      await notes.getByRole('button', { name: 'Close' }).click();
      await expect(notes).toBeHidden();
    });
  });
}

test.describe('entry points', () => {
  test.use({ locale: 'en-US' });

  test('opens from the command palette', async ({ page }) => {
    await start(page);
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type("what's new");
    await expect(
      page.getByRole('listbox', { name: 'Command palette' }).getByRole('option').first(),
    ).toContainText("What's new");
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
  });

  test('opens from the preferences, next to the version', async ({ page }) => {
    await start(page);
    await page.keyboard.press('ControlOrMeta+,');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByRole('tab', { name: 'Behavior' }).click();
    await expect(prefs).toContainText('yaggui 0.3.0');
    await prefs.getByRole('button', { name: "What's new" }).click();
    await expect(prefs).toBeHidden();
    await expect(dialog(page)).toBeVisible();
  });
});

test.describe('French', () => {
  test.use({ locale: 'fr-FR' });

  test('labels go through the French catalog', async ({ page }) => {
    await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
    await page.goto('/');
    await page.locator('footer').getByRole('button', { name: 'yaggui 0.3.0' }).click();
    const notes = page.getByRole('dialog', { name: 'Nouveautés' });
    await expect(notes).toContainText('yaggui 0.3.0 est installé.');
    await expect(notes.locator('section').nth(0).getByRole('heading', { level: 3 })).toHaveText(
      'Non publié',
    );
    await expect(notes).toContainText('16 octobre 2026');
  });
});
