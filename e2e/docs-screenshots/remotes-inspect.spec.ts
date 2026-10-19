import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { capture, openRepo, start } from './capture';

/** Docs screenshots: remotes (fetch, pull, push, manage) and inspect (file history, blame, reflog). */

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const tree = (page: Page) => page.getByRole('tree');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });
const details = (page: Page) => page.getByRole('region', { name: 'Commit details' });

async function openYaggui(page: Page) {
  await start(page);
  await openRepo(page);
  await expect(graphRow(page, 0)).toBeVisible();
}

async function palette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+K');
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Captures the smallest rectangle around all `targets` (plus the helper's margin), through an
 * invisible fixed element; `adjust` can move its edges.
 */
async function captureUnion(
  page: Page,
  testInfo: TestInfo,
  name: string,
  targets: Locator[],
  adjust: (edges: Edges) => Edges = (edges) => edges,
) {
  const boxes = await Promise.all(targets.map((target) => target.boundingBox()));
  const visible = boxes.filter((box) => box !== null);
  if (visible.length === 0) throw new Error(`${name}: no crop target is visible`);
  const { left, top, right, bottom } = adjust({
    left: Math.min(...visible.map((b) => b.x)),
    top: Math.min(...visible.map((b) => b.y)),
    right: Math.max(...visible.map((b) => b.x + b.width)),
    bottom: Math.max(...visible.map((b) => b.y + b.height)),
  });
  await page.evaluate(
    ({ x, y, w, h }) => {
      const el = document.createElement('div');
      el.id = 'docs-screenshot-frame';
      Object.assign(el.style, {
        position: 'fixed',
        left: `${String(x)}px`,
        top: `${String(y)}px`,
        width: `${String(w)}px`,
        height: `${String(h)}px`,
        pointerEvents: 'none',
      });
      document.body.appendChild(el);
    },
    { x: left, y: top, w: right - left, h: bottom - top },
  );
  await capture(page, testInfo, name, page.locator('#docs-screenshot-frame'));
}

/** Right-clicks a file of the third commit and picks `action` in its menu. */
async function commitFileAction(page: Page, path: RegExp, action: RegExp) {
  await graphRow(page, 2).click();
  await details(page).getByRole('option', { name: path }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action }).click();
}

async function openReflog(page: Page) {
  await openYaggui(page);
  await palette(page, 'reflog');
  const view = page.getByRole('region', { name: 'Reflog' });
  const entries = view.getByRole('listbox', { name: /^Positions of the reference/ });
  await expect(entries.getByText('commit gone')).toBeVisible();
  await entries.getByRole('option').nth(2).click();
  const bar = view.getByLabel('Selected entry');
  await expect(bar).toContainText('HEAD@{2}');
  return { view, bar };
}

test('pull-strategy-menu', async ({ page }, testInfo) => {
  await openYaggui(page);
  const split = toolbar(page).getByRole('button', { name: 'Pull strategy' });
  await split.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Fast-forward only/ })).toContainText('default');
  await captureUnion(page, testInfo, 'pull-strategy-menu', [
    // The toolbar is aria-hidden behind the menu: reach the split button by its label.
    page.locator('[role="toolbar"] [aria-label="Pull strategy"]'),
    page.locator('[role="toolbar"] [aria-label^="Pull"]').first(),
    menu,
  ]);
});

test('force-push-confirm', async ({ page }, testInfo) => {
  await openYaggui(page);
  await toolbar(page).getByRole('button', { name: 'Push options' }).click();
  await page.getByRole('menuitem', { name: /Force push/ }).click();
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(dialog).toContainText('Overwrite origin/feat/graph-lanes?');
  await expect(dialog).toContainText('--force-with-lease');
  await capture(page, testInfo, 'force-push-confirm', dialog);
});

test('network-progress', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.evaluate(() => window.__yagguiMock?.simulateOp(1, { kind: 'push', stepMs: 3000 }));
  const footer = page.locator('footer');
  const status = footer.getByRole('status');
  await expect(status).toContainText('Receiving objects', { timeout: 15_000 });
  await expect(status).toContainText('/s');
  await captureUnion(page, testInfo, 'network-progress', [footer, status], (edges) => ({
    ...edges,
    right: Math.min(edges.right, edges.left + 720),
  }));
});

test('remotes-manage', async ({ page }, testInfo) => {
  await openYaggui(page);
  await palette(page, 'Manage remotes');
  const dialog = page.getByRole('dialog', { name: 'Remotes' });
  await expect(dialog.getByRole('list', { name: 'Remotes' })).toContainText('origin');
  await capture(page, testInfo, 'remotes-manage', dialog);
});

test('remote-add-dialog', async ({ page }, testInfo) => {
  await openYaggui(page);
  await tree(page)
    .getByRole('treeitem', { name: /^Remote/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add a remote…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a remote' });
  await dialog.getByLabel('Name').fill('fork');
  await expect(dialog.getByRole('status').first()).toContainText('This name is available.');
  await dialog.getByLabel('Fetch URL').fill('https://github.com/me/yaggui.git');
  await dialog.getByLabel('Push to a different URL').check();
  await dialog.getByLabel('Push URL').fill('git@github.com:me/yaggui.git');
  await expect(dialog.getByLabel('Fetch it once added')).toBeChecked();
  await capture(page, testInfo, 'remote-add-dialog', dialog);
});

test('remote-remove-confirm', async ({ page }, testInfo) => {
  await openYaggui(page);
  await tree(page)
    .getByRole('treeitem', { name: /^origin\b/ })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove the remote…' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(confirm).toContainText('Remove the remote origin?');
  await expect(confirm).toContainText('git remote remove -- origin');
  await capture(page, testInfo, 'remote-remove-confirm', confirm);
});

test('file-history', async ({ page }, testInfo) => {
  await openYaggui(page);
  await commitFileAction(page, /\bGraphCanvas\.tsx\b/, /^File history$/);
  const view = page.getByRole('region', { name: /^History of src\/features\/graph/ });
  const commits = view.getByRole('listbox', { name: 'Commits that changed the file' });
  await expect(commits.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(view.locator('.cm-editor').first()).toBeVisible();
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'file-history', view);
});

test('blame', async ({ page }, testInfo) => {
  await openYaggui(page);
  await commitFileAction(page, / layout\.ts /, /^Blame at this commit$/);
  const view = page.getByRole('region', { name: /^Blame of / });
  const lines = view.getByRole('grid');
  await expect(lines.getByRole('row').first()).toBeVisible();
  await lines.getByRole('row').nth(4).click();
  await expect(view.getByLabel('Selected commit')).toBeVisible();
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'blame', view);
});

test('reflog', async ({ page }, testInfo) => {
  const { view } = await openReflog(page);
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'reflog', view);
});

test('reflog-reset', async ({ page }, testInfo) => {
  const { bar } = await openReflog(page);
  await bar.getByRole('button', { name: /^Reset .* here/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('HEAD@{2}');
  await dialog.getByRole('radio', { name: /^Hard/ }).click();
  await capture(page, testInfo, 'reflog-reset', dialog);
});
