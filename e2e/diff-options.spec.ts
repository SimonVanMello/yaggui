import { expect, test, type Page } from '@playwright/test';

/** M2-7a: diff options (wrap, whitespace), aligned split view and keyboard line selection. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const diff = (page: Page) => page.getByRole('region', { name: /^Diff of / });

async function openTabBarDiff(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await selectTabBarDiff(page);
}

async function selectTabBarDiff(page: Page) {
  const unstaged = page.getByRole('listbox', { name: 'Unstaged', exact: true });
  await unstaged
    .getByRole('option')
    .and(unstaged.locator('[title="src/features/tabs/TabBar.tsx"]'))
    .click();
  await expect(diff(page).locator('.yaggui-hunk')).not.toHaveCount(0);
}

async function toggleOption(page: Page, name: string) {
  await diff(page).getByRole('button', { name: 'Diff options' }).click();
  await page.getByRole('menuitemcheckbox', { name }).click();
  // The menu stays open to toggle several options in a row.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Both columns hold the same lines: every rendered row must start at the same height. */
async function rowTops(page: Page) {
  return page.evaluate(() => {
    const tops = (editor: Element) => {
      const base = editor.getBoundingClientRect().top;
      return [...editor.querySelectorAll('.cm-line')].map((line) =>
        Math.round(line.getBoundingClientRect().top - base),
      );
    };
    const [left, right] = [...document.querySelectorAll('.cm-editor')];
    return left && right ? { left: tops(left), right: tops(right) } : null;
  });
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('options menu with wrapping on', async ({ page }) => {
      await openTabBarDiff(page);
      await page.getByRole('radio', { name: 'Unified' }).click();
      await toggleOption(page, 'Wrap lines');
      await diff(page).getByRole('button', { name: 'Diff options' }).click();
      await expect(page.getByRole('menuitemcheckbox', { name: 'Wrap lines' })).toBeChecked();
      await capture(page, theme, 'diff-options-wrap');
    });

    test('split view keeps wrapped rows aligned', async ({ page }) => {
      await openTabBarDiff(page);
      await page.getByRole('radio', { name: 'Side by side' }).click();
      await toggleOption(page, 'Wrap lines');
      await expect(page.locator('.yaggui-spacer').first()).toBeAttached();
      await expect
        .poll(async () => {
          const tops = await rowTops(page);
          return tops !== null && tops.left.length > 0 && tops.left.join() === tops.right.join();
        })
        .toBe(true);
      // Wrapped lines fit both panes: nothing scrolls horizontally.
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.cm-scroller')].map(
          (el) => el.scrollWidth - el.clientWidth,
        ),
      );
      expect(overflow).toEqual([0, 0]);
      await capture(page, theme, 'diff-split-wrapped');
    });

    test('wrapping is a stored preference', async ({ page }) => {
      await openTabBarDiff(page);
      await toggleOption(page, 'Wrap lines');
      await page.reload();
      await selectTabBarDiff(page);
      await diff(page).getByRole('button', { name: 'Diff options' }).click();
      await expect(page.getByRole('menuitemcheckbox', { name: 'Wrap lines' })).toBeChecked();
    });

    test('ignoring whitespace disables hunk and line actions', async ({ page }) => {
      await openTabBarDiff(page);
      await page.getByRole('radio', { name: 'Unified' }).click();
      await toggleOption(page, 'Ignore whitespace');
      const stageHunk = diff(page).getByRole('button', { name: 'Stage hunk' }).first();
      await expect(stageHunk).toHaveAttribute('aria-disabled', 'true');
      await expect(stageHunk).toHaveAttribute('title', /whitespace/);
      await diff(page).locator('.yaggui-signs .yaggui-selectable').first().click();
      await expect(diff(page).getByRole('toolbar')).toContainText('Unavailable while whitespace');
      await expect(diff(page).getByRole('button', { name: 'Stage lines' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      // Enter does nothing: the file stays unstaged.
      await page.keyboard.press('Enter');
      await expect(diff(page).getByRole('toolbar')).toBeVisible();
      await capture(page, theme, 'diff-whitespace-actions-disabled');
    });

    test('keyboard line selection', async ({ page }) => {
      await openTabBarDiff(page);
      await page.getByRole('radio', { name: 'Side by side' }).click();
      await diff(page).locator('.cm-content').first().focus();

      await page.keyboard.press('ArrowDown');
      await expect(diff(page).locator('.yaggui-cursor')).not.toHaveCount(0);
      await expect(diff(page).getByRole('toolbar')).toHaveCount(0);

      await page.keyboard.press('Space');
      await expect(diff(page).getByRole('status').first()).toHaveText(/line(s)? selected/);
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      await expect(diff(page).locator('.yaggui-selected').first()).toBeVisible();
      await capture(page, theme, 'diff-keyboard-selection');

      // Escape clears the selection first and keeps the diff open.
      await page.keyboard.press('Escape');
      await expect(diff(page).getByRole('toolbar')).toHaveCount(0);
      await expect(diff(page)).toBeVisible();

      // Enter stages the selected lines.
      await page.keyboard.press('Space');
      await page.keyboard.press('Enter');
      await expect(
        page
          .getByRole('listbox', { name: 'Staged', exact: true })
          .locator('[title="src/features/tabs/TabBar.tsx"]'),
      ).toBeVisible();
    });
  });
}
