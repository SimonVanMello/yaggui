import { expect, test, type Page } from '@playwright/test';

/**
 * M5-3: the views of the recent tabs stay mounted (hidden, out of the accessibility tree) and
 * keep their scroll and selection; a repository changed while its tab is hidden is up to date
 * when the tab is shown again.
 */

/** Same fixed "now" as the mock data (src/ipc/mockData.ts), for stable relative times. */
const MOCK_NOW_MS = 1_791_795_600_000;
const YAGGUI_ID = 1;

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

async function openFromWelcome(page: Page, name: string) {
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

const graph = (page: Page) => page.getByRole('listbox', { name: 'Commit graph' });
const views = (page: Page) => page.locator('[data-tab-view]');

async function showTab(page: Page, index: number, name: string) {
  await page.keyboard.press(`Control+${String(index)}`);
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('kept tab views keep their state and catch up on changes made while hidden', async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await openFromWelcome(page, 'yaggui');
      await page.keyboard.press('Control+T');
      await openFromWelcome(page, 'linux');
      await page.keyboard.press('Control+T');
      await openFromWelcome(page, 'blog');
      await expect(graph(page).getByRole('option').first()).toBeVisible();

      // linux: scrolled down, one commit selected.
      await showTab(page, 2, 'linux');
      await expect(graph(page).getByRole('option').first()).toBeVisible();
      await graph(page).evaluate((el) => {
        el.scrollTop = 40_000;
      });
      await expect(graph(page).locator('[data-row="1435"]')).toBeAttached();
      const picked = graph(page).locator('[data-row="1440"]');
      await picked.click();
      await expect(picked).toHaveAttribute('aria-selected', 'true');
      const scrollTop = await graph(page).evaluate((el) => el.scrollTop);

      // Three views mounted, two of them hidden and inert: one graph in the accessibility tree.
      await showTab(page, 3, 'blog');
      await expect(views(page)).toHaveCount(3);
      await expect(page.locator('[data-tab-view][hidden][inert]')).toHaveCount(2);
      await expect(graph(page)).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);

      // yaggui changes while its tab is hidden: a commit and an edited file.
      await page.evaluate((id) => {
        window.__yagguiMock?.simulateCommit(id, 'feat: committed while the tab was hidden');
        window.__yagguiMock?.simulateEdit(id, 'hidden-edit.txt', 'edited while hidden\n');
      }, YAGGUI_ID);

      // linux: same scroll position and selection.
      await showTab(page, 2, 'linux');
      await expect(picked).toHaveAttribute('aria-selected', 'true');
      expect(await graph(page).evaluate((el) => el.scrollTop)).toBe(scrollTop);
      await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();

      // yaggui: the commit and the file are shown.
      await showTab(page, 1, 'yaggui');
      await expect(
        graph(page).getByRole('option', { name: /committed while the tab was hidden/ }),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Local changes' }).getByText('hidden-edit.txt'),
      ).toBeVisible();
      await capture(page, theme, 'keepalive-caught-up');

      // A fourth tab: only the three most recent views stay mounted.
      await page.keyboard.press('Control+T');
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Open a repository' });
      await dialog.getByRole('textbox').fill('/Users/alex/dev/unborn-project');
      await dialog.getByRole('button', { name: /^Open/ }).last().click();
      await expect(page.getByText('No commits yet')).toBeVisible();
      await expect(views(page)).toHaveCount(3);
      // blog, shown least recently, was unmounted; it is rebuilt when shown again.
      await showTab(page, 3, 'blog');
      await expect(graph(page).getByRole('option').first()).toBeVisible();
      await expect(views(page)).toHaveCount(3);
    });
  });
}
