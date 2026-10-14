import { expect, test, type Page } from '@playwright/test';

/** M2-4: checkout, branch / stash / tag dialogs and stash popover, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`refs-${state}-${theme}.png`),
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

/** A branch row of the sidebar, by name. */
const branchRow = (page: Page, name: RegExp | string) => tree(page).getByRole('treeitem', { name });

async function expandSection(page: Page, name: string) {
  const section = tree(page).getByRole('treeitem', { name: new RegExp(`^${name}`) });
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('double-click with local changes asks what to do, and stash-checkout-pop works', async ({
      page,
    }) => {
      await openYaggui(page);
      await branchRow(page, /^stale-review/).dblclick();
      await expect(dialog(page)).toContainText('Local changes in the way of fix/stale-review');
      await expect(dialog(page).getByRole('list', { name: 'Changed files' })).toBeVisible();
      await expect(
        dialog(page).getByRole('button', { name: /Bring the changes along/ }),
      ).toBeEnabled();
      // A refusal explained by a dialog is not a failure for the status bar.
      await expect(page.getByText('Checkout failed')).toHaveCount(0);
      await capture(page, theme, 'dirty-checkout');
      await dialog(page)
        .getByRole('button', { name: /Stash, check out, then pop/ })
        .click();
      await expect(page.getByText('Switched to fix/stale-review', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: /Current branch: fix\/stale-review/ }),
      ).toBeVisible();
    });

    test('carrying is refused with its reason when changes touch the target', async ({ page }) => {
      await openYaggui(page);
      // A branch named `conflict…` simulates a target that differs on the changed files.
      await page.getByRole('button', { name: 'Branch', exact: true }).click();
      await dialog(page).getByLabel('Branch name').fill('conflict-zone');
      await dialog(page).getByLabel('Check it out after creating it').uncheck();
      await dialog(page).getByRole('button', { name: 'Create branch' }).click();
      await expect(page.getByText('Branch conflict-zone created', { exact: true })).toBeVisible();
      await branchRow(page, /conflict-zone/).dblclick();
      await expect(dialog(page)).toContainText('Unavailable');
      await expect(
        dialog(page).getByRole('button', { name: /Bring the changes along/ }),
      ).toHaveAttribute('aria-disabled', 'true');
      await capture(page, theme, 'dirty-checkout-no-carry');
    });

    test('branch dialog validates the name as it is typed', async ({ page }) => {
      await openYaggui(page);
      await page.getByRole('button', { name: 'Branch', exact: true }).click();
      const name = dialog(page).getByLabel('Branch name');
      await name.fill('bad name');
      await expect(dialog(page).getByRole('status')).toContainText('not a valid branch name');
      await expect(
        dialog(page).getByRole('button', { name: 'Create and check out' }),
      ).toHaveAttribute('aria-disabled', 'true');
      await capture(page, theme, 'create-branch-invalid');
      await name.fill('main');
      await expect(dialog(page).getByRole('status')).toContainText('already exists');
      await name.fill('feat/refs-ui');
      await expect(dialog(page).getByRole('status')).toContainText('available');
      await dialog(page).getByRole('button', { name: 'Create and check out' }).click();
      await expect(
        page.getByText('Branch feat/refs-ui created and checked out', { exact: true }),
      ).toBeVisible();
    });

    test('deleting an unmerged branch warns and offers to force', async ({ page }) => {
      await openYaggui(page);
      await branchRow(page, /^watcher-39/).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete .*watcher-39/ }).click();
      await expect(dialog(page)).toContainText('watcher-39?');
      await dialog(page).getByRole('button', { name: 'Delete the branch' }).click();
      await expect(dialog(page)).toContainText('is not merged');
      await capture(page, theme, 'delete-unmerged');
      await dialog(page).getByRole('button', { name: 'Delete anyway' }).click();
      await expect(
        page.getByText('Branch refactor/watcher-39 deleted', { exact: true }),
      ).toBeVisible();
    });

    test('stash popover, ⌘⇧S shortcut, and a conflicting stash is explained', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('Control+Shift+S');
      const popover = page.getByRole('form', { name: 'Stash changes' });
      await expect(popover).toBeVisible();
      await popover.getByLabel('Message (optional)').fill('conflict demo');
      await popover.getByLabel('Include untracked files').check();
      await capture(page, theme, 'stash-popover');
      await popover.getByRole('button', { name: 'Stash', exact: true }).click();
      await expect(page.getByText('Changes stashed', { exact: true })).toBeVisible();

      await expandSection(page, 'Stashes');
      const stash = tree(page).getByRole('treeitem', { name: /conflict demo/ });
      await stash.click();
      // Selecting a stash shows its files in the details panel (F-183).
      await expect(page.getByRole('region', { name: 'Stash details' })).toBeVisible();
      await stash.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Apply', exact: true }).click();
      await expect(dialog(page)).toContainText('The stash conflicts');
      await expect(dialog(page)).toContainText('the stash is kept'.replace('the', 'The'));
      await capture(page, theme, 'stash-conflict');
      await dialog(page).getByRole('button', { name: 'Understood' }).click();
      await expect(tree(page).getByRole('treeitem', { name: /conflict demo/ })).toBeVisible();
    });

    test('tag dialog and local tag deletion', async ({ page }) => {
      await openYaggui(page);
      await branchRow(page, /^palette-42/).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Create a tag here/ }).click();
      await dialog(page).getByLabel('Tag name').fill('v9.9.9');
      await dialog(page).getByLabel('Message (optional)').fill('Release 9.9.9');
      await dialog(page).getByRole('button', { name: 'Create tag' }).click();
      await expect(page.getByText('Tag v9.9.9 created', { exact: true })).toBeVisible();
      await expandSection(page, 'Tags');
      await tree(page)
        .getByRole('treeitem', { name: /v9\.9\.9/ })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete the tag/ }).click();
      await dialog(page).getByRole('button', { name: 'Delete the tag' }).click();
      await expect(page.getByText('Tag v9.9.9 deleted', { exact: true })).toBeVisible();
    });

    test('toolbar Tag button tags HEAD, right after the Branch button', async ({ page }) => {
      await openYaggui(page);
      const toolbar = page.getByRole('toolbar', { name: 'Repository actions' });
      const names = await toolbar
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      expect(names[names.indexOf('Branch') + 1]).toBe('Tag');
      await expect(
        page.getByRole('button', { name: /Current branch: feat\/graph-lanes/ }),
      ).toBeVisible();
      await toolbar.getByRole('button', { name: 'Tag', exact: true }).click();
      await expect(dialog(page)).toContainText('Create a tag');
      await expect(dialog(page)).toContainText('On commit feat/graph-lanes');
      await dialog(page).getByLabel('Tag name').fill('v9.9.8');
      await capture(page, theme, 'create-tag-head');
      await dialog(page).getByRole('button', { name: 'Create tag' }).click();
      await expect(page.getByText('Tag v9.9.8 created', { exact: true })).toBeVisible();
      await expandSection(page, 'Tags');
      await expect(tree(page).getByRole('treeitem', { name: /v9\.9\.8/ })).toBeVisible();
    });

    test('toolbar Tag button is disabled without a commit', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      const open = page.getByRole('dialog', { name: 'Open a repository' });
      await open.getByRole('textbox').fill('/Users/alex/dev/unborn-project');
      await open.getByRole('button', { name: /^Open/ }).last().click();
      const tag = page
        .getByRole('toolbar', { name: 'Repository actions' })
        .getByRole('button', { name: 'Tag', exact: true });
      await expect(tag).toHaveAttribute('aria-disabled', 'true');
      // Still focusable and hoverable: the tooltip says why.
      await tag.hover();
      await expect(page.getByRole('tooltip')).toContainText('the repository has no commit');
      await tag.click({ force: true });
      await expect(dialog(page)).toHaveCount(0);
    });
  });
}
