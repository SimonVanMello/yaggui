import { expect, test, type Page } from '@playwright/test';

/** M4-7c: remotes management, tag transfers and tag checkout, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`remotes-${state}-${theme}.png`),
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
const dialog = (page: Page) => page.getByRole('dialog');
const toastText = (page: Page, text: string) => page.getByText(text, { exact: true });
const remoteSection = (page: Page) => tree(page).getByRole('treeitem', { name: /^Remote/ });
const remoteFolder = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .first();

async function expandTags(page: Page) {
  const tags = tree(page).getByRole('treeitem', { name: /^Tags/ });
  if ((await tags.getAttribute('aria-expanded')) !== 'true') await tags.click();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('adds a remote with its own push URL from the Remote section', async ({ page }) => {
      await openYaggui(page);
      await remoteSection(page).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Add a remote…' }).click();
      await expect(dialog(page)).toContainText('Add a remote');
      const name = dialog(page).getByLabel('Name');
      await name.fill('origin');
      await expect(dialog(page).getByRole('status').first()).toContainText('already exists');
      await name.fill('bad name');
      await expect(dialog(page).getByRole('status').first()).toContainText(
        'not a valid remote name',
      );
      await name.fill('fork');
      await expect(dialog(page).getByRole('status').first()).toContainText('available');
      await dialog(page).getByLabel('Fetch URL').fill('git@github.com:me/yaggui.git');
      await dialog(page).getByLabel('Push to a different URL').check();
      await dialog(page).getByLabel('Push URL').fill('git@github.com:me/yaggui-push.git');
      await dialog(page).getByLabel('Fetch it once added').uncheck();
      await capture(page, theme, 'add');
      await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
      await expect(toastText(page, 'Remote fork added')).toBeVisible();
      await expect(remoteFolder(page, 'fork')).toBeVisible();
      // The Fetch menu of the toolbar follows the remotes (M9-6).
      await page.getByRole('button', { name: 'Fetch options' }).click();
      await expect(page.getByRole('menuitem', { name: 'Fetch fork' })).toBeVisible();
      await page.keyboard.press('Escape');
    });

    test('edits, renames and removes a remote from its folder', async ({ page }) => {
      await openYaggui(page);
      await remoteFolder(page, 'origin').click({ button: 'right' });
      await capture(page, theme, 'folder-menu');
      await page.getByRole('menuitem', { name: 'Edit the remote…' }).click();
      await expect(dialog(page)).toContainText('Edit the remote origin');
      await expect(dialog(page).getByLabel('Fetch URL')).toHaveValue(/yaggui\.git$/);
      await dialog(page).getByLabel('Name').fill('upstream');
      await capture(page, theme, 'edit');
      await dialog(page).getByRole('button', { name: 'Save' }).click();
      await expect(toastText(page, 'Remote origin renamed to upstream')).toBeVisible();

      await remoteFolder(page, 'upstream').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Remove the remote…' }).click();
      const confirm = page.getByRole('alertdialog').or(dialog(page));
      await expect(confirm).toContainText('Remove the remote upstream?');
      await expect(confirm).toContainText('upstream/main');
      await expect(confirm).toContainText('loses its upstream');
      await expect(confirm).toContainText('git remote remove -- upstream');
      await capture(page, theme, 'remove');
      await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(toastText(page, 'Remote upstream removed')).toBeVisible();
      await expect(remoteFolder(page, 'upstream')).toHaveCount(0);
      await page.getByRole('button', { name: 'Fetch options' }).click();
      await expect(page.getByRole('menuitem', { name: 'Fetch all remotes' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Fetch (origin|upstream)$/ })).toHaveCount(
        0,
      );
      await page.keyboard.press('Escape');
    });

    test('manages remotes from the palette', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('Manage remotes');
      await page.keyboard.press('Enter');
      await expect(dialog(page)).toContainText('Where this repository fetches from');
      const list = dialog(page).getByRole('list', { name: 'Remotes' });
      await expect(list).toContainText('origin');
      await capture(page, theme, 'manage');
      await dialog(page).getByRole('button', { name: 'Add a remote…' }).click();
      await dialog(page).getByLabel('Name').fill('mirror');
      await dialog(page).getByLabel('Fetch URL').fill('/srv/git/yaggui.git');
      await dialog(page).getByLabel('Fetch it once added').uncheck();
      await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
      // Back to the list, with the new remote.
      await expect(dialog(page).getByRole('list', { name: 'Remotes' })).toContainText('mirror');
    });

    test('pushes all tags, then each tag offers every remote', async ({ page }) => {
      await openYaggui(page);
      await expandTags(page);
      await tree(page).getByRole('treeitem', { name: /^Tags/ }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Push all tags' }).click();
      await expect(page.getByText(/^\d+ tags? pushed to origin$/)).toBeVisible();

      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('Add a remote');
      await page.keyboard.press('Enter');
      await dialog(page).getByLabel('Name').fill('fork');
      await dialog(page).getByLabel('Fetch URL').fill('git@github.com:me/yaggui.git');
      await dialog(page).getByLabel('Fetch it once added').uncheck();
      await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
      await expect(toastText(page, 'Remote fork added')).toBeVisible();

      const tag = tree(page).getByRole('treeitem', { name: /^v\d/ }).first();
      const name = ((await tag.textContent()) ?? '').trim().split(/\s/)[0] ?? '';
      await tag.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Push the tag to' }).click();
      await expect(page.getByRole('menuitem', { name: 'fork' })).toBeVisible();
      await capture(page, theme, 'tag-push-to');
      await page.getByRole('menuitem', { name: 'fork' }).click();
      await expect(toastText(page, `Tag ${name} pushed to fork`)).toBeVisible();
    });

    test('checking out a tag explains the detached HEAD and offers a branch', async ({ page }) => {
      await openYaggui(page);
      await expandTags(page);
      const tag = tree(page).getByRole('treeitem', { name: /^v\d/ }).first();
      const name = ((await tag.textContent()) ?? '').trim().split(/\s/)[0] ?? '';
      await tag.dblclick();
      await expect(dialog(page)).toContainText(`Check out the tag ${name}`);
      await expect(dialog(page)).toContainText('detaches HEAD');
      await expect(dialog(page).getByLabel('Branch name')).toHaveValue(`${name}-branch`);
      await expect(dialog(page).getByRole('status').first()).toContainText('available');
      await capture(page, theme, 'tag-checkout');
      await dialog(page).getByRole('button', { name: 'Create and check out' }).click();
      await expect(toastText(page, `Branch ${name}-branch created`)).toBeVisible();
      // yaggui has local changes: the usual dirty checkout dialog takes over.
      await expect(dialog(page)).toContainText(`Local changes in the way of ${name}-branch`);
    });

    test('continuing in detached HEAD keeps the plain checkout', async ({ page }) => {
      await openYaggui(page);
      await expandTags(page);
      await tree(page).getByRole('treeitem', { name: /^v\d/ }).first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Check out the tag…' }).click();
      await dialog(page).getByRole('button', { name: 'Continue in detached HEAD' }).click();
      await expect(dialog(page)).toContainText('Local changes in the way of');
    });
  });
}
