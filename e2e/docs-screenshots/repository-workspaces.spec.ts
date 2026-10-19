import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { capture, openRepo, start } from './capture';

/** Docs screenshots of the repository/* and workspaces/* pages. */

const YAGGUI = '/Users/alex/dev/yaggui';

const tree = (page: Page) => page.getByRole('tree');
const dialog = (page: Page) => page.getByRole('dialog');
const terminal = (page: Page) => page.getByRole('region', { name: 'Terminal' });
const workspaces = (page: Page) => page.getByRole('region', { name: 'Workspaces' });

/** Expands a collapsed sidebar section (submodules and worktrees start collapsed). */
async function expand(page: Page, section: 'Submodules' | 'Worktrees') {
  const header = tree(page).getByRole('treeitem', { name: new RegExp(`^${section},`) });
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

async function rowMenu(page: Page, name: RegExp) {
  await tree(page).getByRole('treeitem', { name }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
}

async function runPaletteAction(page: Page, query: string) {
  await page.keyboard.press('Control+K');
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

/** The demo commit of the diff view (`/#diff-demo`); a hash change alone does not reload. */
async function openDiffDemo(page: Page, file: RegExp) {
  await start(page);
  await page.goto('/#diff-demo');
  await page.reload();
  const files = page.getByRole('listbox', { name: /^Commit / });
  await files.getByRole('option', { name: file }).click();
  return { files, diff: page.getByRole('region', { name: /^Diff of / }) };
}

/** Saves a capture of an arbitrary rectangle, for shots spanning several unrelated elements. */
async function captureRect(
  page: Page,
  testInfo: TestInfo,
  name: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `website/src/assets/screens/${name}-${testInfo.project.name}.png`,
    clip: rect,
    animations: 'disabled',
  });
}

test('submodules-sidebar', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page);
  await expand(page, 'Submodules');
  await expand(page, 'Worktrees');
  const codemirror = tree(page).getByRole('treeitem', { name: /vendor\/codemirror/ });
  await expect(codemirror).toContainText('moved');
  await expect(codemirror).toContainText('modified');
  await expect(tree(page).getByRole('treeitem', { name: /^yaggui-spike/ })).toContainText(
    'missing',
  );
  await page.mouse.move(0, 0);
  await capture(
    page,
    testInfo,
    'submodules-sidebar',
    page.getByRole('navigation', { name: 'References' }),
  );
});

test('submodules-menu', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page);
  await expand(page, 'Submodules');
  await rowMenu(page, /vendor\/codemirror/);
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Copy SHA' })).toBeVisible();
  const row = tree(page).getByRole('treeitem', { name: /vendor\/codemirror/ });
  const [menuBox, rowBox] = await Promise.all([menu.boundingBox(), row.boundingBox()]);
  if (!menuBox || !rowBox) throw new Error('submodules-menu: nothing to crop');
  const x = Math.max(0, Math.min(menuBox.x, rowBox.x) - 12);
  const y = Math.max(0, Math.min(menuBox.y, rowBox.y) - 12);
  const right = Math.max(menuBox.x + menuBox.width, rowBox.x + rowBox.width) + 12;
  const bottom = Math.max(menuBox.y + menuBox.height, rowBox.y + rowBox.height) + 12;
  await captureRect(page, testInfo, 'submodules-menu', {
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
});

test('submodule-diff', async ({ page }, testInfo) => {
  const { diff } = await openDiffDemo(page, /codemirror/);
  await expect(diff).toContainText('Submodule commit changed');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'submodule-diff', page.getByRole('main'));
});

test('worktree-create', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page);
  await runPaletteAction(page, 'new worktree');
  await page.getByRole('textbox', { name: 'Name of the new branch' }).fill('feat/blame');
  await expect(page.getByRole('textbox', { name: 'Folder' })).toHaveValue(`${YAGGUI}-feat-blame`);
  await capture(
    page,
    testInfo,
    'worktree-create',
    page.getByRole('dialog', { name: 'New worktree' }),
  );
});

test('worktree-remove', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page);
  await expand(page, 'Worktrees');
  await rowMenu(page, /^yaggui-review/);
  await page.getByRole('menuitem', { name: 'Remove the worktree…' }).click();
  await expect(dialog(page)).toContainText('This worktree has local changes');
  await capture(page, testInfo, 'worktree-remove', dialog(page));
});

test('lfs-diff', async ({ page }, testInfo) => {
  const { files, diff } = await openDiffDemo(page, /hero\.psd/);
  await expect(files.getByRole('option', { name: /hero\.psd/ })).toContainText('LFS');
  await expect(diff).toContainText('Only a pointer is versioned');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'lfs-diff', page.getByRole('main'));
});

test('lfs-track', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page);
  await runPaletteAction(page, 'track a pattern');
  await expect(dialog(page)).toContainText('*.psd');
  await page.getByRole('textbox', { name: 'Pattern' }).fill('*.png');
  await expect(dialog(page)).toContainText('git lfs track -- *.png');
  await capture(page, testInfo, 'lfs-track', dialog(page));
});

test.describe('terminal', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('terminal-panel', async ({ page }, testInfo) => {
    await start(page);
    await openRepo(page);
    await page.getByRole('toolbar').getByRole('button', { name: 'Terminal' }).click();
    const screen = terminal(page).locator('.xterm-rows');
    await expect(screen).toContainText('yaggui $');
    for (const command of ['git status', 'colors']) {
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
    }
    await expect(screen).toContainText('██ ██');
    await terminal(page).getByRole('button', { name: 'New terminal' }).click();
    const tabs = terminal(page).getByRole('tablist', { name: 'Terminals' }).getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await tabs.first().click();
    await expect(screen).toContainText('██ ██');
    await capture(page, testInfo, 'terminal-panel', terminal(page));
  });
});

test('terminal-prefs-tools', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page);
  await page.keyboard.press('Control+,');
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  await prefs.getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(prefs.getByRole('radio', { name: 'Integrated' })).toBeChecked();
  await capture(page, testInfo, 'terminal-prefs-tools', prefs);
});

test('tabs-indicators', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page, /^yaggui\b/);
  await page.keyboard.press('Control+T');
  await openRepo(page, /^linux\b/);
  await page.keyboard.press('Control+T');
  await openRepo(page, /^blog\b/);
  await page.getByRole('tab', { name: /^linux/ }).hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Rebase in progress');
  const box = await tooltip.boundingBox();
  if (!box) throw new Error('tabs-indicators: no tooltip');
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  await captureRect(page, testInfo, 'tabs-indicators', {
    x: 0,
    y: 0,
    width: viewport.width,
    height: Math.min(viewport.height, box.y + box.height + 16),
  });
});

test('workspaces-welcome', async ({ page }, testInfo) => {
  await start(page);
  await expect(workspaces(page)).toContainText('3 repositories');
  await capture(page, testInfo, 'workspaces-welcome', workspaces(page));
});

test('workspace-overview', async ({ page }, testInfo) => {
  await start(page);
  await workspaces(page).getByRole('button', { name: 'Overview of Personal' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Personal' })).toBeVisible();
  await expect(dialog(page)).toContainText('30 minutes ago');
  await capture(page, testInfo, 'workspace-overview', dialog(page));
});

test('workspace-scan-results', async ({ page }, testInfo) => {
  await start(page);
  await workspaces(page).getByRole('button', { name: 'Scan a folder…' }).click();
  await dialog(page).getByLabel('Folder').fill('/Users/alex/dev');
  await dialog(page).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(dialog(page)).toContainText('7 repositories found, 5 new.', { timeout: 15_000 });
  await expect(dialog(page).getByRole('button', { name: 'Import 7 repositories' })).toBeVisible();
  await capture(page, testInfo, 'workspace-scan-results', dialog(page));
});
