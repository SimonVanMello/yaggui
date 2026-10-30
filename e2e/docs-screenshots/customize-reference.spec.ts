import { expect, test, type Page } from '@playwright/test';
import { capture, frenchUi, lang, openRepo, start } from './capture';

/** Docs screenshots of the customize/*, reference/* and help/* pages. */

const prefsDialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

async function openPrefs(page: Page, tab: string) {
  await page.keyboard.press('Control+,');
  const prefs = prefsDialog(page);
  await expect(prefs).toBeVisible();
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: tab, exact: true })
    .click();
  return prefs;
}

async function welcome(page: Page) {
  await start(page);
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

test.describe('customize', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('prefs-appearance', async ({ page }, testInfo) => {
    await welcome(page);
    const prefs = await openPrefs(page, 'Appearance');
    await expect(prefs.locator('[data-theme-id="mocha"]')).toBeVisible();
    await page.mouse.move(0, 0);
    await capture(page, testInfo, 'prefs-appearance', prefs);
  });

  test('prefs-display', async ({ page }, testInfo) => {
    await welcome(page);
    const prefs = await openPrefs(page, 'Display');
    await expect(prefs.getByLabel('Code font')).toBeVisible();
    await capture(page, testInfo, 'prefs-display', prefs);
  });

  test('prefs-search', async ({ page }, testInfo) => {
    await welcome(page);
    await page.keyboard.press('Control+,');
    const prefs = prefsDialog(page);
    await prefs.getByRole('searchbox').fill('pull');
    await expect(prefs.getByRole('heading', { name: 'Results' })).toBeVisible();
    await capture(page, testInfo, 'prefs-search', prefs);
  });

  test('theme-picker', async ({ page }, testInfo) => {
    await welcome(page);
    await openRepo(page);
    await page.keyboard.press('Control+K');
    await page.getByRole('combobox').fill('theme');
    await page.keyboard.press('Enter');
    await page.getByRole('combobox').fill('cat');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('html')).toHaveAttribute('data-theme', /macchiato|frappe/);
    await page.mouse.move(0, 0);
    await capture(page, testInfo, 'theme-picker');
  });

  test('style-terminal', async ({ page }, testInfo) => {
    await welcome(page);
    await openRepo(page);
    const prefs = await openPrefs(page, 'Appearance');
    await prefs.getByRole('radio', { name: 'Terminal' }).click();
    await prefs.locator('[data-theme-id="terminal"]').click();
    await page.keyboard.press('Escape');
    await expect(prefs).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminal');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'terminal');
    await page.mouse.move(0, 0);
    await capture(page, testInfo, 'style-terminal');
  });

  test('palette', async ({ page }, testInfo) => {
    await welcome(page);
    await openRepo(page);
    await page.keyboard.press('Control+K');
    await page.getByRole('combobox', { name: 'Command palette' }).fill('tab');
    const list = page.getByRole('listbox', { name: 'Command palette' });
    await expect(list.locator('[data-kind="commit"]').first()).toBeVisible();
    await capture(page, testInfo, 'palette', page.getByRole('dialog'));
  });

  test('keybindings', async ({ page }, testInfo) => {
    await welcome(page);
    await openRepo(page);
    const prefs = await openPrefs(page, 'Shortcuts');
    await prefs
      .getByRole('button', { name: /Change the shortcut of Fetch/ })
      .first()
      .click();
    await page.keyboard.press('Control+Alt+F');
    await expect(prefs.locator('[data-changed]').first()).toBeVisible();
    await page.mouse.move(0, 0);
    await capture(page, testInfo, 'keybindings', prefs);
  });

  test('keybindings-conflict', async ({ page }, testInfo) => {
    await welcome(page);
    await openRepo(page);
    const prefs = await openPrefs(page, 'Shortcuts');
    const row = prefs.locator('[data-binding-id="tab.close"]');
    await row.getByRole('button', { name: /Change the shortcut of Close tab/ }).click();
    await page.keyboard.press('Control+T');
    await expect(row).toContainText('Already used by: New tab');
    await capture(page, testInfo, 'keybindings-conflict', prefs);
  });

  test('prefs-tools', async ({ page }, testInfo) => {
    await welcome(page);
    const prefs = await openPrefs(page, 'Tools');
    await prefs.getByLabel('Diff tool').fill('meld');
    await prefs.getByLabel('Diff tool').blur();
    await prefs.getByRole('button', { name: 'Test' }).nth(2).click();
    await expect(prefs).toContainText('meld is available');
    await page.mouse.move(0, 0);
    await capture(page, testInfo, 'prefs-tools', prefs);
  });

  test('prefs-git', async ({ page }, testInfo) => {
    await welcome(page);
    const prefs = await openPrefs(page, 'Tools');
    await expect(prefs).toContainText('Git 2.47.1 · /usr/bin/git');
    await capture(page, testInfo, 'prefs-git', prefs);
  });

  test('gitconfig-global', async ({ page }, testInfo) => {
    await welcome(page);
    await openRepo(page);
    const prefs = await openPrefs(page, 'Git configuration');
    await expect(prefs.getByLabel('Name (user.name)')).toHaveValue('Alex Martin');
    await capture(page, testInfo, 'gitconfig-global', prefs);
  });
});

test('error-toast-retry', async ({ page }, testInfo) => {
  await welcome(page);
  await openRepo(page);
  await page.evaluate(() => window.__yagguiMock?.addOfflineRemote(1));
  const fetch = await page
    .getByRole('toolbar', { name: 'Repository actions' })
    .getByRole('button', { name: 'Fetch', exact: true })
    .elementHandle();
  await frenchUi(page);
  await fetch.click();
  const toast = toastWith(page, lang('Fetch failed', 'Fetch a échoué'));
  await expect(toast).toBeVisible();
  // The page shows the Details section collapsed.
  await expect(toast.locator('summary')).toContainText(lang('Details', 'Détails'));
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'error-toast-retry', toast);
});

test('command-log-expanded', async ({ page }, testInfo) => {
  await welcome(page);
  await openRepo(page);
  await page.evaluate(() => window.__yagguiMock?.addOfflineRemote(1));
  await page
    .getByRole('toolbar', { name: 'Repository actions' })
    .getByRole('button', { name: 'Fetch', exact: true })
    .click();
  const toast = toastWith(page, 'Fetch failed');
  await toast.getByRole('button', { name: 'Close' }).click();
  await expect(toast).toBeHidden();
  await page.keyboard.press('Control+J');
  const log = page.getByRole('region', { name: 'Command log' });
  await log.getByRole('button', { name: /git fetch --progress --prune --all/ }).click();
  await expect(log).toContainText('Could not resolve host');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'command-log-expanded', log);
});

test('index-lock-banner', async ({ page }, testInfo) => {
  await welcome(page);
  await openRepo(page);
  await page.evaluate(() =>
    window.__yagguiMock?.setRepoState(1, {
      indexLock: { path: '/Users/alex/dev/yaggui/.git/index.lock', ageSecs: 42, stale: true },
    }),
  );
  const banner = page.getByRole('status').filter({ hasText: 'index.lock' });
  await expect(banner).toContainText('A Git process probably crashed and left index.lock');
  await expect(banner.getByRole('button', { name: 'Remove the lock…' })).toBeVisible();
  await capture(page, testInfo, 'index-lock-banner', banner, { pad: 0 });
});
