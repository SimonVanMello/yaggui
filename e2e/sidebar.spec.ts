import { expect, test, type Page } from '@playwright/test';

/** M1-3: refs sidebar and toolbar branch selector, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`sidebar-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.setViewportSize({ width: 900, height: 560 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

async function openYaggui(page: Page) {
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

const tree = (page: Page) => page.getByRole('tree');

test.use({ locale: 'en-US' });

test('clicking a sidebar branch selects and shows its commit in the graph', async ({ page }) => {
  await start(page);
  await openYaggui(page);
  const row = tree(page).getByRole('treeitem', { name: /palette-42/ });
  await row.click();
  const selected = page.locator('[id^="graph-row-"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeVisible();
  const label = page.getByRole('listbox').locator('[aria-selected="true"]');
  await expect(label.first()).toContainText('palette-42');
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await start(page);
    });

    test('sidebar of the yaggui repository', async ({ page }) => {
      await openYaggui(page);
      await expect(tree(page)).toBeVisible();
      await expect(tree(page).getByRole('treeitem').first()).toBeVisible();
      await capture(page, theme, 'yaggui');
    });

    test('filter', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('ControlOrMeta+Shift+R');
      await expect(page.getByRole('textbox', { name: /filter/i })).toBeFocused();
      await page.keyboard.type('feat');
      await expect(tree(page).getByRole('treeitem').first()).toBeVisible();
      await capture(page, theme, 'filter');
      await page.keyboard.press('Escape');
    });

    test('5 000 branches stay virtualized', async ({ page }) => {
      await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/many-refs'));
      await page.getByRole('button', { name: /^Open/ }).first().click();
      await expect(tree(page)).toBeVisible();
      await expect(tree(page).getByRole('treeitem').first()).toBeVisible();
      const rendered = await tree(page).getByRole('treeitem').count();
      expect(rendered).toBeLessThan(200);
      await capture(page, theme, 'many-refs');
    });

    test('branch selector', async ({ page }) => {
      await openYaggui(page);
      await page
        .getByRole('toolbar')
        .getByRole('button', { name: /^Current branch/ })
        .click();
      await expect(page.getByRole('combobox')).toBeVisible();
      await expect(
        page
          .getByRole('listbox', { name: /branch/i })
          .getByRole('option')
          .first(),
      ).toBeVisible();
      await capture(page, theme, 'selector');
    });
  });
}
