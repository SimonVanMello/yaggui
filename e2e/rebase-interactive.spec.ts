import { expect, test, type Locator, type Page } from '@playwright/test';

/** M3-4: interactive rebase view (F-142) on the mock backend, repository `blog` (id 3). */

const MOCK_NOW_MS = 1_791_795_600_000;
const BLOG_ID = 3;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`rebase-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openBlog(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^blog\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^blog/);
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
}

const picker = (page: Page) => page.getByRole('listbox', { name: 'Latest commits of the branch' });
const todo = (page: Page) => page.getByRole('listbox', { name: /^Commits to rebase/ });
const rows = (page: Page) => todo(page).getByRole('option');
const startButton = (page: Page) => page.getByRole('button', { name: /^Start rebase/ }).first();

async function openPicker(page: Page) {
  await page.keyboard.press('ControlOrMeta+K');
  await page.keyboard.type('interactive rebase');
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeFocused();
}

/** Opens the view on the 6 latest commits of `main`, through the base picker. */
async function openTodo(page: Page, count = 6) {
  await openPicker(page);
  await picker(page)
    .getByRole('option')
    .filter({ hasText: new RegExp(`(?<!\\d)${String(count)} commits above`) })
    .click();
  await expect(rows(page)).toHaveCount(count);
  await expect(todo(page)).toBeFocused();
}

/** Accessible names of the rows, newest first. */
const order = (list: Locator) =>
  list.getByRole('option').evaluateAll((items) => items.map((i) => i.getAttribute('aria-label')));

const press = async (page: Page, keys: string[]) => {
  for (const key of keys) await page.keyboard.press(key);
};

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('base picker, then a todo with every action, keyboard and result panel', async ({
      page,
    }) => {
      await openBlog(page);
      await openPicker(page);
      await expect(page.getByRole('heading', { name: 'Interactive rebase' })).toBeVisible();
      await expect(picker(page).getByRole('option')).toHaveCount(30);
      await capture(page, theme, 'picker');

      // Arrow keys and Enter pick the base: 6th row = 6 commits to rewrite.
      await press(page, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']);
      await expect(rows(page)).toHaveCount(6);
      await expect(page.getByText('6 commits', { exact: true }).first()).toBeVisible();
      await expect(startButton(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText('Change at least one commit to start')).toBeVisible();
      const original = await order(todo(page));
      expect(original).toHaveLength(6);
      // Every commit is already on origin/main.
      await expect(todo(page).getByText('Pushed')).toHaveCount(6);

      // Action keys apply to the focused row; ↓ moves the focus down.
      await press(page, [
        'r',
        'ArrowDown',
        's',
        'ArrowDown',
        'f',
        'ArrowDown',
        'd',
        'ArrowDown',
        'e',
      ]);
      await expect(rows(page).nth(0)).toHaveAttribute('data-action', 'reword');
      await expect(rows(page).nth(1)).toHaveAttribute('data-action', 'squash');
      await expect(rows(page).nth(2)).toHaveAttribute('data-action', 'fixup');
      await expect(rows(page).nth(3)).toHaveAttribute('data-action', 'drop');
      await expect(rows(page).nth(4)).toHaveAttribute('data-action', 'edit');
      await expect(rows(page).nth(1)).toContainText('Melded into');
      await expect(rows(page).nth(4)).toContainText('The rebase stops here');
      await expect(startButton(page)).not.toHaveAttribute('aria-disabled', 'true');

      // Alt+↓ moves the focused commit down; the focus follows it.
      await page.keyboard.press('Alt+ArrowDown');
      const moved = await order(todo(page));
      expect(moved[5]).toBe(original[4]);
      expect(moved[4]).toBe(original[5]);
      await expect(rows(page).nth(5)).toHaveAttribute('data-action', 'edit');
      await expect(todo(page)).toHaveAttribute('aria-activedescendant', /rebase-row-/);
      await page.keyboard.press('Alt+ArrowUp');
      expect(await order(todo(page))).toEqual(original);

      // Result: 6 commits − 1 dropped − 2 melded = 3.
      const result = page.getByRole('region', { name: 'Result' });
      await expect(result).toContainText('3 commits');
      await expect(result).toContainText('1 commit dropped');
      await expect(result).toContainText('2 melded');
      await expect(result).toContainText('stops for editing');
      await rows(page).first().hover();
      await capture(page, theme, 'todo');

      // Esc leaves the view: the graph is back.
      await todo(page).focus();
      await page.keyboard.press('Escape');
      await expect(todo(page)).toBeHidden();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
    });

    test('moves a commit with the pointer, with a drop indicator', async ({ page }) => {
      await openBlog(page);
      await openTodo(page, 4);
      const before = await order(todo(page));
      const grip = (index: number) => rows(page).nth(index).locator('[class*="grip"]');
      const from = await grip(0).boundingBox();
      const target = await rows(page).nth(2).boundingBox();
      if (!from || !target) throw new Error('rows are not laid out');

      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      // Over the lower half of the third row: the drop slot is right below it.
      await page.mouse.move(from.x + 8, target.y + target.height * 0.75, { steps: 6 });
      await expect(rows(page).nth(3)).toHaveAttribute('data-drop', 'before');
      await expect(rows(page).nth(0)).toHaveAttribute('data-dragging', 'true');
      await capture(page, theme, 'drag');
      await page.mouse.up();

      const after = await order(todo(page));
      expect(after).toEqual([before[1], before[2], before[0], before[3]]);
      // The result panel follows the new order.
      await expect(rows(page).nth(2)).toHaveAttribute('data-focused', 'true');
    });

    test('reword: inline editor with the 72 characters counter, then the message lands in the graph', async ({
      page,
    }) => {
      await openBlog(page);
      await openTodo(page);
      await page.keyboard.press('r');
      await page.keyboard.press('Enter');
      const editor = rows(page).first().getByRole('textbox', { name: 'Commit summary' });
      await expect(editor).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('x'.repeat(80));
      await expect(rows(page).first()).toContainText('80/72');
      await expect(rows(page).first()).toContainText('Summaries over 72 characters');
      await capture(page, theme, 'message-over');

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('fix(graph): reworded in the rebase view');
      await expect(rows(page).first()).toContainText('39/72');
      await page.keyboard.press('Tab');
      await page.keyboard.type('Body line\n# not a comment');
      await rows(page).first().getByRole('button', { name: 'Done' }).click();
      await expect(todo(page)).toBeFocused();
      const result = page.getByRole('region', { name: 'Result' });
      await expect(result).toContainText('fix(graph): reworded in the rebase view');
      await expect(result).toContainText('edited message');
      await capture(page, theme, 'message');

      // An empty summary is flagged and blocks the start.
      await page.keyboard.press('Enter');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
      await expect(rows(page).first()).toContainText('The message needs a summary');
      await expect(startButton(page)).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.type('fix(graph): reworded in the rebase view');
      await page.keyboard.press('Escape');
      // Esc closed the editor, not the view.
      await expect(todo(page)).toBeVisible();
      await expect(todo(page)).toBeFocused();

      await startButton(page).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Rewrite 1 commit of main?');
      await expect(dialog).toContainText('--force-with-lease');
      await dialog.getByRole('button', { name: 'Start rebase' }).click();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      await expect(graph).toBeVisible();
      await expect(graph.getByRole('option').first()).toContainText(
        'fix(graph): reworded in the rebase view',
      );
      await capture(page, theme, 'done');
    });

    test('flags a squash with nothing below it, then confirms the rewrite of pushed commits', async ({
      page,
    }) => {
      await openBlog(page);
      await openTodo(page, 3);
      await page.keyboard.press('End');
      await page.keyboard.press('s');
      const oldest = rows(page).last();
      await expect(oldest).toHaveAttribute('data-issue', 'noTarget');
      await expect(oldest).toContainText('Nothing below to meld into');
      await expect(startButton(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText('Fix the highlighted commits to start')).toBeVisible();
      await capture(page, theme, 'invalid');

      // Back to pick, a reorder is enough to start: the three commits are rewritten.
      await page.keyboard.press('p');
      await page.keyboard.press('Alt+ArrowUp');
      await expect(startButton(page)).not.toHaveAttribute('aria-disabled', 'true');
      await startButton(page).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('are already on origin/main');
      await expect(
        dialog.getByRole('list', { name: 'What will happen' }).getByRole('listitem'),
      ).toHaveCount(3);
      await capture(page, theme, 'confirm');
      // Cancel: nothing ran, the view stays.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(todo(page)).toBeVisible();
    });

    test('stops on an edit step, then continues to the end', async ({ page }) => {
      await openBlog(page);
      await openTodo(page, 3);
      await page.keyboard.press('End');
      await page.keyboard.press('e');
      await startButton(page).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Start rebase' }).click();

      const stopped = page.getByRole('region', { name: 'Rebase stopped' });
      await expect(stopped).toBeVisible();
      await expect(stopped).toContainText(/Rebase stopped at step \d+\/\d+ on [0-9a-f]{7}/);
      await expect(stopped.getByRole('button', { name: 'Continue' })).toBeVisible();
      await expect(stopped.getByRole('button', { name: 'Skip' })).toHaveCount(0);
      await capture(page, theme, 'stopped-edit');

      await stopped.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await expect(stopped).toBeHidden();
    });

    test('conflicts: the panel waits for the resolution, and the rebase can be aborted', async ({
      page,
    }) => {
      await openBlog(page);
      await page.evaluate((id) => {
        window.__yagguiMock?.simulateRebaseConflict(id);
      }, BLOG_ID);
      await openTodo(page, 4);
      await page.keyboard.press('Alt+ArrowDown');
      await startButton(page).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Start rebase' }).click();

      // The 3-way editor opens first; "Graph" goes back to the rebase view behind it.
      const editor = page.getByRole('region', { name: /^Conflict in / });
      await expect(editor).toBeVisible();
      await editor.getByRole('button', { name: 'Graph' }).click();
      const stopped = page.getByRole('region', { name: 'Rebase stopped' });
      await expect(stopped).toContainText('Resolve the conflicts in the changes panel');
      await expect(stopped).toContainText(/\d+ files? still in conflict/);
      await expect(stopped.getByRole('button', { name: 'Continue' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(stopped.getByRole('button', { name: 'Skip' })).toBeVisible();
      await capture(page, theme, 'stopped-conflicts');

      await stopped.getByRole('button', { name: 'Abort rebase' }).click();
      await expect(page.getByText('Rebase of main aborted', { exact: true })).toBeVisible();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
    });

    test('conflicts open the 3-way editor; once resolved, Continue resumes the rebase', async ({
      page,
    }) => {
      await openBlog(page);
      await page.evaluate((id) => {
        window.__yagguiMock?.simulateRebaseConflict(id);
      }, BLOG_ID);
      await openTodo(page, 4);
      await page.keyboard.press('Alt+ArrowDown');
      await startButton(page).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Start rebase' }).click();

      // The unified conflict view (M3-3) opens on the first conflicted file, over the view.
      const editor = page.getByRole('region', { name: /^Conflict in / });
      await expect(editor).toBeVisible();
      await capture(page, theme, 'conflict-editor');
      // Quick resolution of every file from the conflicts panel, then back to the rebase.
      const panel = page.getByRole('region', { name: 'Conflicts' });
      for (let left = 4; left > 0; left -= 1) {
        await panel.getByRole('button', { name: 'Take main' }).first().click();
        await expect(panel.getByRole('button', { name: 'Take main' })).toHaveCount(left - 1);
      }
      if (await editor.isVisible())
        await editor.getByRole('button', { name: 'Graph' }).first().click();

      // Back on the stopped panel: Continue is available and finishes the rebase.
      const stopped = page.getByRole('region', { name: 'Rebase stopped' });
      await expect(stopped).toContainText('All conflicts are resolved');
      const next = stopped.getByRole('button', { name: 'Continue' });
      await expect(next).not.toHaveAttribute('aria-disabled', 'true');
      await next.click();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await expect(page.getByRole('status', { name: 'Operation in progress' })).toHaveCount(0);
    });

    test('continuing from the operation banner closes the view', async ({ page }) => {
      await openBlog(page);
      await openTodo(page, 4);
      await page.keyboard.press('e');
      await startButton(page).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Start rebase' }).click();
      await expect(page.getByRole('region', { name: 'Rebase stopped' })).toBeVisible();
      await page
        .getByRole('status', { name: 'Operation in progress' })
        .getByRole('button', { name: 'Continue' })
        .click();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Rebase stopped' })).toHaveCount(0);
    });

    test('opens from the selected commit of the graph', async ({ page }) => {
      await openBlog(page);
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      await graph
        .getByRole('option')
        .filter({ hasText: 'feat(ipc): add page loading' })
        .first()
        .click();
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('interactive rebase');
      await page.keyboard.press('Enter');
      // The selected commit is the base: the 4 commits above it are listed.
      await expect(rows(page)).toHaveCount(4);
      await expect(todo(page)).toBeFocused();
    });

    test('opens from the commit context menu', async ({ page }) => {
      await openBlog(page);
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      await graph
        .getByRole('option')
        .filter({ hasText: 'feat(ipc): add page loading' })
        .first()
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Interactive rebase from here/ }).click();
      await expect(rows(page)).toHaveCount(4);
    });
  });
}
