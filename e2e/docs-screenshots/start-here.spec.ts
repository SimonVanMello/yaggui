import { expect, test, type Page } from '@playwright/test';

import { capture, openRepo, start } from './capture';
import { around } from './crop';

/** Screenshots of the "Start here" pages: introduction, tour, open a repository, updates. */

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

/** Mock setup (run before the app starts): an update to 0.2.0 offered through `channel`. */
const updateSetup = (channel: string) => `(mock) => {
  mock.seedPreferences({ checkUpdates: true });
  mock.availableUpdate = {
    currentVersion: '0.1.0',
    version: '0.2.0',
    notes: null,
    date: null,
    channel: '${channel}',
  };
}`;

async function openYaggui(page: Page) {
  await start(page);
  await openRepo(page);
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
}

// introduction.mdx

test('intro-main-window', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.locator('[data-row="wip"]').click();
  await expect(page.getByRole('region', { name: 'Local changes' })).toBeVisible();
  await page.mouse.move(640, 790);
  await capture(page, testInfo, 'intro-main-window');
});

// updates.mdx

test('updates-notice', async ({ page }, testInfo) => {
  await start(page, updateSetup('selfUpdate'));
  const notice = page.getByRole('listitem').filter({ hasText: 'yaggui 0.2.0 is available' });
  await expect(notice.getByRole('button', { name: 'Update and restart' })).toBeVisible();
  await capture(page, testInfo, 'updates-notice', notice);
});

test('updates-upgrade-dialog', async ({ page }, testInfo) => {
  await start(page, updateSetup('deb'));
  const notice = page.getByRole('listitem').filter({ hasText: 'yaggui 0.2.0 is available' });
  await notice.getByRole('button', { name: 'Update', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Updating yaggui to 0.2.0' });
  const screen = dialog.locator('.xterm-rows');
  await expect(screen).toContainText('[sudo] password for me:');
  // The mock's sudo waits for a password: any input finishes the upgrade.
  await page.keyboard.type('secret');
  await page.keyboard.press('Enter');
  await expect(dialog).toContainText('yaggui 0.2.0 is installed. Restart to use it.');
  await expect(screen).toContainText('Setting up yaggui (0.2.0)');
  await capture(page, testInfo, 'updates-upgrade-dialog', dialog);
});

test('updates-whats-new', async ({ page }, testInfo) => {
  await start(page);
  await page
    .locator('footer')
    .getByRole('button', { name: /^yaggui 0\.3\.0/ })
    .click();
  const dialog = page.getByRole('dialog', { name: "What's new" });
  await expect(dialog).toContainText('Installed');
  await capture(page, testInfo, 'updates-whats-new', dialog);
});

// open-a-repository.mdx

test('open-welcome', async ({ page }, testInfo) => {
  await start(page);
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  await expect(page.getByText('Folder not found')).toBeVisible();
  await page.getByRole('option', { name: /^blog\b/ }).hover();
  await capture(page, testInfo, 'open-welcome');
});

test('open-clone-dialog', async ({ page }, testInfo) => {
  await start(page);
  await page.getByRole('button', { name: /^Clone/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Clone a repository' });
  await dialog.getByLabel('Repository address').fill('https://github.com/acme/widget.git');
  await expect(dialog.getByLabel('Clone into')).toHaveValue('/Users/alex/dev');
  await expect(dialog.getByLabel('Folder name')).toHaveValue('widget');
  await dialog.getByRole('switch', { name: /Shallow clone/ }).click();
  await expect(dialog.getByLabel('Depth (commits)')).toBeVisible();
  await dialog.getByRole('switch', { name: /Shallow clone/ }).blur();
  await capture(page, testInfo, 'open-clone-dialog', dialog);
});

test('open-init-dialog', async ({ page }, testInfo) => {
  await start(page);
  await page.getByRole('button', { name: /^Init/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Initialize a repository' });
  await dialog.getByLabel('Folder', { exact: true }).fill('/Users/alex/dev/new-project');
  await expect(dialog.getByLabel('Default branch')).toHaveValue('main');
  await dialog.getByRole('button', { name: 'Node' }).click();
  await dialog.getByRole('button', { name: 'macOS' }).click();
  await dialog.getByRole('switch', { name: /Add a README/ }).click();
  await expect(dialog.getByRole('button', { name: 'macOS' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('switch', { name: /Add a README/ }).blur();
  await capture(page, testInfo, 'open-init-dialog', dialog);
});

// tour.mdx

test('tour-window', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.keyboard.press('Control+T');
  await openRepo(page, /^linux\b/);
  await page.keyboard.press('Control+T');
  await openRepo(page, /^blog\b/);
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
  await page.getByRole('listbox', { name: 'Commit graph' }).getByRole('option').nth(1).click();
  await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();
  await page.mouse.move(640, 790);
  await capture(page, testInfo, 'tour-window');
});

test('tour-command-log', async ({ page }, testInfo) => {
  await openYaggui(page);
  await toolbar(page).getByRole('button', { name: 'Fetch', exact: true }).click();
  await expect(toastWith(page, 'Fetch complete')).toBeVisible();
  await expect(toastWith(page, 'Fetch complete')).toBeHidden({ timeout: 15_000 });
  await page.keyboard.press('Control+J');
  const log = page.getByRole('region', { name: 'Command log' });
  await expect(log).toBeVisible();
  await log.getByRole('button', { name: /git commit -F -/ }).click();
  await expect(log).toContainText('3 files changed, 142 insertions(+)');
  await page.mouse.move(640, 10);
  // With the status bar under it, where its Log button is.
  await capture(
    page,
    testInfo,
    'tour-command-log',
    await around(page, [log, page.locator('footer')]),
  );
});

test('tour-error-toast', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.evaluate(() => window.__yagguiMock?.addOfflineRemote(1));
  await toolbar(page).getByRole('button', { name: 'Fetch', exact: true }).click();
  const toast = toastWith(page, 'Fetch failed');
  await expect(toast.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.mouse.move(640, 400);
  await capture(page, testInfo, 'tour-error-toast', toast);
});

test('tour-banner-lock', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.evaluate(() =>
    window.__yagguiMock?.setRepoState(1, {
      indexLock: { path: '/Users/alex/dev/yaggui/.git/index.lock', ageSecs: 42, stale: true },
    }),
  );
  const message = page.getByText('A Git process probably crashed and left index.lock');
  await expect(page.getByRole('button', { name: 'Remove the lock…' })).toBeVisible();
  const banner = message.locator(
    'xpath=ancestor::*[.//button[normalize-space(.)="Remove the lock…"]][1]',
  );
  await capture(page, testInfo, 'tour-banner-lock', banner);
});
