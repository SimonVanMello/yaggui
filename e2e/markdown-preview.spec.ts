import { expect, test, type Page } from '@playwright/test';

/** Rendered Markdown diff (F-089), on the mock's showcase commit. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

const fileList = (page: Page) => page.getByRole('listbox', { name: /^Commit / });
const diffView = (page: Page) => page.getByRole('region', { name: /^Diff of / });
const documentView = (page: Page) =>
  page.getByRole('article', { name: 'Rendered document with its changes' });

async function selectFile(page: Page, name: string) {
  await fileList(page)
    .getByRole('option', { name: new RegExp(name) })
    .click();
  await expect(diffView(page)).toHaveAccessibleName(new RegExp(`${name}$`));
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('a Markdown file shows rendered, with its changes', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/#diff-demo');
      await expect(diffView(page)).toBeVisible();

      // Only Markdown files offer the preview.
      await selectFile(page, 'layout.ts');
      await expect(page.getByRole('radio', { name: 'Preview' })).toHaveCount(0);

      await selectFile(page, 'guide.md');
      await page.getByRole('radio', { name: 'Preview' }).click();
      await expect(page.getByRole('radio', { name: 'Preview' })).toBeChecked();

      const doc = documentView(page);
      await expect(doc.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
      await expect(doc.locator('ins').filter({ hasText: 'Windows,' })).toBeVisible();
      await expect(
        doc.locator('[data-status="removed"]').filter({ hasText: 'experimental' }),
      ).toBeVisible();
      await expect(doc.locator('table')).toBeVisible();
      await expect(page.getByText('Change 1 / ', { exact: false })).toHaveCount(0);
      await capture(page, `markdown-preview-${theme}.png`);

      // n / p walk through the changes.
      await page.keyboard.press('n');
      await expect(page.getByText(/^Change 1 \/ \d+$/)).toBeVisible();
      await page.keyboard.press('n');
      await expect(page.getByText(/^Change 2 \/ \d+$/)).toBeVisible();
      await expect(doc.locator('[data-active]').first()).toBeInViewport();

      // The new version alone.
      await page.getByRole('checkbox', { name: 'Show removed text' }).uncheck();
      await expect(doc.locator('[data-status="removed"]').first()).toBeHidden();
      await expect(doc.locator('del').first()).toBeHidden();
      // The checkbox keeps the focus: n / p still step through the changes.
      await page.keyboard.press('n');
      await expect(page.getByText(/^Change 3 \/ \d+$/)).toBeVisible();
      await capture(page, `markdown-preview-clean-${theme}.png`);
      await page.getByRole('checkbox', { name: 'Show removed text' }).check();

      // The choice is kept for the next Markdown file; ⌘D goes back to the source.
      await selectFile(page, 'diff.md');
      await expect(doc.locator('[data-status="added"]').first()).toBeVisible();
      await page.keyboard.press('ControlOrMeta+D');
      await expect(page.getByRole('radio', { name: 'Preview' })).not.toBeChecked();
      await expect(documentView(page)).toHaveCount(0);
    });
  });
}
