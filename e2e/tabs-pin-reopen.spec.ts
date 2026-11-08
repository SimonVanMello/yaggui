import { expect, test, type Page } from '@playwright/test';

/**
 * Tabs: pinned tabs (compact, at the left, kept by "Close other tabs"), "Rename…" of a
 * repository tab, and "Reopen closed tab" (⌘⇧T) bringing a tab back at its former index.
 */

/** Same fixed "now" as the mock data (src/ipc/mockData.ts), for stable relative times. */
const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Open repositories' }).getByRole('tab');
const tab = (page: Page, name: string) =>
  page.getByRole('tab', { name: new RegExp(`^${name}\\b`) });
const tabNames = (page: Page) =>
  tabs(page).evaluateAll((elements) =>
    elements.map((el) => el.querySelector('[class*="label"]')?.textContent ?? ''),
  );

async function openFromWelcome(page: Page, name: string) {
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

async function openThree(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await openFromWelcome(page, 'yaggui');
  await page.keyboard.press('Control+T');
  await openFromWelcome(page, 'linux');
  await page.keyboard.press('Control+T');
  await openFromWelcome(page, 'blog');
}

async function menuItem(page: Page, tabName: string, item: string) {
  await tab(page, tabName).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('pinned tabs stay at the left, compact, and survive "Close other tabs"', async ({
      page,
    }) => {
      await openThree(page);
      await menuItem(page, 'blog', 'Pin tab');
      await menuItem(page, 'linux', 'Pin tab');
      await expect.poll(() => tabNames(page)).toEqual(['blog', 'linux', 'yaggui']);
      await expect(tab(page, 'blog')).toHaveAttribute('data-pinned', '');
      await expect(tab(page, 'blog')).toHaveAccessibleName(/^blog, Pinned/);
      // No close button on a pinned tab.
      await expect(tab(page, 'blog').getByRole('button', { name: /Close/ })).toHaveCount(0);

      await tab(page, 'yaggui').click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'Pin tab' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Close other tabs' })).toBeDisabled();
      // Leftmost unpinned tab: it cannot move left, before the pinned ones.
      await expect(menu.getByRole('menuitem', { name: 'Move left' })).toBeDisabled();
      await capture(page, theme, 'tabs-pinned-menu');
      await page.keyboard.press('Escape');

      // "Close other tabs" from a pinned tab closes only the unpinned ones.
      await menuItem(page, 'linux', 'Close other tabs');
      await expect.poll(() => tabNames(page)).toEqual(['blog', 'linux']);

      // The pinned flag is saved: a reload restores both pinned tabs, pinned.
      await page.reload();
      await expect.poll(() => tabNames(page)).toEqual(['blog', 'linux']);
      await expect(tab(page, 'linux')).toHaveAttribute('data-pinned', '');
      await capture(page, theme, 'tabs-pinned');
    });

    test('renames the repository of a tab, and an empty name gives back the folder name', async ({
      page,
    }) => {
      await openThree(page);
      await menuItem(page, 'blog', 'Rename…');
      const dialog = page.getByRole('dialog', { name: 'Rename repository' });
      const field = dialog.getByRole('textbox', { name: 'Name' });
      await expect(field).toHaveValue('blog');
      await field.fill('Personal blog');
      await capture(page, theme, 'tabs-rename-dialog');

      await field.fill('x'.repeat(61));
      await expect(dialog.getByRole('alert')).toHaveText('60 characters at most.');
      await field.fill('Personal blog');
      await dialog.getByRole('button', { name: 'Rename' }).click();
      await expect(dialog).toBeHidden();
      await expect(tab(page, 'Personal blog')).toBeVisible();

      // The welcome screen lists the new name.
      await page.keyboard.press('Control+T');
      await expect(page.getByRole('option', { name: /^Personal blog\b/ })).toBeVisible();
      await page.keyboard.press('Control+W');

      await menuItem(page, 'Personal blog', 'Rename…');
      await page.getByRole('textbox', { name: 'Name' }).fill('');
      await page.getByRole('button', { name: 'Rename' }).click();
      await expect(tab(page, 'blog')).toBeVisible();
    });

    test('⌘⇧T reopens the closed tab at the same index', async ({ page }) => {
      await openThree(page);
      await page.keyboard.press('Control+2');
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^linux/);
      await page.keyboard.press('Control+W');
      await expect.poll(() => tabNames(page)).toEqual(['yaggui', 'blog']);

      await page.keyboard.press('Control+Shift+T');
      await expect.poll(() => tabNames(page)).toEqual(['yaggui', 'linux', 'blog']);
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^linux/);
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await capture(page, theme, 'tabs-reopened');

      // Nothing left to reopen: the menu item is greyed out.
      await tab(page, 'linux').click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Reopen closed tab' })).toBeDisabled();
    });
  });
}
