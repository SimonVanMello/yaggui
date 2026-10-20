import { expect, test, type Page } from '@playwright/test';

/** Commit message edited from the header of the commit detail panel, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`commit-message-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

/** `blog` has a clean working copy and a linear `main`, which a rebase needs. */
async function openBlog(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^blog\b/ }).click();
  await expect(page.locator('[data-row="0"]')).toBeVisible();
}

/** Row of the checked-out `main`. */
const headRow = (page: Page) =>
  page
    .locator('[data-row]')
    .filter({ has: page.locator('[data-ref-kind="local"][data-ref-name="main"]') })
    .first();
const details = (page: Page) => page.getByRole('region', { name: 'Commit details' });
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('the pencil edits the message of the last commit', async ({ page }) => {
      await openBlog(page);
      await headRow(page).click();
      const panel = details(page);
      await panel.locator('h2').hover();
      const pencil = panel.getByRole('button', { name: 'Edit commit message' });
      await expect(pencil).toBeVisible();
      await capture(page, theme, 'hover');

      await pencil.click();
      const summary = panel.getByLabel('Commit summary');
      await expect(summary).toBeFocused();
      await expect(summary).not.toHaveValue('');
      await expect(panel).toContainText('The last commit is amended');
      const save = panel.getByRole('button', { name: /^Change message/ });
      // Nothing changed yet.
      await expect(save).toHaveAttribute('aria-disabled', 'true');

      await summary.fill('docs: a better summary');
      await panel.getByLabel('Description (optional)').fill('With a body.');
      await capture(page, theme, 'edit-head');
      await save.click();
      await expect(toastWith(page, 'Message changed')).toBeVisible();
      // The selection follows the rewritten commit.
      await expect(panel.locator('h2')).toHaveText('docs: a better summary');
      await expect(panel).toContainText('With a body.');
      await expect(headRow(page)).toContainText('docs: a better summary');
      await expect(headRow(page)).toHaveAttribute('aria-selected', 'true');
    });

    test('a click on the message edits an older commit; Escape cancels', async ({ page }) => {
      await openBlog(page);
      const row = Number(await headRow(page).getAttribute('data-row')) + 1;
      await page.locator(`[data-row="${String(row)}"]`).click();
      const panel = details(page);
      const title = panel.locator('h2');
      const before = (await title.textContent()) ?? '';

      await title.click();
      const summary = panel.getByLabel('Commit summary');
      await expect(summary).toHaveValue(before);
      await summary.fill('draft that is dropped');
      await page.keyboard.press('Escape');
      await expect(summary).toBeHidden();
      await expect(title).toHaveText(before);
      await expect(panel.getByRole('button', { name: 'Edit commit message' })).toBeFocused();

      await title.click();
      await expect(panel).toContainText('replayed unchanged');
      await summary.fill('fix: reworded inline');
      await capture(page, theme, 'edit-older');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(toastWith(page, 'Message changed')).toBeVisible();
      await expect(title).toHaveText('fix: reworded inline');
      const reworded = page.locator('[data-row]').filter({ hasText: 'fix: reworded inline' });
      await expect(reworded).toHaveCount(1);
      await expect(reworded).toHaveAttribute('aria-selected', 'true');
    });
  });
}
