import { expect, test, type Page } from '@playwright/test';

/** M4-5: submodules, worktrees and Git LFS (F-260 to F-262) on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;
const YAGGUI = '/Users/alex/dev/yaggui';

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`modules-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

async function openYaggui(page: Page) {
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

const tree = (page: Page) => page.getByRole('tree');
const dialog = (page: Page) => page.getByRole('dialog');
const toasts = (page: Page) => page.getByRole('region', { name: /notifications/i });

/** Expands a collapsed sidebar section (submodules and worktrees start collapsed). */
async function expand(page: Page, section: 'Submodules' | 'Worktrees') {
  const header = tree(page).getByRole('treeitem', { name: new RegExp(`^${section},`) });
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

async function rowMenu(page: Page, name: RegExp) {
  await tree(page).getByRole('treeitem', { name }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
}

test.use({ locale: 'en-US' });

test('updating a moved submodule checks out the recorded commit', async ({ page }) => {
  await start(page);
  await openYaggui(page);
  await expand(page, 'Submodules');
  const row = tree(page).getByRole('treeitem', { name: /vendor\/codemirror/ });
  await expect(row).toContainText('moved');
  await expect(row).toContainText('modified');
  await rowMenu(page, /vendor\/codemirror/);
  await page.getByRole('menuitem', { name: 'Update', exact: true }).click();
  await expect(toasts(page)).toContainText('Submodules updated');
  await expect(row).not.toContainText('moved');
  // Still modified: an update does not touch local changes.
  await expect(row).toContainText('modified');
});

test('an uninitialized submodule is initialized, then opens in its own tab', async ({ page }) => {
  await start(page);
  await openYaggui(page);
  await expand(page, 'Submodules');
  const row = tree(page).getByRole('treeitem', { name: /docs\/theme/ });
  await expect(row).toContainText('not initialized');
  await rowMenu(page, /docs\/theme/);
  await expect(page.getByRole('menuitem', { name: 'Open in a new tab' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Initialize', exact: true }).click();
  await expect(row).not.toContainText('not initialized');
  await rowMenu(page, /docs\/theme/);
  await page.getByRole('menuitem', { name: 'Open in a new tab' }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^theme/);
});

test('a branch checked out in another worktree is marked and not checked out', async ({ page }) => {
  await start(page);
  await openYaggui(page);
  const branch = tree(page).getByRole('treeitem', { name: /^search-43/ });
  await expect(branch.locator('[data-worktree]')).toHaveAttribute(
    'data-worktree',
    `${YAGGUI}-review`,
  );
  await branch.dblclick();
  await expect(toasts(page)).toContainText(`Checked out in the worktree ${YAGGUI}-review`);
  await rowMenu(page, /^search-43/);
  await expect(page.getByRole('menuitem', { name: /^Check out/ }).first()).toBeDisabled();
});

test('a new worktree on a new branch opens in a tab', async ({ page }) => {
  await start(page);
  await openYaggui(page);
  await expand(page, 'Worktrees');
  await rowMenu(page, /^yaggui-review/);
  await page.getByRole('menuitem', { name: 'New worktree…' }).click();
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('hotfix/login');
  await expect(page.getByRole('textbox', { name: 'Folder' })).toHaveValue(`${YAGGUI}-hotfix-login`);
  await page.getByRole('button', { name: 'Create the worktree' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    /^yaggui-hotfix-login/,
  );
});

test('a dirty worktree is removed only when forced, then missing ones are pruned', async ({
  page,
}) => {
  await start(page);
  await openYaggui(page);
  await expand(page, 'Worktrees');
  await rowMenu(page, /^yaggui-review/);
  await page.getByRole('menuitem', { name: 'Remove the worktree…' }).click();
  await expect(dialog(page)).toContainText('This worktree has local changes');
  await expect(dialog(page)).toContainText('The branch fix/search-43 stays in the repository');
  const confirm = page.getByRole('button', { name: 'Remove the worktree' });
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('checkbox', { name: /Remove anyway/ }).check();
  await confirm.click();
  await expect(dialog(page)).toBeHidden();
  await expect(tree(page).getByRole('treeitem', { name: /^yaggui-review/ })).toHaveCount(0);

  const spike = tree(page).getByRole('treeitem', { name: /^yaggui-spike/ });
  await expect(spike).toContainText('missing');
  await rowMenu(page, /^yaggui-spike/);
  await page.getByRole('menuitem', { name: 'Prune missing worktrees' }).click();
  await expect(spike).toHaveCount(0);
});

test('LFS: a pattern is tracked from the palette', async ({ page }) => {
  await start(page);
  await openYaggui(page);
  await page.keyboard.press('ControlOrMeta+K');
  await page.keyboard.type('track a pattern');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toContainText('*.psd');
  await page.getByRole('textbox', { name: 'Pattern' }).fill('*.zip');
  await page.getByRole('button', { name: 'Track', exact: true }).click();
  await expect(toasts(page)).toContainText('*.zip is now stored with LFS');
});

test('LFS: a missing git lfs is explained once, without blocking', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    if (window.__yagguiMock) window.__yagguiMock.modules.lfsInstalled = false;
  });
  await openYaggui(page);
  await expect(toasts(page)).toContainText('Git LFS is not installed');
  await expect(tree(page)).toBeVisible();
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await start(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });

    test('sidebar sections and menus', async ({ page }) => {
      await openYaggui(page);
      await expand(page, 'Submodules');
      await expand(page, 'Worktrees');
      await expect(tree(page).getByRole('treeitem', { name: /^yaggui-spike/ })).toBeVisible();
      await capture(page, theme, 'sidebar');
      await rowMenu(page, /vendor\/codemirror/);
      await capture(page, theme, 'submodule-menu');
    });

    test('create worktree dialog', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('new worktree');
      await page.keyboard.press('Enter');
      await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feat/blame');
      await expect(page.getByRole('textbox', { name: 'Folder' })).toHaveValue(
        `${YAGGUI}-feat-blame`,
      );
      await capture(page, theme, 'create-worktree');
    });

    test('remove worktree dialog', async ({ page }) => {
      await openYaggui(page);
      await expand(page, 'Worktrees');
      await rowMenu(page, /^yaggui-review/);
      await page.getByRole('menuitem', { name: 'Remove the worktree…' }).click();
      await expect(dialog(page)).toContainText('This worktree has local changes');
      await capture(page, theme, 'remove-worktree');
    });

    test('LFS track dialog', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('track a pattern');
      await page.keyboard.press('Enter');
      await page.getByRole('textbox', { name: 'Pattern' }).fill('*.zip');
      await capture(page, theme, 'lfs-track');
    });

    test('LFS file in a commit: chip and pointer view', async ({ page }) => {
      // A hash change alone does not reload the app.
      await page.goto('/#diff-demo');
      await page.reload();
      const files = page.getByRole('listbox', { name: /^Commit / });
      const hero = files.getByRole('option', { name: /hero\.psd/ });
      await expect(hero).toContainText('LFS');
      await hero.click();
      const diff = page.getByRole('region', { name: /^Diff of / });
      await expect(diff).toContainText('File stored with Git LFS');
      await expect(diff).toContainText('Only a pointer is versioned');
      await capture(page, theme, 'lfs-diff');
    });

    test('submodule pointer change in the diff', async ({ page }) => {
      // A hash change alone does not reload the app.
      await page.goto('/#diff-demo');
      await page.reload();
      await page
        .getByRole('listbox', { name: /^Commit / })
        .getByRole('option', { name: /codemirror/ })
        .click();
      const diff = page.getByRole('region', { name: /^Diff of / });
      await expect(diff).toContainText('Submodule commit changed');
      await capture(page, theme, 'submodule-diff');
    });
  });
}
