import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { capture, openRepo, start } from './capture';

/** Docs screenshots: commit graph, branches, tags, compare and history operations. */

const graph = (page: Page) => page.getByRole('listbox', { name: 'Commit graph' });
const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const tree = (page: Page) => page.getByRole('tree');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });
const details = (page: Page) => page.getByRole('region', { name: 'Commit details' });
const banner = (page: Page) => page.getByRole('status', { name: 'Operation in progress' });
const conflictsPanel = (page: Page) => page.getByRole('region', { name: 'Conflicts' });

/** The local branch row (a remote branch of the same name comes later in the tree). */
const branchRow = (page: Page, name: RegExp) => tree(page).getByRole('treeitem', { name }).first();

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
 * invisible fixed element; `adjust` can move its edges (e.g. to keep a neighbouring panel out).
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
  const frame = page.locator('#docs-screenshot-frame');
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
  await capture(page, testInfo, name, frame);
}

async function stopOn(page: Page, kind: 'merge' | 'rebase') {
  await openYaggui(page);
  await page.evaluate(
    (k) =>
      window.__yagguiMock?.simulateOperation(
        1,
        k,
        k === 'rebase' ? { step: 3, total: 7, stopsAgain: 0 } : undefined,
      ),
    kind,
  );
  await expect(banner(page)).toBeVisible();
}

async function openConflict(page: Page, path: string) {
  await page.getByRole('button', { name: 'Show conflicts' }).first().click();
  await conflictsPanel(page)
    .getByRole('listitem')
    .filter({ has: page.locator(`[title="${path}"]`) })
    .getByRole('button', { name: 'Resolve…' })
    .click();
  await expect(page.locator(`[data-view="conflict:${path}"]`)).toBeVisible();
}

async function collapse(page: Page, item: Locator) {
  await item.click();
  if ((await item.getAttribute('aria-expanded')) === 'true') await page.keyboard.press('ArrowLeft');
  await expect(item).toHaveAttribute('aria-expanded', 'false');
}

async function createBranch(page: Page, name: string) {
  await toolbar(page).getByRole('button', { name: 'Branch', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Branch name').fill(name);
  await dialog.getByLabel('Check it out after creating it').uncheck();
  await dialog.getByRole('button', { name: 'Create branch' }).click();
  await expect(dialog).toHaveCount(0);
}

test('graph-overview', async ({ page }, testInfo) => {
  await openYaggui(page);
  await graph(page).getByRole('option').nth(2).click();
  await expect(details(page)).toBeVisible();
  await expect(page.getByRole('listbox', { name: /^Commit [0-9a-f]{7}$/ })).toBeVisible();
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'graph-overview');
});

test('graph-commit-details', async ({ page }, testInfo) => {
  await openYaggui(page);
  const badge = details(page).getByText(/^(Verified|Signed, not verified) \((SSH|GPG)\)$/);
  for (let row = 1; row < 40; row++) {
    await graphRow(page, row).click();
    await expect(details(page).getByRole('heading')).toBeVisible();
    if ((await details(page).getByText('Signature', { exact: false }).count()) > 0) break;
  }
  await expect(badge).toBeVisible();
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'graph-commit-details', details(page));
});

test('sidebar-refs', async ({ page }, testInfo) => {
  await openYaggui(page);
  // Fold the local `refactor/` folder and the `origin` remote so every section fits.
  await collapse(
    page,
    tree(page)
      .getByRole('treeitem', { name: /^refactor\b/ })
      .first(),
  );
  await collapse(
    page,
    tree(page)
      .getByRole('treeitem', { name: /^origin\b/ })
      .first(),
  );
  await page.mouse.move(0, 0);
  await capture(
    page,
    testInfo,
    'sidebar-refs',
    page.getByRole('navigation', { name: 'References' }),
  );
});

test('branch-dirty-checkout', async ({ page }, testInfo) => {
  await openYaggui(page);
  await branchRow(page, /^stale-review/).dblclick();
  const dialog = page.getByRole('dialog', { name: /Local changes in the way/ });
  await expect(dialog).toContainText('fix/stale-review');
  await capture(page, testInfo, 'branch-dirty-checkout', dialog);
});

test('branch-cleanup', async ({ page }, testInfo) => {
  await openYaggui(page);
  await palette(page, 'Clean up merged');
  const dialog = page.getByRole('dialog', { name: 'Clean up branches' });
  await expect(dialog).toContainText('Checked out, left alone: feat/graph-lanes');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'branch-cleanup', dialog);
});

test('tag-create', async ({ page }, testInfo) => {
  await openYaggui(page);
  await toolbar(page).getByRole('button', { name: 'Tag', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a tag' });
  await dialog.getByLabel('Tag name').fill('v1.0.0');
  await dialog.getByLabel('Message (optional)').fill('First stable release');
  await expect(dialog).toContainText('This name is available.');
  await capture(page, testInfo, 'tag-create', dialog);
});

test('tag-checkout', async ({ page }, testInfo) => {
  await openYaggui(page);
  await tree(page).getByRole('treeitem', { name: /^Tags/ }).click();
  await tree(page).getByRole('treeitem', { name: /^v\d/ }).first().dblclick();
  const dialog = page.getByRole('dialog', { name: /^Check out the tag/ });
  await expect(dialog.getByLabel('Branch name')).toHaveValue(/-branch$/);
  await expect(dialog.getByRole('status').first()).toContainText('available');
  await capture(page, testInfo, 'tag-checkout', dialog);
});

test('compare-branches-dialog', async ({ page }, testInfo) => {
  await openYaggui(page);
  await branchRow(page, /^main\b/).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compare with…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare two branches' });
  await expect(dialog.getByRole('button', { name: 'Compare', exact: true })).toBeEnabled();
  await capture(page, testInfo, 'compare-branches-dialog', dialog);
});

test('compare-panel', async ({ page }, testInfo) => {
  await openYaggui(page);
  // Few commits on one side, more on the other: both "Only in" sections show.
  await branchRow(page, /^watcher-39\b/).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Compare with feat/graph-lanes' }).click();
  const panel = page.getByRole('region', { name: 'Comparison' });
  await expect(panel).toContainText('Merge-base:');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'compare-panel', panel);
});

test('history-drop-menu', async ({ page }, testInfo) => {
  await openYaggui(page);
  const source = branchRow(page, /^develop/);
  const target = branchRow(page, /^main\b/);
  await source.hover();
  await page.mouse.down();
  const box = await target.boundingBox();
  if (!box) throw new Error('no drop target');
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 8 });
  await expect(target).toHaveAttribute('data-drop-over', 'true');
  await page.mouse.up();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Merge develop into main/ })).toBeVisible();
  // The tree is aria-hidden behind the menu: reach it by its role attribute.
  await captureUnion(
    page,
    testInfo,
    'history-drop-menu',
    [menu, page.locator('[role="tree"]')],
    (edges) => ({ ...edges, bottom: Math.min(edges.bottom, box.y + 260) }),
  );
});

test('history-merge-dialog', async ({ page }, testInfo) => {
  await openYaggui(page);
  await palette(page, 'Merge a branch');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Branch to merge').selectOption('main');
  await dialog.getByRole('radio', { name: 'Always create a merge commit' }).click();
  await expect(dialog.getByLabel('Commit message')).toBeVisible();
  await capture(page, testInfo, 'history-merge-dialog', dialog);
});

test('history-selection-bar', async ({ page }, testInfo) => {
  await openYaggui(page);
  await graphRow(page, 2).click();
  await graphRow(page, 5).click({ modifiers: ['ControlOrMeta'] });
  await graphRow(page, 8).click({ modifiers: ['Shift'] });
  const selection = page.getByRole('region', { name: 'Selection' });
  await expect(selection).toContainText('4 commits selected');
  await page.mouse.move(0, 0);
  await captureUnion(
    page,
    testInfo,
    'history-selection-bar',
    [graph(page).getByText('Work in progress'), graphRow(page, 0), selection],
    // Keep the sidebar out of the left margin.
    (edges) => ({ ...edges, left: edges.left + 12 }),
  );
});

test('history-parent-dialog', async ({ page }, testInfo) => {
  await openYaggui(page);
  await graph(page).focus();
  await page.keyboard.press('Control+f');
  await page.keyboard.type('Merge branch');
  const row = page.locator('[data-row][aria-selected="true"]');
  await expect(row).toContainText('Merge branch');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Revert this commit' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /Parent 1/ })).toBeChecked();
  await expect(dialog.getByText('Reading the merge…')).toHaveCount(0);
  await capture(page, testInfo, 'history-parent-dialog', dialog);
});

test('rebase-todo', async ({ page }, testInfo) => {
  await start(page);
  await openRepo(page, /^blog\b/);
  await expect(graph(page)).toBeVisible();
  await palette(page, 'interactive rebase');
  const picker = page.getByRole('listbox', { name: 'Latest commits of the branch' });
  await picker
    .getByRole('option')
    .filter({ hasText: /(?<!\d)6 commits above/ })
    .click();
  const todo = page.getByRole('listbox', { name: /^Commits to rebase/ });
  await expect(todo.getByRole('option')).toHaveCount(6);
  await todo.focus();
  for (const key of ['r', 'ArrowDown', 's', 'ArrowDown', 'f', 'ArrowDown', 'd', 'ArrowDown', 'e']) {
    await page.keyboard.press(key);
  }
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'rebase-todo');
});

test('conflicts-banner', async ({ page }, testInfo) => {
  await stopOn(page, 'rebase');
  await expect(banner(page)).toContainText('Rebase 3/7');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'conflicts-banner', banner(page), { pad: 0 });
});

test('conflicts-merge-editor', async ({ page }, testInfo) => {
  await stopOn(page, 'merge');
  await openConflict(page, 'src/app/App.tsx');
  await expect(page.locator('.cm-editor')).toHaveCount(3);
  await page
    .getByRole('checkbox', { name: /^Keep conflict 1 from / })
    .first()
    .check();
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'conflicts-merge-editor');
});

test('conflicts-choice-binary', async ({ page }, testInfo) => {
  await stopOn(page, 'merge');
  await openConflict(page, 'assets/logo.png');
  await expect(page.getByRole('img', { name: 'Preview of assets/logo.png' })).toHaveCount(2);
  await page.mouse.move(0, 0);
  const view = page.getByRole('region', { name: 'Conflict in assets/logo.png' });
  const button = await view
    .getByRole('button', { name: /version$/ })
    .last()
    .boundingBox();
  if (!button) throw new Error('no take button');
  // The view is taller than its content: stop just below the cards.
  await captureUnion(page, testInfo, 'conflicts-choice-binary', [view], (edges) => ({
    left: edges.left + 12,
    top: edges.top + 12,
    right: edges.right - 12,
    bottom: button.y + button.height + 24,
  }));
});

test('undo-history', async ({ page }, testInfo) => {
  await openYaggui(page);
  await createBranch(page, 'qa-undo-1');
  await createBranch(page, 'qa-undo-2');
  await page.keyboard.press('Control+z');
  await expect(
    page.getByText('Undone: creation of branch qa-undo-2', { exact: true }),
  ).toBeVisible();
  await toolbar(page).getByRole('button', { name: 'Operation history' }).click();
  const history = page.getByRole('region', { name: 'Session history' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await captureUnion(page, testInfo, 'undo-history', [
    history,
    toolbar(page).getByRole('button', { name: /^(Undo|Cannot)/ }),
    toolbar(page).getByRole('button', { name: /^Redo/ }),
  ]);
});

/** Taller window: these views do not fit 800 px. */
test.describe(() => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('history-reset-hard', async ({ page }, testInfo) => {
    await openYaggui(page);
    await graphRow(page, 3).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Reset .* to here/ }).hover();
    await page.getByRole('menuitem', { name: /^Hard/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('list', { name: /lose their local content/ })).toBeVisible();
    await capture(page, testInfo, 'history-reset-hard', dialog);
  });
});

/** The conflicts list shares the right column with the local changes: give it room. */
test.describe(() => {
  test.use({ viewport: { width: 1280, height: 1200 } });

  test('conflicts-panel', async ({ page }, testInfo) => {
    await stopOn(page, 'merge');
    await page.getByRole('button', { name: 'Show conflicts' }).first().click();
    await expect(conflictsPanel(page)).toContainText('4 unresolved of 4');
    await page.mouse.move(0, 0);
    await capture(page, testInfo, 'conflicts-panel', conflictsPanel(page));
  });
});
