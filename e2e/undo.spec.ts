import { expect, test, type Page } from '@playwright/test';

/** M4-2: undo / redo buttons, shortcuts, session history and refusals, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`undo-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openYaggui(page: Page, name = 'yaggui') {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });
const undoButton = (page: Page) => toolbar(page).getByRole('button', { name: /^(Undo|Cannot)/ });
const redoButton = (page: Page) => toolbar(page).getByRole('button', { name: /^Redo/ });
const dialog = (page: Page) => page.getByRole('dialog');

/** Journals an operation through the UI. */
async function createBranch(page: Page, name: string, checkout: boolean) {
  await toolbar(page).getByRole('button', { name: 'Branch', exact: true }).click();
  await dialog(page).getByLabel('Branch name').fill(name);
  const box = dialog(page).getByLabel('Check it out after creating it');
  if (checkout) await box.check();
  else await box.uncheck();
  await dialog(page)
    .getByRole('button', { name: checkout ? 'Create and check out' : 'Create branch' })
    .click();
  await expect(dialog(page)).toHaveCount(0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Closes and reopens yaggui (M7-1): the journal comes back from `yaggui.db`, optionally after a `git gc`. */
async function restart(page: Page, pruned: boolean) {
  await page.evaluate(async (pruned) => {
    const mock = window.__yagguiMock;
    const opened = await mock?.commands.openRepo('/Users/alex/dev/yaggui');
    if (!mock || opened?.status !== 'ok') return;
    mock.simulateRestoredJournal(opened.data.id, { pruned });
    await mock.commands.closeRepo(opened.data.id);
  }, pruned);
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('undo and redo from the toolbar and the keyboard', async ({ page }) => {
      await openYaggui(page);
      await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
      await createBranch(page, 'qa-undo', false);
      const undo = toolbar(page).getByRole('button', {
        name: 'Undo: creation of branch qa-undo',
      });
      await expect(undo).not.toHaveAttribute('aria-disabled', 'true');
      await undo.hover();
      await expect(page.getByRole('tooltip')).toContainText('Undo: creation of branch qa-undo');
      await capture(page, theme, 'button-active');

      await page.keyboard.press('Control+z');
      await expect(
        page.getByText('Undone: creation of branch qa-undo', { exact: true }),
      ).toBeVisible();
      await expect(
        toolbar(page).getByRole('button', { name: 'Redo: creation of branch qa-undo' }),
      ).not.toHaveAttribute('aria-disabled', 'true');

      await page.keyboard.press('Control+y');
      await expect(
        page.getByText('Redone: creation of branch qa-undo', { exact: true }),
      ).toBeVisible();
      await expect(redoButton(page)).toHaveAttribute('aria-disabled', 'true');
    });

    test('the shortcut leaves text fields alone', async ({ page }) => {
      await openYaggui(page);
      await createBranch(page, 'qa-field', false);
      await page.getByRole('textbox', { name: 'Commit summary' }).focus();
      await page.keyboard.press('Control+z');
      await expect(page.getByText(/^Undone/)).toHaveCount(0);
      await page.locator('body').click({ position: { x: 1, y: 1 } });
    });

    test('the history lists the session, newest first, undone ones marked', async ({ page }) => {
      await openYaggui(page);
      await createBranch(page, 'qa-one', false);
      await createBranch(page, 'qa-two', false);
      await page.keyboard.press('Control+z');
      await expect(
        page.getByText('Undone: creation of branch qa-two', { exact: true }),
      ).toBeVisible();
      await toolbar(page).getByRole('button', { name: 'Operation history' }).click();
      const history = page.getByRole('region', { name: 'Operation history' });
      const rows = history.getByRole('listitem');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('creation of branch qa-two');
      await expect(rows.nth(0)).toContainText('undone');
      await expect(rows.nth(1)).toContainText('creation of branch qa-one');
      await expect(rows.nth(1)).not.toContainText('undone');
      await expect(rows.nth(0).locator('time')).toHaveText(/\d{1,2}:\d{2}:\d{2}/);
      await capture(page, theme, 'history');
    });

    test('the palette offers undo, redo and the history', async ({ page }) => {
      await openYaggui(page);
      await createBranch(page, 'qa-palette', false);
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox').fill('operation');
      await page.getByRole('option', { name: /Show the operation history/ }).click();
      await expect(page.getByRole('region', { name: 'Operation history' })).toBeVisible();
    });

    test('a push cannot be undone: the button is greyed out and says why', async ({ page }) => {
      await openYaggui(page);
      await toolbar(page).getByRole('button', { name: /^Push/ }).first().click();
      const blocked = toolbar(page).getByRole('button', { name: /^Undo: push of/ });
      await expect(blocked).toHaveAttribute('aria-disabled', 'true', { timeout: 5000 });
      await blocked.hover();
      await expect(page.getByRole('tooltip')).toContainText(
        /Cannot undo push of .*changed a remote/,
      );
      await capture(page, theme, 'button-blocked');

      // The shortcut still answers, instead of doing nothing.
      await page.keyboard.press('Control+z');
      await expect(page.getByText('Cannot undo', { exact: true })).toBeVisible();
    });

    test('a divergence is explained, with the refs that moved', async ({ page }) => {
      // `blog` has a clean working tree, so the new branch can be checked out.
      await openYaggui(page, 'blog');
      await createBranch(page, 'qa-diverge', true);
      await page.evaluate(() => window.__yagguiMock?.simulateCommit(3));
      await expect(
        toolbar(page).getByRole('button', { name: /^Undo: .*qa-diverge/ }),
      ).toHaveAttribute('aria-disabled', 'true', { timeout: 5000 });
      await page.keyboard.press('Control+z');
      await expect(dialog(page)).toContainText('Cannot undo: the repository changed since');
      await expect(dialog(page)).toContainText('qa-diverge');
      await capture(page, theme, 'diverged');
      await dialog(page).getByRole('button', { name: 'OK' }).click();
      await expect(dialog(page)).toHaveCount(0);
    });

    test('an entry of a previous session whose objects were pruned is refused', async ({
      page,
    }) => {
      await openYaggui(page);
      await createBranch(page, 'qa-restored', false);
      // A restart with a `git gc` in between (M7-1).
      await page.evaluate(async () => {
        const mock = window.__yagguiMock;
        const opened = await mock?.commands.openRepo('/Users/alex/dev/yaggui');
        if (!mock || opened?.status !== 'ok') return;
        mock.simulateRestoredJournal(opened.data.id, { pruned: true });
        await mock.commands.closeRepo(opened.data.id);
      });
      const blocked = toolbar(page).getByRole('button', {
        name: /^Undo: creation of branch qa-restored/,
      });
      await expect(blocked).toHaveAttribute('aria-disabled', 'true', { timeout: 5000 });
      await blocked.hover();
      await expect(page.getByRole('tooltip')).toContainText(
        "Cannot undo creation of branch qa-restored: what it needs was deleted by Git's garbage collection since",
      );
      await page.keyboard.press('Control+z');
      await expect(page.getByText('Cannot undo', { exact: true })).toBeVisible();
      await expect(page.getByText(/^Git deleted what this undo needs/)).toBeVisible();
      await capture(page, theme, 'objects-missing');
    });

    test('earlier sessions follow this one, unrestorable entries grayed, ⌘Z still works', async ({
      page,
    }) => {
      await openYaggui(page);
      // Three days ago, then pruned by a `git gc`; two days ago, kept; today, this session.
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS - 3 * DAY_MS));
      await createBranch(page, 'qa-pruned', false);
      await restart(page, true);
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS - 2 * DAY_MS));
      await createBranch(page, 'qa-kept', false);
      await restart(page, false);
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await createBranch(page, 'qa-today', false);

      await toolbar(page).getByRole('button', { name: 'Operation history' }).click();
      const history = page.getByRole('region', { name: 'Operation history' });
      const current = history.getByRole('list', { name: 'This session' }).getByRole('listitem');
      const earlier = history.getByRole('list', { name: 'Earlier sessions' }).getByRole('listitem');
      await expect(current).toHaveCount(1);
      await expect(current.nth(0)).toContainText('creation of branch qa-today');
      await expect(current.nth(0).locator('time')).toHaveText(/^\d{1,2}:\d{2}:\d{2}/);
      await expect(history.getByRole('heading', { name: 'Earlier sessions' })).toBeVisible();
      await expect(earlier).toHaveCount(2);
      await expect(earlier.nth(0)).toContainText('creation of branch qa-kept');
      await expect(earlier.nth(0)).toHaveAttribute('data-blocked', 'false');
      await expect(earlier.nth(0).locator('time')).toHaveText(/2026/);
      const pruned = earlier.nth(1);
      await expect(pruned).toContainText('creation of branch qa-pruned');
      await expect(pruned).toContainText('cannot be restored');
      await expect(pruned).toHaveAttribute('data-blocked', 'true');
      await expect(pruned).toHaveAttribute(
        'title',
        "Cannot undo creation of branch qa-pruned: what it needs was deleted by Git's garbage collection since",
      );
      await expect(pruned).toHaveAccessibleDescription(
        "what it needs was deleted by Git's garbage collection since",
      );
      await capture(page, theme, 'history-restored');
      await page.keyboard.press('Escape');
      await expect(history).toHaveCount(0);

      await page.keyboard.press('Control+z');
      await expect(
        page.getByText('Undone: creation of branch qa-today', { exact: true }),
      ).toBeVisible();
      // An entry of the previous session undoes like any other.
      await page.keyboard.press('Control+z');
      await expect(
        page.getByText('Undone: creation of branch qa-kept', { exact: true }),
      ).toBeVisible();
      // The next one cannot be restored: disabled with the reason, and the shortcut says why.
      await expect(
        toolbar(page).getByRole('button', { name: /^Undo: creation of branch qa-pruned/ }),
      ).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Control+z');
      await expect(page.getByText(/^Git deleted what this undo needs/)).toBeVisible();
    });

    test('local changes in the way are listed before anything is stashed', async ({ page }) => {
      await openYaggui(page);
      // A discard, then the same file edited again: the undo would overwrite it (M4-8: the
      // mock refuses like the backend, `undoWouldOverwrite`).
      await page.evaluate(async () => {
        const mock = window.__yagguiMock;
        if (!mock) return;
        const opened = await mock.commands.openRepo('/Users/alex/dev/yaggui');
        if (opened.status !== 'ok') return;
        const { id } = opened.data;
        await mock.commands.discardPaths(id, { kind: 'paths', paths: ['README.md'] }, true);
        mock.simulateEdit(id, 'README.md', 'edited again\n');
      });
      await expect(
        toolbar(page).getByRole('button', { name: 'Undo: discard of README.md' }),
      ).toBeVisible({ timeout: 5000 });
      await page.keyboard.press('Control+z');
      await expect(dialog(page)).toContainText('Local changes are in the way');
      await expect(dialog(page)).toContainText('README.md');
      await capture(page, theme, 'confirm');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);
    });
  });
}
