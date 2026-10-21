import { expect, test, type Page } from '@playwright/test';

/** M7-4: applying one file of a stash from the stash preview (F-185), on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`stash-file-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openYaggui(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

const tree = (page: Page) => page.getByRole('tree');
/** A toast by its text; the live-region announcement of the same toast is left out. */
const toastWith = (page: Page, text: string | RegExp) =>
  page.locator('ol > li').filter({ hasText: text });
const preview = (page: Page) => page.getByRole('region', { name: 'Stash details' });

async function openStash(page: Page, name: RegExp) {
  const section = tree(page).getByRole('treeitem', { name: /^Stashes/ });
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click();
  await tree(page).getByRole('treeitem', { name }).click();
  await expect(preview(page)).toBeVisible();
}

/** Stashes everything (untracked files included) with `message`. */
async function stashAll(page: Page, message: string) {
  await page.keyboard.press('Control+Shift+S');
  const popover = page.getByRole('form', { name: 'Stash changes' });
  await popover.getByLabel('Message (optional)').fill(message);
  await popover.getByLabel('Include untracked files').check();
  await popover.getByRole('button', { name: 'Stash', exact: true }).click();
  await expect(page.getByText('Changes stashed', { exact: true })).toBeVisible();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('a file of the stash is applied from its row, the stash kept', async ({ page }) => {
      await openYaggui(page);
      await stashAll(page, 'one file demo');
      await openStash(page, /one file demo/);

      const untracked = preview(page).getByRole('listbox', { name: 'Untracked files' });
      const row = untracked.getByRole('option').first();
      const path = (await row.getAttribute('title')) ?? '';
      expect(path).not.toBe('');
      await row.hover();
      const apply = row.getByRole('button', { name: 'Apply this file to the working tree' });
      await expect(apply).toBeVisible();
      await capture(page, theme, 'row-action');

      await apply.click();
      const applied = toastWith(page, `${path} applied from the stash`);
      await expect(applied).toBeVisible();
      await expect(applied).toContainText('The stash is kept. Undo puts your previous file back.');
      await capture(page, theme, 'applied');
      // The stash is still listed.
      await expect(tree(page).getByRole('treeitem', { name: /one file demo/ })).toBeVisible();

      // The same action from the right-click menu, refused now that the file is back.
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Apply this file to the working tree' }).click();
      await expect(toastWith(page, /already exists in your working tree/)).toBeVisible();
    });

    test('a conflicting file is explained, with the undo as a way back', async ({ page }) => {
      await openYaggui(page);
      await stashAll(page, 'conflict demo');
      await openStash(page, /conflict demo/);

      const files = preview(page).getByRole('listbox', { name: 'Stashed files' });
      const row = files.getByRole('option').first();
      const path = (await row.getAttribute('title')) ?? '';
      await row.hover();
      await row.getByRole('button', { name: 'Apply this file to the working tree' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('The stash conflicts');
      await expect(dialog).toContainText(`Applying ${path} from the stash left conflicts in it.`);
      await expect(dialog).toContainText('Or undo the operation to get your file back as it was.');
      await capture(page, theme, 'conflict');
      await dialog.getByRole('button', { name: 'Understood' }).click();
      await expect(tree(page).getByRole('treeitem', { name: /conflict demo/ })).toBeVisible();
    });
  });
}
