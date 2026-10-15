import { expect, test, type Page } from '@playwright/test';

/** Panel sizes, sidebar sections and graph columns are kept per repository, beyond the life of its tab. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

async function openFromWelcome(page: Page, name: string) {
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

const section = (page: Page, name: string) =>
  page.getByRole('tree').getByRole('treeitem', { name: new RegExp(`^${name}, `) });

/** The row of column titles of the visible tab (the kept-alive ones stay in the DOM, hidden). */
const columnTitles = (page: Page) =>
  page.getByText('Commit message', { exact: true }).locator('..').filter({ visible: true });

const rightResizer = (page: Page) =>
  page.getByRole('separator', { name: 'Resize the right panel' }).filter({ visible: true });

async function closeActiveTab(page: Page, name: string) {
  await page.getByRole('button', { name: `Close ${name}` }).click();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 800 } });

    test('reopening a repository finds its sections and columns as they were', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await openFromWelcome(page, 'yaggui');

      // Narrow the right panel, collapse Local, expand Tags, hide the date column.
      const defaultWidth = Number(await rightResizer(page).getAttribute('aria-valuenow'));
      await rightResizer(page).focus();
      await page.keyboard.press('ArrowRight');
      const width = String(defaultWidth - 16);
      await expect(rightResizer(page)).toHaveAttribute('aria-valuenow', width);
      await expect(section(page, 'Local')).toHaveAttribute('aria-expanded', 'true');
      await section(page, 'Local').click();
      await expect(section(page, 'Local')).toHaveAttribute('aria-expanded', 'false');
      if ((await section(page, 'Tags').getAttribute('aria-expanded')) !== 'true') {
        await section(page, 'Tags').click();
      }
      await expect(section(page, 'Tags')).toHaveAttribute('aria-expanded', 'true');
      await expect(columnTitles(page)).toContainText('Date');
      await columnTitles(page).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Date' }).click();
      await expect(columnTitles(page)).not.toContainText('Date');

      await closeActiveTab(page, 'yaggui');
      await openFromWelcome(page, 'yaggui');
      await expect(rightResizer(page)).toHaveAttribute('aria-valuenow', width);
      await expect(section(page, 'Local')).toHaveAttribute('aria-expanded', 'false');
      await expect(section(page, 'Tags')).toHaveAttribute('aria-expanded', 'true');
      await expect(columnTitles(page)).not.toContainText('Date');
      await expect(columnTitles(page)).toContainText('Author');
      await capture(page, `repo-layout-reopened-${theme}.png`);

      // Another repository keeps its own (default) layout.
      await page.keyboard.press('ControlOrMeta+T');
      await openFromWelcome(page, 'blog');
      await expect(section(page, 'Local')).toHaveAttribute('aria-expanded', 'true');
      await expect(columnTitles(page)).toContainText('Date');
      await expect(rightResizer(page)).toHaveAttribute('aria-valuenow', String(defaultWidth));

      // And the layout survives a restart (the mock keeps its store across reloads).
      await closeActiveTab(page, 'blog');
      await closeActiveTab(page, 'yaggui');
      // Tabs are saved shortly after a change: wait for the welcome tab alone to be stored.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const saved = await window.__yagguiMock?.commands.getTabs();
            return saved?.status === 'ok' ? saved.data.tabs.map((tab) => tab.repoId) : [];
          }),
        )
        .toEqual([null]);
      await page.reload();
      await openFromWelcome(page, 'yaggui');
      await expect(rightResizer(page)).toHaveAttribute('aria-valuenow', width);
      await expect(section(page, 'Local')).toHaveAttribute('aria-expanded', 'false');
      await expect(columnTitles(page)).not.toContainText('Date');
    });
  });
}
