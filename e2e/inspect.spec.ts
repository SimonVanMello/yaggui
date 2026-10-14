import { expect, test, type Page } from '@playwright/test';

/** M4-4: file history, blame and reflog on the mock backend. Captures go to test-results/. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`inspect-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const details = (page: Page) => page.getByRole('region', { name: 'Commit details' });

async function openYaggui(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(graphRow(page, 0)).toBeVisible();
}

/** Right-clicks a file of the selected commit and picks `action` in its menu. */
async function commitFileAction(page: Page, path: RegExp, action: RegExp) {
  await graphRow(page, 2).click();
  await details(page).getByRole('option', { name: path }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action }).click();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('file history across a rename, with the diff of each commit', async ({ page }) => {
      await openYaggui(page);
      await commitFileAction(page, /\bGraphCanvas\.tsx\b/, /^File history$/);
      const view = page.getByRole('region', { name: /^History of src\/features\/graph/ });
      await expect(view).toBeVisible();
      const commits = view.getByRole('listbox', { name: 'Commits that changed the file' });
      await expect(commits.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
      // The selected commit's change to the file, in the diff view.
      await expect(view.getByRole('region', { name: /^Diff of/ })).toBeVisible();
      await expect(view.locator('.cm-editor').first()).toBeVisible();
      // `j` steps to the older commit.
      await page.keyboard.press('j');
      await expect(commits.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
      // The oldest commits were made under the former name: their diff is of that path.
      await commits.focus();
      await page.keyboard.press('End');
      await expect(
        view.getByRole('region', { name: /^Diff of legacy\/GraphCanvas\.tsx/ }),
      ).toBeVisible();
      await capture(page, theme, 'history');
      await page.keyboard.press('Escape');
      await expect(view).toHaveCount(0);
      await expect(graphRow(page, 0)).toBeVisible();
    });

    test('blame: age shades, click selects the commit, blame of the parent', async ({ page }) => {
      await openYaggui(page);
      await commitFileAction(page, / layout\.ts /, /^Blame at this commit$/);
      // Blame of the parent may follow the file to its former name.
      const view = page.getByRole('region', { name: /^Blame of / });
      const lines = view.getByRole('grid');
      await expect(lines.getByRole('row').first()).toBeVisible();
      const firstSha = await view.locator('header [title]').last().getAttribute('title');
      await lines.getByRole('row').nth(4).click();
      const bar = view.getByLabel('Selected commit');
      await expect(bar).toBeVisible();
      // The details panel follows: the commit is selected in the graph.
      await expect(details(page)).toBeVisible();
      await capture(page, theme, 'blame');

      await bar.getByRole('button', { name: 'Blame of the parent' }).click();
      await expect(view.getByRole('button', { name: /^Back to / })).toBeVisible();
      await expect(view.locator('header [title]').last()).not.toHaveAttribute(
        'title',
        firstSha ?? '',
      );
      await view.getByRole('button', { name: /^Back to / }).click();
      await expect(view.getByRole('button', { name: /^Back to / })).toHaveCount(0);

      // "Show in graph" goes back to the graph on the commit.
      await lines.getByRole('row').nth(4).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Show in graph' }).click();
      await expect(view).toHaveCount(0);
      await expect(page.locator('[data-row][aria-selected="true"]')).toBeVisible();
    });

    test('blame of binaries and of files not committed yet', async ({ page }) => {
      await openYaggui(page);
      // The working tree: an untracked file has no history.
      const changes = page.getByRole('listbox', { name: 'Unstaged', exact: true });
      await changes
        .getByRole('option', { name: /notes\/todo\.md|todo\.md/ })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Blame$/ }).click();
      await expect(page.getByText(/not committed yet: no line has a history/)).toBeVisible();
      await capture(page, theme, 'blame-not-committed');
      await page.keyboard.press('Escape');

      await commitFileAction(page, /screenshot\.png/, /^Blame at this commit$/);
      await expect(page.getByText(/^Binary file \(.*\): no lines to attribute\.$/)).toBeVisible();
      await capture(page, theme, 'blame-binary');
    });

    test('blame of a 20 000-line file stays scrollable', async ({ page }) => {
      await openYaggui(page);
      await commitFileAction(page, /huge-snapshot\.json/, /^Blame at this commit$/);
      const lines = page.getByRole('grid', { name: /^Lines of fixtures\/huge-snapshot\.json/ });
      await expect(lines).toHaveAttribute('aria-rowcount', '20000');
      // Virtualized: a screenful of rows, not 20 000.
      expect(await lines.getByRole('row').count()).toBeLessThan(150);
      await lines.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(lines.getByRole('row', { name: /^20000/ })).toBeVisible();
    });

    test('reflog of HEAD: restore as a branch or by a reset', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('Control+k');
      await page.keyboard.type('reflog');
      await page.keyboard.press('Enter');
      const view = page.getByRole('region', { name: 'Reflog' });
      const entries = view.getByRole('listbox', { name: /^Positions of the reference/ });
      await expect(entries.getByRole('option').first()).toBeVisible();
      await expect(entries.getByText('reset').first()).toBeVisible();
      await expect(entries.getByText('commit gone')).toBeVisible();

      await entries.getByRole('option').nth(2).click();
      const bar = view.getByLabel('Selected entry');
      await expect(bar).toContainText('HEAD@{2}');
      await capture(page, theme, 'reflog');

      await bar.getByRole('button', { name: /^Create a branch here/ }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('HEAD@{2}');
      await capture(page, theme, 'reflog-branch');
      await page.keyboard.press('Escape');

      await bar.getByRole('button', { name: /^Reset .* here/ }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('radio', { name: /Hard/ })).toBeVisible();
      await capture(page, theme, 'reflog-reset');
      await page.keyboard.press('Escape');

      // A pruned commit cannot be restored.
      await entries.getByRole('option').filter({ hasText: 'commit gone' }).click();
      await expect(bar).toContainText('pruned');
      await expect(bar.getByRole('button', { name: /^Reset/ })).toHaveCount(0);
    });

    test('reflog of another branch only offers a new branch', async ({ page }) => {
      await openYaggui(page);
      const tree = page.getByRole('tree');
      // The checked-out branch is feat/graph-lanes: develop can only be restored as a branch.
      await tree
        .getByRole('treeitem', { name: 'develop', exact: true })
        .first()
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Reflog' }).click();
      const view = page.getByRole('region', { name: 'Reflog' });
      const entries = view.getByRole('listbox', { name: /^Positions of the reference/ });
      // The oldest entry is the branch's creation.
      await entries.focus();
      await page.keyboard.press('End');
      await expect(entries.getByText('Created from HEAD')).toBeVisible();
      await page.keyboard.press('Home');
      const bar = view.getByLabel('Selected entry');
      await expect(bar.getByRole('button', { name: /^Reset/ })).toBeDisabled();
      await expect(bar.getByRole('button', { name: /^Create a branch here/ })).toBeEnabled();
    });
  });
}
