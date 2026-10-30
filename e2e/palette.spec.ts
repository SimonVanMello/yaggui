import { expect, test, type Page } from '@playwright/test';

/** M1-5: command palette (F-280) on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`palette-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.setViewportSize({ width: 900, height: 560 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

const input = (page: Page) => page.getByRole('combobox', { name: 'Command palette' });
const options = (page: Page) =>
  page.getByRole('listbox', { name: 'Command palette' }).getByRole('option');

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+K');
  await expect(input(page)).toBeFocused();
}

test.use({ locale: 'en-US' });

test('opens with the shortcut, closes with Escape and toggles', async ({ page }) => {
  await start(page);
  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(input(page)).toBeHidden();
  await openPalette(page);
  await page.keyboard.press('ControlOrMeta+K');
  await expect(input(page)).toBeHidden();
});

test('runs an action with the keyboard', async ({ page }) => {
  await start(page);
  await openPalette(page);
  await page.keyboard.type('new tab');
  await expect(options(page).first()).toContainText('New tab');
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeHidden();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/new tab/i);
});

test('lists repository actions as disabled without a repository and does not run them', async ({
  page,
}) => {
  await start(page);
  // A new tab shows the welcome screen: no repository to push.
  await page.keyboard.press('ControlOrMeta+T');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  await openPalette(page);
  await page.keyboard.type('>push');
  const push = options(page).filter({ hasText: 'Push' }).first();
  await expect(push).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeVisible();
  await page.keyboard.press('Escape');

  // Back on the repository, the same action is enabled.
  await page.keyboard.press('ControlOrMeta+1');
  await openPalette(page);
  await page.keyboard.type('>push');
  await expect(options(page).filter({ hasText: 'Push' }).first()).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('picking a branch selects its commit in the graph', async ({ page }) => {
  await start(page);
  await openPalette(page);
  await page.keyboard.type('@palette-42');
  await expect(options(page).first()).toContainText('palette-42');
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeHidden();
  await expect(page.locator('[id^="graph-row-"][aria-selected="true"]')).toHaveCount(1);
});

test('finds commits and reveals the chosen one', async ({ page }) => {
  await start(page);
  await openPalette(page);
  await page.keyboard.type('#fix');
  await expect(page.locator('[data-kind="commit"]').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeHidden();
  await expect(page.locator('[id^="graph-row-"][aria-selected="true"]')).toHaveCount(1);
});

test('switches to another tab', async ({ page }) => {
  await start(page);
  await page.keyboard.press('ControlOrMeta+T');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await openPalette(page);
  await page.keyboard.type('yaggui');
  await expect(page.locator('[data-kind="tab"]').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await start(page);
    });

    test('open, empty query', async ({ page }) => {
      await openPalette(page);
      await expect(options(page).first()).toBeVisible();
      await capture(page, theme, 'empty');
    });

    test('filtered on actions', async ({ page }) => {
      await openPalette(page);
      // "log" alone also matches "Open logs folder", which ranks first.
      await page.keyboard.type('>command log');
      await expect(options(page).first()).toContainText('command log');
      await capture(page, theme, 'actions');
    });

    test('disabled action says why', async ({ page }) => {
      await openPalette(page);
      await page.keyboard.type('>Continue');
      const option = options(page).first();
      await expect(option).toHaveAttribute('aria-disabled', 'true');
      await expect(option).toContainText('No operation in progress');
      await expect(option).not.toContainText('Coming soon');
      await capture(page, theme, 'disabled-reason');
    });

    test('filtered on commits', async ({ page }) => {
      await openPalette(page);
      await page.keyboard.type('#fix');
      await expect(page.locator('[data-kind="commit"]').first()).toBeVisible();
      await capture(page, theme, 'commits');
    });
  });
}
