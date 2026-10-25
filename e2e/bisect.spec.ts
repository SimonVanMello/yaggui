import { expect, test, type Page } from '@playwright/test';

/**
 * M7-9: assisted bisect (F-263) on the mock backend, repository `blog` (clean): started from
 * the commit menu, stepped from the banner, markers in the graph, the first bad commit at the
 * end, then the reset back to the branch. M8-2: the palette entries, and a bisect started in
 * first-parent mode.
 */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`bisect-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^blog\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^blog\b/);
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
}

async function markFromMenu(page: Page, row: number, submenu: string, item: string) {
  await page.locator(`[data-row="${String(row)}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: submenu }).hover();
  await page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
}

const banner = (page: Page) => page.getByTestId('bisect-banner');
const marks = (page: Page) => page.getByTestId('bisect-mark');

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('bisect from the graph to the first bad commit, then reset', async ({ page }) => {
      await openRepo(page);
      const tip = await page.locator('[data-row="0"]').getAttribute('data-sha');

      // HEAD is bad: the bisect starts and asks for a good commit.
      await markFromMenu(page, 0, 'Start bisect', 'Mark as bad');
      await expect(banner(page)).toContainText('Mark a good commit');
      await expect(page.locator('[data-row="0"]').getByTestId('bisect-mark')).toHaveText('bad');

      // An older commit is good: Git checks out the middle of the range.
      await markFromMenu(page, 12, 'Bisect', 'Mark as good');
      await expect(banner(page)).toContainText('Testing');
      await expect(banner(page).getByTestId('bisect-steps')).toContainText(/steps? left/);
      await expect(marks(page).filter({ hasText: 'good' })).toHaveCount(1);
      await expect(marks(page).filter({ hasText: 'testing' })).toHaveCount(1);
      await capture(page, theme, 'banner');

      // Skip from the banner, then every commit tested is good: the tip is the first bad one.
      await banner(page).getByRole('button', { name: 'Skip', exact: true }).click();
      await expect(marks(page).filter({ hasText: 'skipped' })).toHaveCount(1);
      await expect(banner(page).locator('button[aria-disabled="true"]')).toHaveCount(0);
      for (let i = 0; i < 8; i++) {
        if (await banner(page).getByText('First bad commit found').isVisible()) break;
        const good = banner(page).getByRole('button', { name: 'Good', exact: true });
        if (!(await good.isVisible())) break;
        await good.click();
        // The buttons are disabled while the step runs.
        await expect(banner(page).locator('button[aria-disabled="true"]')).toHaveCount(0);
      }
      await expect(banner(page)).toContainText('First bad commit found');
      await expect(page.locator('[data-row="0"]').getByTestId('bisect-mark')).toHaveText(
        'first bad',
      );
      await capture(page, theme, 'result');

      // End: confirmed, HEAD back on the branch tip, no marks left.
      await banner(page).getByRole('button', { name: 'End bisect' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop bisect' }).click();
      await expect(banner(page)).toHaveCount(0);
      await expect(marks(page)).toHaveCount(0);
      await expect(page.locator('[data-row="0"]')).toHaveAttribute('data-sha', tip ?? '');
    });

    test('a bisect started before a restart is found again on reopening (M7-10)', async ({
      page,
    }) => {
      await openRepo(page);
      // Marks given in a terminal, or before quitting: read back from `refs/bisect/*`.
      await page.evaluate(() =>
        window.__yagguiMock?.simulateOperation(3, 'bisect', {
          marks: { bad: 'HEAD', good: ['HEAD~12'] },
        }),
      );
      await page.getByRole('button', { name: 'Close blog' }).click();
      await page.getByRole('option', { name: /^blog\b/ }).click();
      await expect(banner(page)).toContainText('Testing');
      await expect(banner(page).getByTestId('bisect-steps')).toContainText(/steps? left/);
      await expect(marks(page).filter({ hasText: 'bad' })).toHaveCount(1);
      // The commit under test is further down: the banner jumps to it.
      await banner(page).locator('code').first().click();
      await expect(marks(page).filter({ hasText: 'testing' })).toHaveCount(1);
      await capture(page, theme, 'reopened');
    });

    test('bisect from the palette, along first parents in first-parent mode (M8-2)', async ({
      page,
    }) => {
      await openRepo(page);
      const firstParent = page.getByRole('toolbar').getByRole('button', { name: 'First parent' });
      await firstParent.click();
      await expect(firstParent).toHaveAttribute('aria-pressed', 'true');
      const palette = page.getByRole('listbox', { name: 'Command palette' });
      const runFromPalette = async (query: string, entry: string) => {
        await page.keyboard.press('ControlOrMeta+K');
        await page.keyboard.type(query);
        await expect(palette.getByRole('option', { name: new RegExp(`^${entry}`) })).toBeVisible();
        await page.keyboard.press('Enter');
      };

      // No commit selected: the bisect entries say why they cannot run.
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('bisect');
      await expect(palette.getByRole('option', { name: /^Bisect: mark as bad/ })).toContainText(
        'Select a commit first',
      );
      await expect(palette.getByRole('option', { name: /^Bisect: skip/ })).toContainText(
        'No bisect in progress',
      );
      await page.keyboard.press('Escape');

      // The selected commit starts the bisect, in first-parent mode.
      await page.locator('[data-row="0"]').click();
      await runFromPalette('bisect bad', 'Bisect: mark as bad');
      await expect(banner(page)).toContainText('Mark a good commit');
      await expect(banner(page).getByTestId('bisect-first-parent')).toHaveText('First parent');
      await markFromMenu(page, 12, 'Bisect', 'Mark as good');
      await expect(banner(page)).toContainText('Testing');
      await expect(marks(page).filter({ hasText: 'testing' })).toHaveCount(1);
      await capture(page, theme, 'first-parent');

      // During the bisect, the palette marks the commit under test, like the banner.
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('bisect');
      await expect(palette.getByRole('option', { name: /^Bisect: / })).toHaveCount(4);
      await capture(page, theme, 'palette');
      await page.keyboard.press('Escape');
      const steps = await banner(page).getByTestId('bisect-steps').textContent();
      await runFromPalette('bisect good', 'Bisect: mark as good');
      await expect(marks(page).filter({ hasText: 'good' })).toHaveCount(2);
      await expect(banner(page).getByTestId('bisect-steps')).not.toHaveText(steps ?? '');

      await runFromPalette('bisect end', 'Bisect: end and go back');
      await page.getByRole('dialog').getByRole('button', { name: 'Stop bisect' }).click();
      await expect(banner(page)).toHaveCount(0);
    });

    test('a checkout in the way keeps the mark, then checks out the next commit', async ({
      page,
    }) => {
      await openRepo(page);
      // HEAD (`main`, row 4 of the mock) is bad: the failed checkout leaves it there, marked.
      await markFromMenu(page, 4, 'Start bisect', 'Mark as bad');
      // The banner shifts the graph down: wait for it before opening the next menu.
      await expect(banner(page)).toContainText('Mark a good commit');
      await expect(page.locator('[data-row="4"]').getByTestId('bisect-mark')).toHaveText('bad');
      await page.evaluate(() => window.__yagguiMock?.simulateBisectCheckoutFailure(3));
      await markFromMenu(page, 12, 'Bisect', 'Mark as good');
      await expect(page.getByText(/^The mark is saved, but the next commit/)).toBeVisible();
      await expect(banner(page)).toContainText('could not be checked out');
      await expect(marks(page).filter({ hasText: 'good' })).toHaveCount(1);
      await capture(page, theme, 'checkout-failed');
      await banner(page).getByRole('button', { name: 'Check out next commit' }).click();
      await expect(banner(page)).toContainText('Testing');
      await expect(marks(page).filter({ hasText: 'testing' })).toHaveCount(1);
    });
  });
}
