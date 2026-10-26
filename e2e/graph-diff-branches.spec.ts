import { expect, test, type Page } from '@playwright/test';

/**
 * M4-7b: hide / solo a branch, compare two commits or two branches, merge-base jump, image
 * diff, explicit mode / line ending changes, external tools, branch cleanup, Gravatar opt-in,
 * on the mock backend.
 */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
}

const tree = (page: Page) => page.getByRole('tree');
/** The local branch row (a remote branch of the same name comes later in the tree). */
const branchRow = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name.replace('/', '\\/')}\\b`) })
    .first();
const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const filterBar = (page: Page) => page.getByRole('status', { name: 'Graph filter' });
const comparePanel = (page: Page) => page.getByRole('region', { name: 'Comparison' });
const diffView = (page: Page) => page.getByRole('region', { name: /^Diff of / });

async function menuOn(page: Page, name: string, item: string | RegExp) {
  await branchRow(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('hide and solo a branch, then show everything', async ({ page }) => {
      await openRepo(page);
      await expect(graphRow(page, 0)).toBeVisible();
      await menuOn(page, 'main', 'Hide from the graph');
      await expect(filterBar(page)).toContainText('1 ref hidden: main');
      await expect(branchRow(page, 'main').getByLabel('Hidden from the graph')).toBeVisible();
      await capture(page, theme, 'graph-hidden');

      await menuOn(page, 'main', 'Show only this branch');
      await expect(filterBar(page)).toContainText('Only main');
      await expect(branchRow(page, 'main').getByLabel(/Only this branch/)).toBeVisible();
      await capture(page, theme, 'graph-solo');

      // Kept per repository: still there after a reload.
      await page.reload();
      await page.getByRole('tab', { name: /^yaggui\b/ }).click();
      await expect(filterBar(page)).toContainText('Only main');

      await filterBar(page).getByRole('button', { name: 'Show all' }).click();
      await expect(filterBar(page)).toHaveCount(0);
    });

    test('compare two commits, their changes and an image diff', async ({ page }) => {
      await openRepo(page);
      await graphRow(page, 1).click();
      await graphRow(page, 4).click({ modifiers: ['ControlOrMeta'] });
      const bar = page.getByRole('region', { name: 'Selection' });
      await bar.getByRole('button', { name: 'Compare' }).click();
      await expect(comparePanel(page)).toBeVisible();
      await expect(
        comparePanel(page)
          .getByRole('heading', { name: /^Only in / })
          .first(),
      ).toBeVisible();
      await capture(page, theme, 'compare-commits');

      await comparePanel(page).getByRole('radio', { name: 'Changes' }).click();
      await comparePanel(page)
        .getByRole('option', { name: /screenshot\.png/ })
        .click();
      await expect(diffView(page)).toBeVisible();
      await expect(page.getByRole('img', { name: /^Before:/ })).toBeVisible();
      await expect(page.getByRole('img', { name: /^After:/ })).toBeVisible();
      await capture(page, theme, 'image-side');
      await page.getByRole('radio', { name: 'Onion skin' }).click();
      await expect(page.getByRole('slider', { name: /Opacity/ })).toBeVisible();
      await capture(page, theme, 'image-onion');
      await page.getByRole('radio', { name: 'Swipe' }).click();
      await page.getByRole('slider', { name: /divider/ }).fill('30');
      await capture(page, theme, 'image-swipe');

      await comparePanel(page).getByRole('button', { name: 'Close the comparison' }).click();
      await expect(comparePanel(page)).toHaveCount(0);
    });

    test('jump to the merge-base of two commits', async ({ page }) => {
      await openRepo(page);
      await graphRow(page, 1).click();
      await graphRow(page, 4).click({ modifiers: ['ControlOrMeta'] });
      await page
        .getByRole('region', { name: 'Selection' })
        .getByRole('button', { name: 'Merge-base' })
        .click();
      await expect(page.getByRole('region', { name: 'Selection' })).toHaveCount(0);
      await expect(page.locator('[data-row][aria-selected="true"]')).toHaveCount(1);
    });

    test('compare a branch with the current one', async ({ page }) => {
      await openRepo(page);
      await menuOn(page, 'main', 'Compare with feat/graph-lanes');
      await expect(comparePanel(page)).toContainText('main');
      await expect(comparePanel(page)).toContainText('feat/graph-lanes');
      await expect(comparePanel(page)).toContainText('Merge-base:');
      await capture(page, theme, 'compare-branches');
    });

    test('clean up merged and gone branches', async ({ page }) => {
      await openRepo(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('Clean up merged');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Clean up branches' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Checked out, left alone: feat/graph-lanes');
      await expect(dialog).toContainText('Local only');
      await capture(page, theme, 'cleanup-dialog');
      const confirm = dialog.getByRole('button', { name: /^Delete \d+ branch/ });
      const label = (await confirm.textContent()) ?? '';
      const count = Number(/\d+/.exec(label)?.[0] ?? '0');
      expect(count).toBeGreaterThan(0);
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByText(new RegExp(`^${String(count)} branch(es)? deleted`)),
      ).toBeVisible();
    });

    test('a mode-only change and hidden line endings are explained', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/#diff-demo');
      const list = page.getByRole('listbox', { name: /^Commit / });
      await list.getByRole('option', { name: /release\.sh/ }).click();
      await expect(page.getByText('Only the file mode changed')).toBeVisible();
      await expect(page.getByText('100644 → 100755: the content is the same.')).toBeVisible();
      await capture(page, theme, 'diff-mode-only');

      await list.getByRole('option', { name: /install\.bat/ }).click();
      await page.getByRole('button', { name: 'Diff options' }).click();
      await page.getByRole('menuitemcheckbox', { name: /Ignore whitespace/ }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByText('Only the line endings changed')).toBeVisible();
      await capture(page, theme, 'diff-eol-only');
      await page.getByRole('button', { name: 'Show whitespace changes' }).click();
      await expect(page.getByText(/Line endings changed: LF → CRLF/)).toBeVisible();
    });

    test('external diff tool without one configured', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/#diff-demo');
      await page
        .getByRole('listbox', { name: /^Commit / })
        .getByRole('option', { name: /diff\.md/ })
        .click();
      await page.getByRole('button', { name: 'Open outside yaggui' }).click();
      await expect(page.getByRole('menuitem', { name: 'Show in the file manager' })).toBeVisible();
      await capture(page, theme, 'diff-external-menu');
      await page.getByRole('menuitem', { name: 'Open in the external diff tool' }).click();
      await expect(page.getByText('No external diff tool is configured').first()).toBeVisible();
    });

    test('Gravatar is opt-in: no request until enabled, cache can be cleared', async ({ page }) => {
      // The webview never talks to Gravatar itself: the backend downloads and caches.
      const remote: string[] = [];
      await page.route('https://www.gravatar.com/**', (route) => {
        remote.push(route.request().url());
        return route.abort();
      });
      const asked = () => page.evaluate(() => window.__yagguiMock?.avatarRequests.length ?? -1);
      await openRepo(page);
      await expect(graphRow(page, 0)).toBeVisible();
      expect(await asked()).toBe(0);

      await page.keyboard.press('Control+,');
      const prefs = page.getByRole('dialog', { name: 'Preferences' });
      await prefs.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await expect(prefs.getByRole('switch', { name: /Gravatar avatars/ })).not.toBeChecked();
      await capture(page, theme, 'prefs-gravatar');
      await prefs.getByRole('switch', { name: /Gravatar avatars/ }).click();
      await expect.poll(asked).toBeGreaterThan(0);
      // Hashes only, and the pictures come back as data URLs.
      const hashes = await page.evaluate(() => window.__yagguiMock?.avatarRequests ?? []);
      for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(page.locator('[data-row] img[src^="data:image/"]').first()).toBeAttached();

      const clear = prefs.getByRole('button', { name: 'Clear the avatar cache' });
      await clear.scrollIntoViewIfNeeded();
      await expect(clear).toBeVisible();
      await capture(page, theme, 'prefs-gravatar-clear');
      const before = await asked();
      await clear.click();
      await expect(page.getByText('Avatar cache cleared').first()).toBeVisible();
      await expect.poll(asked).toBeGreaterThan(before);
      expect(remote).toEqual([]);
    });
  });
}

test.describe('terminal style, high contrast', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('filter bar, comparison and image diff', async ({ page }) => {
    await openRepo(page);
    await page.keyboard.press('Control+,');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await prefs.getByRole('radio', { name: 'Terminal' }).click();
    await prefs.getByRole('switch', { name: /High contrast/ }).click();
    await page.keyboard.press('Escape');
    await menuOn(page, 'main', 'Hide from the graph');
    await expect(filterBar(page)).toBeVisible();
    await graphRow(page, 1).click();
    await graphRow(page, 4).click({ modifiers: ['ControlOrMeta'] });
    await page
      .getByRole('region', { name: 'Selection' })
      .getByRole('button', { name: 'Compare' })
      .click();
    await comparePanel(page).getByRole('radio', { name: 'Changes' }).click();
    await comparePanel(page)
      .getByRole('option', { name: /screenshot\.png/ })
      .click();
    await expect(page.getByRole('img', { name: /^After:/ })).toBeVisible();
    await capture(page, 'terminal-contrast', 'image-side');
  });
});

test.describe('virtualized lists in compact density', () => {
  test.use({ locale: 'en-US' });

  /** Offsets of the first virtual rows of `list` from its content box, with their heights. */
  const layout = (list: ReturnType<Page['locator']>, count: number) =>
    list.evaluate((el, n) => {
      const inner = el.querySelector('[style*="height"]');
      const top = inner?.getBoundingClientRect().top ?? 0;
      return [...(inner?.children ?? [])].slice(0, n).map((child) => {
        const rect = child.getBoundingClientRect();
        return { top: rect.top - top, height: rect.height };
      });
    }, count);

  test('comparison and cleanup rows are laid out at the height their tokens give', async ({
    page,
  }) => {
    await openRepo(page);
    await page.keyboard.press('Control+,');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await prefs.getByRole('radio', { name: 'Compact' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await page.keyboard.press('Escape');

    await graphRow(page, 1).click();
    await graphRow(page, 4).click({ modifiers: ['ControlOrMeta'] });
    await page
      .getByRole('region', { name: 'Selection' })
      .getByRole('button', { name: 'Compare' })
      .click();
    const list = comparePanel(page).locator('[class*="list"]').first();
    await expect(
      comparePanel(page)
        .getByRole('heading', { name: /^Only in / })
        .first(),
    ).toBeVisible();
    // 22 px rows in compact density: each virtual row starts where the previous one ends.
    await expect
      .poll(() => layout(list, 3))
      .toEqual([
        { top: 0, height: 22 },
        { top: 22, height: 22 },
        { top: 44, height: 22 },
      ]);

    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('Clean up merged');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Clean up branches' });
    await expect(dialog.getByRole('checkbox').first()).toBeVisible();
    await expect
      .poll(() => layout(dialog.getByRole('group'), 2))
      .toEqual([
        { top: 0, height: 30 },
        { top: 30, height: 30 },
      ]);
  });
});
