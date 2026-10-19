import { expect, test, type Page } from '@playwright/test';

/**
 * README screenshots (`pnpm screenshots`, playwright.screenshots.config.ts): the mock backend at
 * 1440×900, written to docs/assets/. Not part of `pnpm test:ui`.
 */

const MOCK_NOW_MS = 1_791_795_600_000;
const ASSETS = 'docs/assets';

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  // Let the canvas graph and the virtualized lists settle after the last interaction.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${ASSETS}/${name}.png`, animations: 'disabled' });
}

async function openRepo(page: Page, name: RegExp = /^yaggui\b/) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  // The README shows the English UI; `locale: 'en-US'` in the config drives the detection.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('option', { name }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(name);
}

async function selectCommit(page: Page, index: number) {
  const graph = page.getByRole('listbox', { name: 'Commit graph' });
  await graph.getByRole('option').nth(index).click();
  await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();
  await expect(page.getByRole('listbox', { name: /^Commit [0-9a-f]{7}$/ })).toBeVisible();
}

async function stageLines(page: Page, name: string) {
  await openRepo(page);
  const unstaged = page.getByRole('listbox', { name: 'Unstaged', exact: true });
  await unstaged
    .getByRole('option')
    .and(unstaged.locator('[title="src/features/tabs/TabBar.tsx"]'))
    .click();
  const diff = page.getByRole('region', { name: /^Diff of / });
  await expect(diff.locator('.yaggui-hunk')).not.toHaveCount(0);
  const gutter = diff.locator('.yaggui-signs .yaggui-selectable');
  await gutter.first().click();
  await gutter.nth(1).click({ modifiers: ['Shift'] });
  await expect(diff.locator('.yaggui-selected').first()).toBeVisible();
  await capture(page, name);
}

test.describe('graphite', () => {
  test.use({ colorScheme: 'dark' });

  test('graph with commit details', async ({ page }) => {
    await openRepo(page);
    await selectCommit(page, 2);
    await capture(page, 'screenshot-graph');
  });

  test('line staging in the diff', async ({ page }) => {
    await stageLines(page, 'screenshot-staging');
  });
});

test.describe('paper', () => {
  test.use({ colorScheme: 'light' });

  test('graph with commit details', async ({ page }) => {
    await openRepo(page);
    await selectCommit(page, 2);
    await capture(page, 'screenshot-graph-paper');
  });

  test('line staging in the diff', async ({ page }) => {
    await stageLines(page, 'screenshot-staging-paper');
  });
});
