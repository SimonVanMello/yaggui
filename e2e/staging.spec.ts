import { expect, test, type Page } from '@playwright/test';

/** M2-2: staging, hunk / line actions, discard confirmation, commit box, on the mock backend. */

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

async function openRepo(page: Page, name: RegExp = /^yaggui\b/) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(name);
}

const unstaged = (page: Page) => page.getByRole('listbox', { name: 'Unstaged', exact: true });
const staged = (page: Page) => page.getByRole('listbox', { name: 'Staged', exact: true });
/** Row of a file by its full path (the row's title). */
const file = (list: ReturnType<typeof unstaged>, path: string) =>
  list.getByRole('option').and(list.locator(`[title="${path}"]`));
const summary = (page: Page) => page.getByRole('textbox', { name: 'Commit summary' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('hover buttons, multi-selection, Space and drag between lists', async ({ page }) => {
      await openRepo(page);
      await expect(unstaged(page).getByRole('option')).toHaveCount(4);
      await expect(staged(page).getByRole('option')).toHaveCount(2);

      // Hover button on one row.
      const readme = file(unstaged(page), 'README.md');
      await readme.hover();
      await expect(readme.getByRole('button', { name: 'Stage file' })).toBeVisible();
      await capture(page, theme, 'staging-hover');
      await readme.getByRole('button', { name: 'Stage file' }).click();
      await expect(file(staged(page), 'README.md')).toBeVisible();
      await expect(unstaged(page).getByRole('option')).toHaveCount(3);
      // Staging is visible in the lists: no "completed" toast on every click.
      await expect(page.locator('ol > li')).toHaveCount(0);

      // Multi-selection (Shift) then Space stages both.
      const rows = unstaged(page).getByRole('option');
      await rows.first().click();
      await rows.nth(1).click({ modifiers: ['Shift'] });
      await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
      await unstaged(page).focus();
      await page.keyboard.press('Space');
      await expect(staged(page).getByRole('option')).toHaveCount(5);
      await expect(unstaged(page).getByRole('option')).toHaveCount(1);

      // Drag back from Staged to Unstaged.
      await file(staged(page), 'README.md').dragTo(unstaged(page));
      await expect(file(unstaged(page), 'README.md')).toBeVisible();

      // Stage all / unstage all.
      await page.getByRole('button', { name: 'Stage all', exact: true }).click();
      await expect(unstaged(page).getByRole('option')).toHaveCount(0);
      await page.getByRole('button', { name: 'Unstage all', exact: true }).click();
      await expect(staged(page).getByRole('option')).toHaveCount(0);
    });

    test('line selection in the diff, then stage the lines', async ({ page }) => {
      await openRepo(page);
      await file(unstaged(page), 'src/features/tabs/TabBar.tsx').click();
      const diff = page.getByRole('region', { name: /^Diff of / });
      await expect(diff.locator('.yaggui-hunk')).not.toHaveCount(0);

      // Hunk actions are live buttons.
      const stageHunk = diff.getByRole('button', { name: 'Stage hunk' }).first();
      await expect(stageHunk).not.toHaveAttribute('aria-disabled', 'true');

      await page.getByRole('radio', { name: 'Unified' }).click();

      // Click, then drag through the gutter.
      const gutter = diff.locator('.yaggui-signs .yaggui-selectable');
      await gutter.first().click();
      await expect(diff.getByRole('status')).toHaveText('1 line selected');
      const count = await gutter.count();
      if (count > 1) {
        const first = await gutter.first().boundingBox();
        const last = await gutter.nth(count - 1).boundingBox();
        if (first && last) {
          await page.mouse.move(first.x + 4, first.y + 4);
          await page.mouse.down();
          await page.mouse.move(last.x + 4, last.y + 4, { steps: 4 });
          await page.mouse.up();
        }
      }
      await expect(diff.locator('.yaggui-selected').first()).toBeVisible();
      await capture(page, theme, 'staging-lines-selected');

      await diff.getByRole('button', { name: 'Stage lines' }).click();
      await expect(file(staged(page), 'src/features/tabs/TabBar.tsx')).toBeVisible();
    });

    test('discard confirmation shows its effect', async ({ page }) => {
      await openRepo(page);
      const header = page.getByRole('button', { name: 'Discard all changes' });
      await header.click();
      const dialog = page.getByRole('dialog', { name: 'Discard all unstaged changes?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('list', { name: 'What will happen' })).toContainText(
        'README.md',
      );
      await expect(dialog).toContainText('untracked, deleted');
      await capture(page, theme, 'staging-discard-confirm');

      await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(unstaged(page).getByRole('option')).toHaveCount(0);
    });

    test('a failing hook shows its full output', async ({ page }) => {
      await openRepo(page);
      await summary(page).fill('feat: add things [hook-fail]');
      await summary(page).press('ControlOrMeta+Enter');
      const panel = page.getByRole('alert').filter({ hasText: 'rejected the commit' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Copy output' })).toBeVisible();
      await capture(page, theme, 'staging-hook-failed');
      // Nothing was committed: the message is kept.
      await expect(summary(page)).toHaveValue('feat: add things [hook-fail]');
    });

    test('a missing Git identity opens a small form', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      await page.getByRole('dialog').getByRole('textbox').fill('/work/no-identity');
      await page.getByRole('dialog').getByRole('button', { name: 'Open' }).click();
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/no-identity/);

      await page.getByRole('checkbox', { name: 'Amend previous commit' }).check();
      await expect(summary(page)).not.toHaveValue('');
      await summary(page).press('ControlOrMeta+Enter');
      const form = page.getByRole('form', { name: 'Who are you?' });
      await expect(form).toBeVisible();
      await form.getByRole('textbox', { name: 'Name' }).fill('Ada Lovelace');
      await form.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
      await capture(page, theme, 'staging-identity');
      await form.getByRole('button', { name: 'Save and commit' }).click();
      await expect(form).toBeHidden();
    });
  });
}
