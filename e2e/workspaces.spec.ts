import { expect, test, type Page } from '@playwright/test';

/** M4-3: workspaces (F-006 to F-009) on the mock backend. */

/** Same fixed "now" as the mock data (src/ipc/mockData.ts), for stable relative times. */
const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`workspaces-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

const section = (page: Page) => page.getByRole('region', { name: 'Workspaces' });
const dialog = (page: Page) => page.getByRole('dialog');
const rows = (page: Page) =>
  dialog(page)
    .getByRole('list', { name: /^Repositories of/ })
    .getByRole('listitem');
const tabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Open repositories' }).getByRole('tab');

async function openOverview(page: Page, name: string) {
  await section(page)
    .getByRole('button', { name: `Overview of ${name}` })
    .click();
  await expect(dialog(page).getByRole('heading', { name })).toBeVisible();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await start(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });

    test('welcome screen lists the workspaces', async ({ page }) => {
      await expect(
        section(page).getByRole('button', { name: /^Open all repositories/ }),
      ).toHaveCount(2);
      await expect(section(page)).toContainText('Personal');
      await expect(section(page)).toContainText('3 repositories');
      await capture(page, theme, 'welcome');
    });

    test('overview shows each repo state and the missing one', async ({ page }) => {
      await openOverview(page, 'Personal');
      await expect(rows(page)).toHaveCount(3);
      const yaggui = rows(page).filter({ hasText: 'yaggui' });
      await expect(yaggui).toContainText('feat/graph-lanes');
      await expect(yaggui).toContainText('↑2');
      await expect(yaggui).toContainText('6 changes');
      await expect(yaggui).toContainText('30 minutes ago');
      const blog = rows(page).filter({ hasText: 'blog' });
      await expect(blog).toContainText('↓4');
      await expect(blog).toContainText('Clean');
      await expect(blog).toContainText('Never');
      await expect(rows(page).filter({ hasText: 'legacy-api' })).toContainText('Folder not found');
      await capture(page, theme, 'overview');
    });

    test('fetch all shows a result per repo', async ({ page }) => {
      await openOverview(page, 'Personal');
      await dialog(page).getByRole('button', { name: 'Fetch all' }).click();
      await expect(rows(page).filter({ hasText: 'yaggui' })).toContainText('Fetching…');
      await expect(
        page.locator('ol > li').filter({ hasText: '2 repositories of Personal fetched' }),
      ).toBeVisible();
      await expect(rows(page).filter({ hasText: 'blog' })).toContainText('now');
      await capture(page, theme, 'fetched');
    });

    test('scan a folder: progress, results, import into a new workspace', async ({ page }) => {
      await page.evaluate(() => {
        if (window.__yagguiMock) window.__yagguiMock.scanner.stepMs = 400;
      });
      await section(page).getByRole('button', { name: 'Scan a folder…' }).click();
      await dialog(page).getByLabel('Folder').fill('/Users/alex/dev');
      await capture(page, theme, 'scan-form');
      await dialog(page).getByRole('button', { name: 'Scan', exact: true }).click();
      await expect(dialog(page).getByRole('progressbar')).toBeVisible();
      await expect(dialog(page)).toContainText(/repositor(y|ies) found/);
      await capture(page, theme, 'scan-running');

      const results = dialog(page).getByRole('group', { name: 'Repositories found' });
      await expect(results.getByRole('checkbox')).toHaveCount(7, { timeout: 10_000 });
      await expect(dialog(page)).toContainText('7 repositories found, 5 new.');
      await expect(results.locator('label').filter({ hasText: 'yaggui' })).toContainText(
        'Already known',
      );
      await results
        .locator('label')
        .filter({ hasText: 'rust-play' })
        .getByRole('checkbox')
        .uncheck();
      await dialog(page).getByLabel('Add to').selectOption({ label: 'New workspace…' });
      await dialog(page).getByLabel('Workspace name').fill('Clients');
      await capture(page, theme, 'scan-results');
      await dialog(page).getByRole('button', { name: 'Import 6 repositories' }).click();

      // The new workspace opens in the workspaces dialog.
      await expect(dialog(page).getByRole('heading', { name: 'Clients' })).toBeVisible();
      await expect(rows(page)).toHaveCount(6);
      await expect(rows(page).filter({ hasText: 'acme-portal' })).toContainText('main');
    });

    test('a moved repo can be located again', async ({ page }) => {
      await page.getByRole('option', { name: /^legacy-api\b/ }).click();
      await expect(dialog(page)).toContainText('legacy-api was moved or deleted');
      await expect(dialog(page)).toContainText('/Users/alex/old/legacy-api');
      await capture(page, theme, 'missing');
      await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/legacy-api'));
      await dialog(page).getByRole('button', { name: 'Locate…' }).click();
      await expect(dialog(page)).toBeHidden();
      await expect(page.getByRole('option', { name: /^legacy-api\b/ })).toContainText(
        '/Users/alex/dev/legacy-api',
      );
      await expect(page.getByRole('option', { name: /^legacy-api\b/ })).not.toContainText(
        'Folder not found',
      );
    });
  });
}

test.describe('workspaces', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test('opening a workspace opens its repos in tabs and reports the missing one', async ({
    page,
  }) => {
    await section(page).getByRole('button', { name: 'Open all repositories of Personal' }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toHaveAccessibleName(/^yaggui/);
    await expect(tabs(page).nth(1)).toHaveAccessibleName(/^blog/);
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
    const toast = page.locator('ol > li').filter({ hasText: '1 repository was not found' });
    await expect(toast).toContainText('legacy-api');
    await toast.getByRole('button', { name: 'Review' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Personal' })).toBeVisible();
  });

  test('create, rename, add a repo, remove it and delete a workspace', async ({ page }) => {
    await section(page).getByRole('button', { name: 'Manage' }).click();
    await dialog(page).getByRole('button', { name: 'New workspace' }).click();
    await dialog(page).getByLabel('Name of the new workspace').fill('personal');
    await dialog(page).getByRole('button', { name: 'Create' }).click();
    // Names are unique, whatever their case.
    await expect(page.locator('ol > li').filter({ hasText: 'already exists' })).toBeVisible();
    await dialog(page).getByLabel('Name of the new workspace').fill('Client X');
    await dialog(page).getByRole('button', { name: 'Create' }).click();
    await expect(dialog(page).getByRole('tab', { name: /Client X/, selected: true })).toBeVisible();
    await expect(dialog(page)).toContainText('This workspace has no repository yet.');
    await capture(page, 'graphite', 'empty');

    await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Add linux' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Rebase in progress');

    await dialog(page).getByRole('button', { name: 'Rename' }).click();
    await dialog(page).getByLabel('Workspace name').fill('Client Y');
    await dialog(page).getByRole('button', { name: 'Rename' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Client Y' })).toBeVisible();

    await dialog(page).getByRole('button', { name: 'Remove linux from the workspace' }).click();
    await expect(rows(page)).toHaveCount(0);

    await dialog(page).getByRole('button', { name: 'Delete workspace' }).click();
    // The confirmation stacks over the workspaces dialog, which is hidden from queries meanwhile.
    await expect(dialog(page)).toContainText('Delete the workspace Client Y?');
    await dialog(page).getByRole('button', { name: 'Delete workspace' }).click();
    await expect(dialog(page).getByRole('tab', { name: /Client Y/ })).toHaveCount(0);
  });

  test('the palette opens the workspaces and the folder scan', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('workspaces');
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('heading', { name: 'Workspaces' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('scan a folder');
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('heading', { name: 'Scan a folder' })).toBeVisible();
  });
});
