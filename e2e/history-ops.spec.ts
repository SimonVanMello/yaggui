import { expect, test, type Locator, type Page } from '@playwright/test';

/** M3-2: history operations UI on the mock backend. Captures go to test-results/. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`history-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openYaggui(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
  await expect(graphRow(page, 0)).toBeVisible();
}

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const dialog = (page: Page) => page.getByRole('dialog');
const tree = (page: Page) => page.getByRole('tree');
const banner = (page: Page) => page.getByRole('status', { name: 'Operation in progress' });
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

/** Searches the graph for a merge commit and returns its (selected) row. */
async function mergeRow(page: Page): Promise<Locator> {
  await page.getByRole('listbox', { name: 'Commit graph' }).focus();
  await page.keyboard.press('Control+f');
  await page.keyboard.type('Merge branch');
  const row = page.locator('[data-row][aria-selected="true"]');
  await expect(row).toContainText('Merge branch');
  return row;
}

async function simulate(page: Page, kind: 'merge' | 'rebase' | 'cherryPick' | 'revert') {
  await page.evaluate(
    (operation) => window.__yagguiMock?.simulateOperation(1, operation, { step: 3, total: 7 }),
    kind,
  );
  await expect(banner(page)).toBeVisible();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('commit menu with the reset submenu', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 2).click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: /Cherry-pick onto/ })).toBeVisible();
      // Wired to the fixup commit (M7-3).
      await expect(
        menu.getByRole('menuitem', { name: /^Create a fixup for this commit/ }),
      ).toBeVisible();
      // Wired to the interactive rebase view (M3-4).
      await expect(menu.getByRole('menuitem', { name: /Interactive rebase/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await menu.getByRole('menuitem', { name: /^Reset .* to here/ }).hover();
      await expect(page.getByRole('menuitem', { name: /^Hard/ })).toBeVisible();
      await capture(page, theme, 'commit-menu');
    });

    test('Shift+F10 opens the menu on the selected commit', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 3).click();
      await page.keyboard.press('Shift+F10');
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      // Back on the list, the selection is unchanged.
      await expect(graphRow(page, 3)).toHaveAttribute('aria-selected', 'true');
    });

    test('multi-selection with ⌘-click and ⇧-click, then a cherry-pick', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 2).click();
      await graphRow(page, 5).click({ modifiers: ['ControlOrMeta'] });
      await expect(page.getByText('2 commits selected')).toBeVisible();
      await graphRow(page, 8).click({ modifiers: ['Shift'] });
      // ⌘-click moved the anchor to row 5: the range 5..8 replaces the selection.
      await expect(page.getByText('4 commits selected')).toBeVisible();
      await capture(page, theme, 'multi-select');
      await page.getByRole('button', { name: /Cherry-pick 4 commits onto/ }).click();
      await expect(toastWith(page, '4 commits cherry-picked')).toBeVisible();
    });

    test('Escape and Shift+arrow keep the selection keyboard friendly', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 4).click();
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      await expect(page.getByText('3 commits selected')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByText('3 commits selected')).toHaveCount(0);
    });

    test('merge dialog remembers the chosen mode', async ({ page }) => {
      await openYaggui(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.getByRole('combobox').fill('Merge a branch');
      await page.keyboard.press('Enter');
      const merge = dialog(page);
      await expect(merge).toContainText('Merge');
      await merge.getByLabel('Branch to merge').selectOption({ index: 1 });
      await merge.getByRole('radio', { name: /Always create a merge commit/ }).click();
      await capture(page, theme, 'merge-dialog');
      await merge.getByRole('button', { name: 'Merge', exact: true }).click();
      await expect(toastWith(page, 'merged into')).toBeVisible();
      // Next time the same mode is proposed.
      await page.keyboard.press('ControlOrMeta+K');
      await page.getByRole('combobox').fill('Merge a branch');
      await page.keyboard.press('Enter');
      await expect(
        dialog(page).getByRole('radio', { name: /Always create a merge commit/ }),
      ).toBeChecked();
    });

    test('hard reset lists the files that are lost', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 3).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Reset .* to here/ }).hover();
      await page.getByRole('menuitem', { name: /^Hard/ }).click();
      const reset = dialog(page);
      await expect(reset.getByRole('radio', { name: /^Hard/ })).toBeChecked();
      await expect(reset.getByRole('list', { name: /lose their local content/ })).toBeVisible();
      await expect(reset.getByRole('button', { name: 'Reset (hard)' })).toBeVisible();
      await capture(page, theme, 'reset-hard');
      await reset.getByRole('radio', { name: /^Soft/ }).click();
      await expect(reset.getByRole('list', { name: /lose their local content/ })).toHaveCount(0);
      await capture(page, theme, 'reset-soft');
    });

    test('reverting a merge asks which parent to keep', async ({ page }) => {
      await openYaggui(page);
      const row = await mergeRow(page);
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Revert this commit' }).click();
      const parent = dialog(page);
      await expect(parent.getByRole('radio', { name: /Parent 1/ })).toBeChecked();
      await expect(parent.getByRole('radio', { name: /Parent 2/ })).toBeVisible();
      await capture(page, theme, 'revert-merge');
      await parent.getByRole('button', { name: 'Revert', exact: true }).click();
      await expect(toastWith(page, 'reverted')).toBeVisible();
    });

    test('drag a branch onto another one opens the drop menu', async ({ page }) => {
      await openYaggui(page);
      const source = tree(page)
        .getByRole('treeitem', { name: /^develop/ })
        .first();
      const target = tree(page).getByRole('treeitem', { name: /^main/ }).first();
      await source.hover();
      await page.mouse.down();
      const box = await target.boundingBox();
      if (!box) throw new Error('no target');
      await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 8 });
      await expect(target).toHaveAttribute('data-drop-over', 'true');
      await capture(page, theme, 'drag-over');
      await page.mouse.up();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: /Merge develop into main/ })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: /Rebase develop onto main/ })).toBeVisible();
      await expect(
        menu.getByRole('menuitem', { name: /Fast-forward main to develop/ }),
      ).toBeVisible();
      await capture(page, theme, 'drop-menu');
      await page.keyboard.press('Escape');
    });

    test('drag commits onto a branch pill cherry-picks them', async ({ page }) => {
      await openYaggui(page);
      await graphRow(page, 4).click();
      await graphRow(page, 6).click({ modifiers: ['ControlOrMeta'] });
      const pill = page.locator('[data-drop-branch="feat/graph-lanes"]').first();
      await expect(pill).toBeVisible();
      const from = await graphRow(page, 6).boundingBox();
      const to = await pill.boundingBox();
      if (!from || !to) throw new Error('no boxes');
      await page.mouse.move(from.x + 300, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await page.mouse.up();
      const item = page.getByRole('menuitem', { name: /Cherry-pick 2 commits onto/ });
      await expect(item).toBeVisible();
      await item.click();
      await expect(toastWith(page, '2 commits cherry-picked')).toBeVisible();
    });

    test('sidebar menu has the keyboard twin of the drag', async ({ page }) => {
      await openYaggui(page);
      const row = tree(page)
        .getByRole('treeitem', { name: /^develop/ })
        .first();
      await row.click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: /Merge develop into/ })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Rebase develop onto/ })).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: /Fast-forward .* to develop/ }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
    });

    test('rebase stopped on conflicts: banner, conflicts panel, continue', async ({ page }) => {
      await openYaggui(page);
      await simulate(page, 'rebase');
      await expect(banner(page)).toContainText('Rebase 3/7');
      await expect(banner(page).getByRole('button', { name: 'Continue' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await graphRow(page, 0)
        .click({ position: { x: 5, y: 5 } })
        .catch(() => undefined);
      await page.getByRole('button', { name: 'Show conflicts' }).first().click();
      const panel = page.getByRole('region', { name: 'Conflicts' });
      await expect(panel).toContainText('4 unresolved of 4');
      await expect(panel.getByRole('listitem')).toHaveCount(4);
      await expect(panel).toContainText('Binary');
      await capture(page, theme, 'conflicts');

      // Quick resolutions, one by one; the counter follows.
      const app = panel.getByRole('listitem').filter({ hasText: 'App.tsx' });
      await app
        .getByRole('button', { name: /^Take / })
        .first()
        .click();
      await expect(panel).toContainText('3 unresolved of 4');
      await panel
        .getByRole('listitem')
        .filter({ hasText: 'legacy.md' })
        .getByRole('button', { name: 'Mark resolved' })
        .click();
      await panel
        .getByRole('listitem')
        .filter({ hasText: 'colors.ts' })
        .getByRole('button', { name: /^Take / })
        .nth(1)
        .click();
      await panel
        .getByRole('listitem')
        .filter({ hasText: 'logo.png' })
        .getByRole('button', { name: /^Take / })
        .first()
        .click();
      await expect(panel).toContainText('All 4 resolved');
      await capture(page, theme, 'conflicts-resolved');
      const next = banner(page).getByRole('button', { name: 'Continue' });
      await expect(next).not.toHaveAttribute('aria-disabled', 'true');
      await next.click();
      await expect(banner(page)).toHaveCount(0);
      await expect(toastWith(page, 'Rebase completed')).toBeVisible();
    });

    test('the Resolve… button opens the conflict view', async ({ page }) => {
      await openYaggui(page);
      await simulate(page, 'merge');
      await page.getByRole('button', { name: 'Show conflicts' }).first().click();
      await page.getByRole('button', { name: 'Resolve…' }).first().click();
      const view = page.locator('[data-view^="conflict:"]');
      await expect(view).toBeVisible();
      await capture(page, theme, 'conflict-view');
      await view.getByRole('button', { name: /^Graph/ }).click();
      await expect(view).toHaveCount(0);
    });

    test('merge continue edits the commit message', async ({ page }) => {
      await openYaggui(page);
      await simulate(page, 'merge');
      await page.getByRole('button', { name: 'Show conflicts' }).first().click();
      const panel = page.getByRole('region', { name: 'Conflicts' });
      for (let i = 0; i < 4; i += 1) {
        await panel.getByRole('button', { name: 'Mark resolved' }).first().click();
      }
      await banner(page).getByRole('button', { name: 'Continue' }).click();
      const continueDialog = dialog(page);
      await expect(continueDialog.getByLabel('Commit message')).toHaveValue(/^Merge branch/);
      await continueDialog.getByLabel('Commit message').fill("Merge branch 'x' with context");
      await capture(page, theme, 'continue-dialog');
      await continueDialog.getByRole('button', { name: 'Continue' }).click();
      await expect(toastWith(page, 'Merge completed')).toBeVisible();
    });

    test('abort asks for a confirmation that says what comes back', async ({ page }) => {
      await openYaggui(page);
      await simulate(page, 'rebase');
      await banner(page).getByRole('button', { name: 'Abort rebase' }).click();
      const confirm = dialog(page);
      await expect(confirm).toContainText('Abort the rebase?');
      await expect(confirm).toContainText('git rebase --abort');
      await capture(page, theme, 'abort-confirm');
      await confirm.getByRole('button', { name: 'Abort rebase' }).click();
      await expect(banner(page)).toHaveCount(0);
    });

    test('skip and the typed errors of a conflicting merge', async ({ page }) => {
      await openYaggui(page);
      await simulate(page, 'cherryPick');
      await banner(page).getByRole('button', { name: 'Skip' }).click();
      await expect(banner(page)).toHaveCount(0);
    });
  });
}
