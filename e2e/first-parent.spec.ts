import { expect, test, type Page } from '@playwright/test';

/**
 * M7-5: first-parent history (F-032) on the mock backend: toolbar toggle, shortcut, filter bar,
 * search scope, a jump outside the mode and its way back to the full history.
 */

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

async function openRepo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
}

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const filterBar = (page: Page) => page.getByRole('status', { name: 'Graph filter' });
const toggle = (page: Page) =>
  page.getByRole('toolbar').getByRole('button', { name: 'First parent' });
const parents = (page: Page) => page.locator('dt:text-is("Parents") + dd button');

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('first-parent history from the toolbar, the shortcut and the filter bar', async ({
      page,
    }) => {
      await openRepo(page);
      await expect(graphRow(page, 0)).toBeVisible();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(filterBar(page)).toContainText('First-parent history');
      await graphRow(page, 0).click();
      await capture(page, theme, 'graph-first-parent');

      // Kept per repository: still on after a reload.
      await page.reload();
      await page.getByRole('tab', { name: /^yaggui\b/ }).click();
      await expect(filterBar(page)).toContainText('First-parent history');

      // The search only scans the first-parent history and says so.
      await page.keyboard.press('ControlOrMeta+f');
      const search = page.getByRole('search', { name: 'Search commits' });
      await search
        .getByRole('textbox', { name: 'Search commits' })
        .fill("Merge branch 'feat/tabs-dnd-38'");
      await expect(search).toContainText('1 / 1');
      await expect(search).toContainText('First-parent history only');
      await capture(page, theme, 'search-first-parent');

      // The match, a merge of a deleted branch, is selected: its second parent is not a row,
      // and jumping to it says why and offers the full history.
      await expect(parents(page)).toHaveCount(2);
      await page.keyboard.press('Escape');
      const second = (await parents(page).nth(1).textContent()) ?? '';
      await parents(page).nth(1).click();
      const notice = page.getByText(`${second} is not in the first-parent history`, {
        exact: true,
      });
      await expect(notice).toBeVisible();
      await capture(page, theme, 'jump-outside-first-parent');
      await page.getByRole('button', { name: 'Show full history' }).click();
      await expect(filterBar(page)).toHaveCount(0);
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('[data-row][aria-selected="true"]')).toContainText(second);

      // The shortcut turns it on and off again.
      await page.keyboard.press('ControlOrMeta+Alt+p');
      await expect(filterBar(page)).toContainText('First-parent history');
      await page.keyboard.press('ControlOrMeta+Alt+p');
      await expect(filterBar(page)).toHaveCount(0);
    });
  });
}
