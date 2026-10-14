import { expect, test, type Locator, type Page } from '@playwright/test';

/** A plain click on the file whose diff is open closes that diff, like its close button. */

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

const diffView = (page: Page) => page.getByRole('region', { name: /^Diff of / });
const graph = (page: Page) => page.getByRole('listbox', { name: 'Commit graph' });
const unstaged = (page: Page) => page.getByRole('listbox', { name: 'Unstaged', exact: true });
/** Row of a file by its full path (the row's title). */
const file = (list: Locator, path: string) =>
  list.getByRole('option').and(list.locator(`[title="${path}"]`));

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('clicking the open file of the changes panel closes its diff', async ({ page }) => {
      await openRepo(page);
      const readme = file(unstaged(page), 'README.md');
      const tabBar = file(unstaged(page), 'src/features/tabs/TabBar.tsx');

      await readme.click();
      await expect(diffView(page)).toHaveAccessibleName(/README\.md$/);
      await expect(readme).toHaveAttribute('aria-selected', 'true');
      await capture(page, theme, 'diff-toggle-open');

      // Same file again: back to the graph, the row no longer selected.
      await readme.click();
      await expect(diffView(page)).toHaveCount(0);
      await expect(graph(page)).toBeVisible();
      await expect(readme).toHaveAttribute('aria-selected', 'false');
      await capture(page, theme, 'diff-toggle-closed');

      // Another file still switches the diff.
      await readme.click();
      await tabBar.click();
      await expect(diffView(page)).toHaveAccessibleName(/TabBar\.tsx$/);
      await expect(readme).toHaveAttribute('aria-selected', 'false');

      // Ctrl/⌘ and Shift clicks keep picking files, never close the diff.
      await tabBar.click({ modifiers: ['ControlOrMeta'] });
      await expect(diffView(page)).toHaveAccessibleName(/TabBar\.tsx$/);
      await readme.click({ modifiers: ['Shift'] });
      await expect(diffView(page)).toHaveAccessibleName(/TabBar\.tsx$/);
      await expect(readme).toHaveAttribute('aria-selected', 'true');

      // With several files picked, a plain click narrows to the open file first, then closes.
      await tabBar.click();
      await expect(diffView(page)).toHaveAccessibleName(/TabBar\.tsx$/);
      await expect(readme).toHaveAttribute('aria-selected', 'false');
      await tabBar.click();
      await expect(diffView(page)).toHaveCount(0);
    });

    test('clicking the open file of a commit closes its diff', async ({ page }) => {
      await openRepo(page);
      await page.locator('[data-row="2"]').click();
      const files = page.getByRole('listbox', { name: /^Commit [0-9a-f]{7}$/ });
      const first = files.getByRole('option').first();
      await first.click();
      await expect(diffView(page)).toBeVisible();
      await expect(first).toHaveAttribute('aria-selected', 'true');

      await first.click();
      await expect(diffView(page)).toHaveCount(0);
      await expect(graph(page)).toBeVisible();
      await expect(first).toHaveAttribute('aria-selected', 'false');
      // The commit stays selected: its files are still listed.
      await expect(files).toBeVisible();
      await capture(page, theme, 'diff-toggle-commit-closed');

      // Keyboard navigation still opens files.
      await first.click();
      await files.focus();
      await page.keyboard.press('ArrowDown');
      await expect(files.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(diffView(page)).toBeVisible();
    });
  });
}
