import { expect, test, type Page } from '@playwright/test';

/**
 * M7-7: history of a line range, from the blame and from a commit diff (mock backend). M8-2:
 * the palette entry for the selected lines.
 */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`line-history-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const details = (page: Page) => page.getByRole('region', { name: 'Commit details' });

async function openYaggui(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(graphRow(page, 0)).toBeVisible();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('the palette opens the history of the lines selected in the blame (M8-2)', async ({
      page,
    }) => {
      await openYaggui(page);
      const palette = page.getByRole('listbox', { name: 'Command palette' });
      const entry = palette.getByRole('option', { name: /^History of the selected lines/ });
      // No lines selected anywhere: listed, with the reason.
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('selected lines');
      await expect(entry).toContainText('Select lines in a blame or a commit diff first');
      await page.keyboard.press('Escape');

      await graphRow(page, 2).click();
      await details(page)
        .getByRole('option', { name: / layout\.ts / })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Blame at this commit$/ }).click();
      const lines = page.getByRole('region', { name: /^Blame of / }).getByRole('grid');
      await lines.getByRole('row').nth(9).click();
      await lines
        .getByRole('row')
        .nth(13)
        .click({ modifiers: ['Shift'] });
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('selected lines');
      await expect(entry).not.toContainText('Select lines');
      await capture(page, theme, 'palette');
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('region', { name: /^Line history of .*\(Lines 10–14\)$/ }),
      ).toBeVisible();
    });

    test('blame: select lines, then open their history', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 2).click();
      await details(page)
        .getByRole('option', { name: / layout\.ts / })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Blame at this commit$/ }).click();
      const blame = page.getByRole('region', { name: /^Blame of / });
      const lines = blame.getByRole('grid');
      await lines.getByRole('row').nth(9).click();
      await lines
        .getByRole('row')
        .nth(13)
        .click({ modifiers: ['Shift'] });
      await expect(lines.locator('[data-range="true"]')).toHaveCount(5);
      const bar = blame.getByLabel('Selected commit');
      const open = bar.getByRole('button', { name: 'History of lines 10–14' });
      await expect(open).toBeVisible();
      // The same action in the menu of a line of the range.
      await lines.getByRole('row').nth(11).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'History of lines 10–14' })).toBeVisible();
      await capture(page, theme, 'blame-selection');
      await page.keyboard.press('Escape');

      await open.click();
      const view = page.getByRole('region', { name: /^Line history of .*\(Lines 10–14\)$/ });
      await expect(view).toBeVisible();
      const commits = view.getByRole('listbox', { name: 'Commits that changed the lines' });
      await expect(commits.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
      await expect(commits.getByRole('option').first()).toContainText('Lines 10–14');
      await expect(view.locator('.cm-editor').first()).toBeVisible();
      await capture(page, theme, 'view');

      // `j` steps to the older commit; the oldest one adds the lines.
      await page.keyboard.press('j');
      await expect(commits.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
      await commits.focus();
      await page.keyboard.press('End');
      await expect(view.getByText(/^The lines appear/)).toBeVisible();
      await capture(page, theme, 'origin');

      await page.keyboard.press('Escape');
      await expect(view).toHaveCount(0);
      await expect(graphRow(page, 0)).toBeVisible();
    });

    test('commit diff: gutter selection opens the history of the lines', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 2).click();
      await details(page)
        .getByRole('option', { name: / layout\.ts / })
        .click();
      const diff = page.getByRole('region', { name: /^Diff of / });
      await page.getByRole('radio', { name: 'Unified' }).click();
      const gutter = diff.locator('.yaggui-signs .yaggui-selectable');
      await gutter.nth(1).click();
      await gutter.nth(3).click({ modifiers: ['Shift'] });
      await expect(diff.getByRole('status')).toHaveText('3 lines selected');
      const open = diff.getByRole('button', { name: 'Line history' });
      await expect(open).toBeVisible();
      await capture(page, theme, 'diff-selection');

      await open.click();
      const view = page.getByRole('region', { name: /^Line history of / });
      await expect(view).toBeVisible();
      await expect(
        view.getByRole('listbox', { name: 'Commits that changed the lines' }).getByRole('option'),
      ).not.toHaveCount(0);
    });

    test('a long search can be stopped, then started again (M7-10)', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 2).click();
      await details(page)
        .getByRole('option', { name: / layout\.ts / })
        .click();
      const diff = page.getByRole('region', { name: /^Diff of / });
      await page.getByRole('radio', { name: 'Unified' }).click();
      const gutter = diff.locator('.yaggui-signs .yaggui-selectable');
      await gutter.nth(1).click();
      // `git log -L` on a long history: the read takes a while, and `cancelRead` ends it.
      await page.evaluate(() => window.__yagguiMock?.simulateSlowReads(60_000));
      await diff.getByRole('button', { name: 'Line history' }).click();
      const view = page.getByRole('region', { name: /^Line history of / });
      await expect(view.getByRole('status')).toHaveText(/^Following the lines/);
      await capture(page, theme, 'searching');
      await view.getByRole('button', { name: /^Stop/ }).click();
      await expect(view.getByText('Search stopped.')).toBeVisible();
      await capture(page, theme, 'stopped');

      await page.evaluate(() => window.__yagguiMock?.simulateSlowReads(0));
      await view.getByRole('button', { name: 'Search again' }).click();
      await expect(
        view.getByRole('listbox', { name: 'Commits that changed the lines' }).getByRole('option'),
      ).not.toHaveCount(0);
    });
  });
}
