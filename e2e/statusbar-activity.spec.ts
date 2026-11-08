import { expect, test, type Page } from '@playwright/test';

/** Status bar "Synced …" and the Activity center, on the mock backend. */

/** Same fixed "now" as the mock data (src/ipc/mockData.ts), for stable relative times. */
const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`statusbar-${state}-${theme}.png`),
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

const footer = (page: Page) => page.locator('footer');
const sync = (page: Page) => footer(page).getByRole('button', { name: /synced/i });
const toasts = (page: Page) => page.locator('ol > li');
const activityButton = (page: Page) => footer(page).getByRole('button', { name: /^Activity/ });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('last sync reads "Synced 2 minutes ago", with its details on hover', async ({ page }) => {
      await openRepo(page, 'yaggui');
      // The mock fixture fetched 30 minutes ago.
      await expect(sync(page)).toHaveText('Synced 30 minutes ago');
      await page.evaluate(() => window.__yagguiMock?.setLastFetch(1, 120));
      await expect(sync(page)).toHaveText('Synced 2 minutes ago');
      await sync(page).hover();
      const tip = page.getByRole('tooltip');
      await expect(tip).toContainText('Last fetch:');
      await expect(tip).toContainText('Remotes: origin');
      await expect(tip).toContainText('Auto-fetch every 10 min');
      await expect(tip).toContainText('Fetch and pull preferences…');
      await capture(page, theme, 'synced');

      // The link opens Preferences › Fetch and pull.
      await page
        .getByRole('tooltip')
        .getByRole('button', { name: 'Fetch and pull preferences…' })
        .click();
      await expect(page.getByRole('dialog')).toContainText('Fetch automatically');
    });

    test('a repository never fetched reads "Never synced"; a click fetches it', async ({
      page,
    }) => {
      await openRepo(page, 'blog');
      await expect(sync(page)).toHaveText('Never synced');
      await capture(page, theme, 'never');
      await sync(page).click();
      // Fixed order while the fetch runs: the operation on the left, the sync item stays.
      await expect(footer(page).getByRole('status')).toContainText('Fetch');
      await expect(sync(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(sync(page)).toHaveText('Synced now');
      await expect(sync(page)).toHaveAttribute('aria-disabled', 'false');
    });

    test('an unreachable remote shows "Offline" until a fetch gets through', async ({ page }) => {
      await openRepo(page, 'yaggui');
      await page.evaluate(() => {
        window.__yagguiMock?.addOfflineRemote(1);
      });
      await sync(page).click();
      await expect(sync(page)).toHaveText('Offline · synced 30 minutes ago');
      // The click closed the tooltip: it opens again once the pointer comes back.
      await page.mouse.move(0, 0);
      await sync(page).hover();
      await expect(page.getByRole('tooltip')).toContainText(
        'The last fetch, pull or push could not reach the remote host.',
      );
      await expect(page.getByRole('tooltip')).toContainText('Remotes: origin, offline');
      await capture(page, theme, 'offline');

      // A later local operation keeps it; a fetch of a reachable remote clears it.
      await page.mouse.move(0, 0);
      await page
        .getByRole('toolbar', { name: 'Repository actions' })
        .getByLabel('Fetch options')
        .click();
      await page.getByRole('menuitem', { name: /^Fetch origin/ }).click();
      await expect(sync(page)).toHaveText('Synced now');
    });

    test('the Activity center lists the notifications of the session', async ({ page }) => {
      await openRepo(page, 'yaggui');
      await expect(activityButton(page)).toHaveAccessibleName('Activity');

      // A success, an info (cancelled push) and an error with a Retry button.
      await sync(page).click();
      await expect(toasts(page).filter({ hasText: 'Fetch complete' })).toBeVisible();
      await page
        .getByRole('toolbar', { name: 'Repository actions' })
        .getByRole('button', { name: /^Push/ })
        .first()
        .click();
      await footer(page).getByRole('status').getByRole('button', { name: 'Cancel' }).click();
      await expect(toasts(page).filter({ hasText: 'Push cancelled' })).toBeVisible();
      await page.evaluate(() => {
        window.__yagguiMock?.addOfflineRemote(1);
      });
      await sync(page).click();
      const failed = toasts(page).filter({ hasText: 'Fetch failed' });
      await expect(failed).toBeVisible();
      // Dismissed toasts stay in the activity.
      await failed.getByRole('button', { name: 'Close' }).click();

      await expect(activityButton(page)).toHaveAccessibleName('Activity, 3 new');
      await expect(activityButton(page)).toContainText('3');
      await capture(page, theme, 'activity-badge');

      await activityButton(page).click();
      const popover = page.getByRole('dialog', { name: 'Activity' });
      const list = popover.getByRole('list', { name: 'Last notifications' });
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await expect(list.getByRole('listitem').first()).toContainText('Fetch failed (yaggui)');
      await expect(list.getByRole('listitem').first()).toContainText('yaggui · now');
      await expect(
        list.getByRole('listitem').first().getByRole('button', { name: 'Retry' }),
      ).toBeVisible();
      await expect(list.getByRole('listitem').nth(1)).toContainText('Push cancelled');
      await expect(list.getByRole('listitem').nth(2)).toContainText('Fetch complete');
      // Opened: nothing unread any more.
      await expect(activityButton(page)).toHaveAccessibleName('Activity');
      await capture(page, theme, 'activity-open');

      // Keyboard: focus starts on the newest entry, arrows move, Escape closes.
      const entries = list.locator('[data-activity-entry]');
      await expect(entries.first()).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(entries.nth(1)).toBeFocused();
      await page.keyboard.press('End');
      await expect(entries.nth(2)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(popover).toBeHidden();

      // Enter on the error opens the command log on its failed command.
      await activityButton(page).click();
      await expect(entries.first()).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(popover).toBeHidden();
      const log = page.locator('#command-log');
      await expect(log).toBeVisible();
      await expect(log).toContainText('Could not resolve host: offline.invalid');

      // Clear empties it; the palette opens it too.
      await page.keyboard.press('Control+K');
      await page.keyboard.type('Show activity');
      await page.keyboard.press('Enter');
      await expect(popover).toBeVisible();
      await popover.getByRole('button', { name: 'Clear' }).click();
      await expect(popover).toContainText('No activity yet');
      await capture(page, theme, 'activity-empty');
    });
  });
}
