import { expect, test, type Page } from '@playwright/test';

/** Editing an unstaged file from its diff, on the mock backend. */

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

const unstaged = (page: Page) => page.getByRole('listbox', { name: 'Unstaged', exact: true });
const file = (page: Page, path: string) =>
  unstaged(page)
    .getByRole('option')
    .and(unstaged(page).locator(`[title="${path}"]`));
const diff = (page: Page) => page.getByRole('region', { name: /^Diff of / });
const editor = (page: Page, path: string) => page.getByRole('textbox', { name: `Edit ${path}` });
const status = (page: Page) =>
  page.getByRole('toolbar', { name: 'File editor' }).getByRole('status');

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('edit an unstaged file from its diff and save it', async ({ page }) => {
      await openRepo(page);
      await file(page, 'README.md').click();
      await diff(page).getByRole('button', { name: 'Edit', exact: true }).click();
      const code = editor(page, 'README.md');
      await expect(code).toBeFocused();
      await expect(code).toContainText('A fast, cross-platform Git client.');
      // The line changed since the index version is marked.
      await expect(code.locator('.yaggui-edit-add')).toHaveCount(1);

      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('Now editable.\n');
      await expect(status(page)).toHaveText('Unsaved changes');
      await expect(code.locator('.yaggui-edit-add')).toHaveCount(2);
      await capture(page, theme, 'diff-edit');

      await page.keyboard.press('ControlOrMeta+S');
      await expect(status(page)).toHaveText('Saved');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(code).toHaveCount(0);
      await expect(diff(page)).toContainText('Now editable.');
    });

    test('a file changed on disk while edited, and edits kept across files', async ({ page }) => {
      await openRepo(page);
      await file(page, 'README.md').click();
      await diff(page).getByRole('button', { name: 'Edit', exact: true }).click();
      const code = editor(page, 'README.md');
      await expect(code).toBeFocused();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('Mine.');

      // Another program writes the file: the edits are not silently dropped or saved over it.
      await page.evaluate(() =>
        window.__yagguiMock?.simulateEdit(1, 'README.md', '# yaggui\n\nTheirs.\n'),
      );
      const alert = page.getByRole('alert').filter({ hasText: 'changed on disk' });
      await expect(alert).toBeVisible();
      await expect(page.getByRole('button', { name: /^Save/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await capture(page, theme, 'diff-edit-changed');
      await alert.getByRole('button', { name: 'Keep my version' }).click();
      await expect(alert).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+S');
      await expect(status(page)).toHaveText('Saved');
      await expect(code).toContainText('Mine.');
      await expect(code).not.toContainText('Theirs.');

      // Unsaved edits wait while another file is open.
      await code.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(' Draft.');
      await file(page, 'src/ui/Icon.tsx').click();
      await expect(diff(page)).toContainText("split: 'M12 3v18'");
      await file(page, 'README.md').click();
      await expect(editor(page, 'README.md')).toContainText('Mine. Draft.');
      await expect(status(page)).toHaveText('Unsaved changes');

      // Done asks before dropping them.
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Discard your changes?' });
      await dialog.getByRole('button', { name: 'Discard' }).click();
      await expect(editor(page, 'README.md')).toHaveCount(0);
      await expect(diff(page)).not.toContainText('Draft.');
    });

    test('a staged diff has no editor', async ({ page }) => {
      await openRepo(page);
      await file(page, 'README.md').click();
      await expect(diff(page).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
      await page
        .getByRole('listbox', { name: 'Staged', exact: true })
        .getByRole('option')
        .first()
        .click();
      await expect(diff(page)).toBeVisible();
      await expect(diff(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    });
  });
}
