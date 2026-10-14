import { expect, test, type Page } from '@playwright/test';

/**
 * M3-5: a pull that stops on conflicts leads to the same banner and conflict view as a
 * merge; deleting a tag on the remote; an interactive rebase that halts again on `edit`.
 */

const MOCK_NOW_MS = 1_791_795_600_000;
const BLOG_ID = 3;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`m3-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page, name: string) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });
const banner = (page: Page) => page.getByRole('status', { name: 'Operation in progress' });
const tree = (page: Page) => page.getByRole('tree');

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('a pull stopped on conflicts shows the operation banner and the conflict view', async ({
      page,
    }) => {
      await openRepo(page, 'blog');
      // `blog` is behind origin/main: a local commit makes the pull a real merge.
      await page.evaluate((id) => {
        window.__yagguiMock?.simulateCommit(id, 'local work');
        window.__yagguiMock?.simulatePullConflict(id);
      }, BLOG_ID);
      await toolbar(page).getByRole('button', { name: 'Pull strategy' }).click();
      await page.getByRole('menuitem', { name: 'Merge' }).click();

      const toast = page.getByRole('listitem').filter({ hasText: 'The pull stopped on conflicts' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText('4 files in conflict');
      await expect(banner(page)).toContainText('Merge');
      const panel = page.getByRole('region', { name: 'Conflicts' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Take origin/main' }).first()).toBeVisible();
      await expect(page.locator('footer')).not.toContainText('Pull failed');
      await capture(page, theme, 'pull-conflict');

      await panel
        .getByRole('button', { name: /^Resolve/ })
        .first()
        .click();
      await expect(page.getByRole('region', { name: /^Conflict in / })).toBeVisible();
      await capture(page, theme, 'pull-conflict-view');
    });

    test('deletes a tag on the remote after a confirmation that shows the command', async ({
      page,
    }) => {
      await openRepo(page, 'yaggui');
      const tags = tree(page).getByRole('treeitem', { name: /^Tags/ });
      if ((await tags.getAttribute('aria-expanded')) !== 'true') await tags.click();
      const tag = tree(page).getByRole('treeitem', { name: /^v\d/ }).first();
      const name = ((await tag.textContent()) ?? '').trim().split(/\s/)[0] ?? '';
      await tag.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Delete on the remote…' }).click();
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await expect(dialog).toContainText(`git push origin --delete refs/tags/${name}`);
      await capture(page, theme, 'delete-remote-tag');
      await dialog.getByRole('button', { name: 'Delete on the remote' }).click();
      await expect(page.getByText(`Tag ${name} deleted on origin`, { exact: true })).toBeVisible();
    });

    test('continue from the banner says when the rebase halts on the next edit', async ({
      page,
    }) => {
      await openRepo(page, 'blog');
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('interactive rebase');
      await page.keyboard.press('Enter');
      await page
        .getByRole('listbox', { name: 'Latest commits of the branch' })
        .getByRole('option')
        .filter({ hasText: /(?<!\d)4 commits above/ })
        .click();
      const todo = page.getByRole('listbox', { name: /^Commits to rebase/ });
      await expect(todo.getByRole('option')).toHaveCount(4);
      await expect(todo).toBeFocused();
      // Newest first: `edit` on the newest and on the third newest.
      await page.keyboard.press('e');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('e');
      await page
        .getByRole('button', { name: /^Start rebase/ })
        .first()
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Start rebase' }).click();
      const stopped = page.getByRole('region', { name: 'Rebase stopped' });
      await expect(stopped).toContainText(/step 2\/4 on [0-9a-f]{7}/);
      const firstStop = /on ([0-9a-f]{7})/.exec((await stopped.textContent()) ?? '')?.[1] ?? '';

      await banner(page).getByRole('button', { name: 'Continue' }).click();
      // The panel follows the rebase to its next stop: another commit, step 4/4.
      await expect(stopped).toContainText(/step 4\/4 on [0-9a-f]{7}/);
      await expect(stopped).not.toContainText(firstStop);
      await expect(page.getByText('Rebase paused at step 4/4', { exact: true })).toBeVisible();
      await expect(page.getByText('Rebase completed', { exact: true })).toHaveCount(0);
      await expect(banner(page)).toBeVisible();
      await expect(page.locator('footer')).toContainText('Rebase paused');
      await capture(page, theme, 'rebase-edit-again');

      await banner(page).getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('Rebase completed', { exact: true })).toBeVisible();
      await expect(banner(page)).toHaveCount(0);
    });
  });
}
