import { expect, test, type Page } from '@playwright/test';

/** Ref label menu in the graph and commit message edit, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`graph-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

/** `yaggui` has tags; `blog` a clean working copy, which a rebase needs. */
async function openRepo(page: Page, name: 'yaggui' | 'blog') {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
  await expect(graphRow(page, 0)).toBeVisible();
}

/** Brings the first tag of the sidebar into the graph and returns its label there. */
async function tagPill(page: Page) {
  const tree = page.getByRole('tree');
  const tags = tree.getByRole('treeitem', { name: /^Tags/ });
  if ((await tags.getAttribute('aria-expanded')) !== 'true') await tags.click();
  const first = tree.getByRole('treeitem', { name: /^v\d/ }).first();
  const name = ((await first.textContent()) ?? '').match(/v[\d.]+/)?.[0] ?? '';
  await first.click();
  const pill = page.locator(`[data-row] [data-ref-kind="tag"][data-ref-name="${name}"]`);
  await expect(pill).toBeVisible();
  return { pill, name };
}

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const dialog = (page: Page) => page.getByRole('dialog');
/** Row of the checked-out `main`. */
const headRow = (page: Page) =>
  page
    .locator('[data-row]')
    .filter({ has: page.locator('[data-ref-kind="local"][data-ref-name="main"]') })
    .first();
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('a tag label of the graph has the tag menu, with its push', async ({ page }) => {
      await openRepo(page, 'yaggui');
      const { pill, name: tag } = await tagPill(page);
      await pill.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'Delete the tag…' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: /Cherry-pick onto/ })).toHaveCount(0);
      await capture(page, theme, 'tag-menu');
      const push = menu.getByRole('menuitem', { name: /^Push the tag/ });
      await push.click();
      // Several remotes: the push asks which one.
      const origin = page.getByRole('menuitem', { name: 'origin', exact: true });
      if (await origin.isVisible()) await origin.click();
      await expect(toastWith(page, `Tag ${tag}`)).toBeVisible();
    });

    test('a branch label has the branch menu, the row elsewhere the commit menu', async ({
      page,
    }) => {
      await openRepo(page, 'yaggui');
      await page.locator('[data-row] [data-ref-kind="local"]').first().click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: /^Rename/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await graphRow(page, 1).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Edit commit message…' })).toBeVisible();
    });

    test('double-click on a remote label brings the local branch behind it up to it', async ({
      page,
    }) => {
      await openRepo(page, 'blog');
      // `main` is 4 commits behind `origin/main`.
      const remote = page.locator(
        '[data-row] [data-ref-kind="remote"][data-ref-name="origin/main"]',
      );
      await remote.dblclick();
      await expect(toastWith(page, 'Updated to origin/main')).toBeVisible();
      // Local and remote are on the same commit again: one merged label.
      await expect(remote).toHaveCount(0);
      await expect(headRow(page)).toContainText('chore(deps): bump dependency 4');
      await capture(page, theme, 'remote-fast-forward');
    });

    test('edits the message of the last commit', async ({ page }) => {
      await openRepo(page, 'blog');
      await headRow(page).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit commit message…' }).click();
      const edit = dialog(page);
      await expect(edit).toContainText('The last commit is amended');
      const field = edit.getByLabel('Message');
      await expect(field).not.toHaveValue('');
      await field.fill('docs: a better summary\n\nWith a body.');
      await capture(page, theme, 'reword-head');
      await edit.getByRole('button', { name: 'Change message' }).click();
      await expect(toastWith(page, 'Message changed')).toBeVisible();
      await expect(headRow(page)).toContainText('docs: a better summary');
    });

    test('edits the message of an older commit', async ({ page }) => {
      await openRepo(page, 'blog');
      // The history of `main` is linear: the row under it is its parent.
      const row = Number(await headRow(page).getAttribute('data-row')) + 1;
      await graphRow(page, row).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit commit message…' }).click();
      const edit = dialog(page);
      await expect(edit).toContainText('replayed unchanged');
      await edit.getByLabel('Message').fill('fix: reworded');
      await capture(page, theme, 'reword-older');
      await edit.getByRole('button', { name: 'Change message' }).click();
      await expect(toastWith(page, 'Message changed')).toBeVisible();
      await expect(page.locator('[data-row]').filter({ hasText: 'fix: reworded' })).toHaveCount(1);
    });
  });
}
