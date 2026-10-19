import { expect, test, type Locator, type Page } from '@playwright/test';

import { capture, frenchUi, lang, MOCK_NOW_MS, openRepo, start } from './capture';
import { around } from './crop';

/** Screenshots of the "Everyday work" pages: staging, committing, stash, diff. */

const unstaged = (page: Page) => page.getByRole('listbox', { name: 'Unstaged', exact: true });
/** Row of a file by its full path (the row's title). */
const file = (list: Locator, path: string) =>
  list.getByRole('option').and(list.locator(`[title="${path}"]`));
const summary = (page: Page) => page.getByRole('textbox', { name: 'Commit summary' });
const changesPanel = (page: Page) => page.getByRole('region', { name: 'Local changes' });
const diffView = (page: Page) => page.getByRole('region', { name: /^Diff of / });
const tree = (page: Page) => page.getByRole('tree');

/** The commit area: the closest block holding both the summary and the Commit button. */
const commitArea = (page: Page) =>
  summary(page).locator(
    'xpath=ancestor::div[.//button[starts-with(normalize-space(.), "Commit on")]][1]',
  );

async function expandSection(page: Page, name: string) {
  const section = tree(page).getByRole('treeitem', { name: new RegExp(`^${name}`) });
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click();
}

/** Widens the right panel by `steps` × 16 px, for the commit area shots. */
async function widenRightPanel(page: Page, steps: number) {
  const resizer = page.getByRole('separator', { name: 'Resize the right panel' });
  await resizer.focus();
  for (let i = 0; i < steps; i++) await page.keyboard.press('ArrowLeft');
  await resizer.blur();
}

/** The status bar sits right under the changes panel: hidden so a crop does not cut its text. */
async function hideStatusBar(page: Page) {
  await page.addStyleTag({ content: 'footer { visibility: hidden; }' });
}

async function openYaggui(page: Page) {
  await start(page);
  await openRepo(page);
  await expect(unstaged(page).getByRole('option')).toHaveCount(4);
}

/** `#diff-demo`: the mock's showcase commit. */
async function openDemo(page: Page, name: string) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/#diff-demo');
  await expect(diffView(page)).toBeVisible();
  await page
    .getByRole('listbox', { name: /^Commit / })
    .getByRole('option', { name: new RegExp(name) })
    .click();
  await expect(diffView(page)).toHaveAccessibleName(new RegExp(`${name}$`));
}

// staging.mdx

test('staging-changes-panel', async ({ page }, testInfo) => {
  await openYaggui(page);
  await expect(
    page.getByRole('listbox', { name: 'Staged', exact: true }).getByRole('option'),
  ).toHaveCount(2);
  await hideStatusBar(page);
  await capture(page, testInfo, 'staging-changes-panel', changesPanel(page));
});

test('staging-hover-buttons', async ({ page }, testInfo) => {
  await openYaggui(page);
  const readme = file(unstaged(page), 'README.md');
  await readme.hover();
  await expect(readme.getByRole('button', { name: 'Stage file' })).toBeVisible();
  await capture(page, testInfo, 'staging-hover-buttons', unstaged(page).locator('xpath=..'));
});

test('staging-line-selection', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await openYaggui(page);
  await file(unstaged(page), 'src/features/tabs/TabBar.tsx').click();
  const diff = diffView(page);
  await expect(diff.locator('.yaggui-hunk')).not.toHaveCount(0);
  // Unified: in side by side, a click on a replaced line takes both of its sides.
  await page.getByRole('radio', { name: 'Unified' }).click();
  const added = diff.locator('.yaggui-signs .yaggui-selectable').filter({ hasText: '+' });
  await added.first().click();
  await added.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await expect(diff.getByRole('status')).toHaveText('2 lines selected');
  await page.mouse.move(0, 0);
  await capture(page, testInfo, 'staging-line-selection', diff);
});

test('staging-discard-confirm', async ({ page }, testInfo) => {
  await openYaggui(page);
  const discardAll = await page
    .getByRole('button', { name: 'Discard all changes' })
    .elementHandle();
  await frenchUi(page);
  await discardAll.click();
  const dialog = page.getByRole('dialog', {
    name: lang('Discard all unstaged changes?', 'Annuler tous les changements non indexés ?'),
  });
  await expect(dialog).toBeVisible();
  await capture(page, testInfo, 'staging-discard-confirm', dialog);
});

test('staging-gitignore-dialog', async ({ page }, testInfo) => {
  await openYaggui(page);
  await file(unstaged(page), 'notes/todo.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to .gitignore…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to .gitignore' });
  await dialog.getByRole('radio', { name: 'Its folder' }).check();
  await expect(dialog.getByLabel('Rule added')).toHaveText('/notes/');
  await capture(page, testInfo, 'staging-gitignore-dialog', dialog);
});

// committing.mdx

test('commit-area', async ({ page }, testInfo) => {
  await openYaggui(page);
  await widenRightPanel(page, 5);
  await hideStatusBar(page);
  await summary(page).fill('fix(graph): keep lanes stable while scrolling');
  await page
    .getByRole('textbox', { name: 'Description' })
    .fill('Lane indexes are kept across pages,\nso a branch no longer jumps when scrolling.');
  await expect(page.getByText('Signed · SSH')).toBeVisible();
  await page.getByRole('textbox', { name: 'Description' }).blur();
  await capture(page, testInfo, 'commit-area', commitArea(page));
});

test('commit-hook-failed', async ({ page }, testInfo) => {
  await openYaggui(page);
  await widenRightPanel(page, 5);
  await hideStatusBar(page);
  await summary(page).fill('wip [hook-fail]');
  await summary(page).press('ControlOrMeta+Enter');
  const panel = changesPanel(page).getByRole('alert').filter({ hasText: 'rejected the commit' });
  await expect(panel.getByRole('button', { name: 'Copy output' })).toBeVisible();
  await capture(page, testInfo, 'commit-hook-failed', panel);
});

test('commit-conventional', async ({ page }, testInfo) => {
  await openYaggui(page);
  await widenRightPanel(page, 5);
  await hideStatusBar(page);
  await page.getByRole('button', { name: 'Conventional' }).click();
  const header = page.getByRole('group', { name: 'Conventional Commits header' });
  await header.getByRole('combobox', { name: 'Type' }).selectOption('feat');
  await header.getByRole('combobox', { name: 'scope' }).fill('graph');
  await summary(page).focus();
  await page.keyboard.press('End');
  await page.keyboard.type('keep lanes stable while scrolling');
  await expect(summary(page)).toHaveValue('feat(graph): keep lanes stable while scrolling');
  await summary(page).blur();
  await capture(page, testInfo, 'commit-conventional', commitArea(page));
});

// stash.mdx

test('stash-popover', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.keyboard.press('Control+Shift+S');
  const popover = page.getByRole('form', { name: 'Stash changes' });
  await expect(popover).toBeVisible();
  const button = page
    .getByRole('toolbar', { name: 'Repository actions' })
    .getByRole('button', { name: 'Stash', exact: true });
  await capture(page, testInfo, 'stash-popover', await around(page, [popover, button]));
});

test('stash-files-dialog', async ({ page }, testInfo) => {
  await openYaggui(page);
  await file(unstaged(page), 'README.md').click();
  await file(unstaged(page), 'src/ui/Icon.tsx').click({ modifiers: ['ControlOrMeta'] });
  await file(unstaged(page), 'src/ui/Icon.tsx').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stash 2 files…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stash 2 files' });
  await dialog.getByLabel('Message').fill('icons and readme');
  await capture(page, testInfo, 'stash-files-dialog', dialog);
});

test('stash-preview', async ({ page }, testInfo) => {
  await openYaggui(page);
  await hideStatusBar(page);
  await expandSection(page, 'Stashes');
  await tree(page).getByRole('treeitem', { name: 'lanes', exact: true }).click();
  const details = page.getByRole('region', { name: 'Stash details' });
  await expect(details).toBeVisible();
  await page.mouse.move(0, 0);
  // The file list scrolls past 360 px: the crop stops under it, not at the bottom of the panel.
  const crop = await around(page, [
    details.getByText('WIP on feat/graph-lanes: lanes', { exact: true }),
    details.getByRole('listbox'),
  ]);
  await capture(page, testInfo, 'stash-preview', crop);
});

test('stash-conflict', async ({ page }, testInfo) => {
  await openYaggui(page);
  await page.keyboard.press('Control+Shift+S');
  const popover = page.getByRole('form', { name: 'Stash changes' });
  await popover.getByLabel('Message (optional)').fill('conflict demo');
  await popover.getByRole('button', { name: 'Stash', exact: true }).click();
  await expect(page.getByText('Changes stashed', { exact: true })).toBeVisible();
  await expandSection(page, 'Stashes');
  await tree(page)
    .getByRole('treeitem', { name: /conflict demo/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Apply', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'The stash conflicts' });
  await expect(dialog).toBeVisible();
  await capture(page, testInfo, 'stash-conflict', dialog);
});

// diff.mdx

test('diff-split', async ({ page }, testInfo) => {
  await openDemo(page, 'TabBar.tsx');
  await expect(page.getByRole('radio', { name: 'Side by side' })).toBeChecked();
  await expect(page.locator('.cm-editor')).toHaveCount(2);
  await capture(page, testInfo, 'diff-split', diffView(page));
});

test('diff-image-onion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  await openDemo(page, 'screenshot.png');
  await page.getByRole('radio', { name: 'Onion skin' }).click();
  await expect(page.getByRole('slider', { name: /Opacity/ })).toBeVisible();
  await capture(page, testInfo, 'diff-image-onion', diffView(page));
});

test('diff-markdown-preview', async ({ page }, testInfo) => {
  await openDemo(page, 'guide.md');
  await page.getByRole('radio', { name: 'Preview' }).click();
  const doc = page.getByRole('article', { name: 'Rendered document with its changes' });
  await expect(doc.locator('ins').filter({ hasText: 'Windows,' })).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByText(/^Change 1 \/ \d+$/)).toBeVisible();
  await page.getByRole('radio', { name: 'Preview' }).blur();
  await capture(page, testInfo, 'diff-markdown-preview', diffView(page));
});
