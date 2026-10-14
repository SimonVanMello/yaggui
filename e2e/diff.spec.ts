import { expect, test, type Page } from '@playwright/test';

/** Same fixed "now" as the mock data (src/ipc/mockData.ts), for stable relative times. */
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

const fileList = (page: Page) => page.getByRole('listbox', { name: /^Commit / });
const diffView = (page: Page) => page.getByRole('region', { name: /^Diff of / });

/** `#diff-demo`: the mock's showcase commit, first file selected. */
async function openDemo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/#diff-demo');
  await expect(diffView(page)).toBeVisible();
}

async function selectFile(page: Page, name: string) {
  await fileList(page)
    .getByRole('option', { name: new RegExp(name) })
    .click();
  await expect(diffView(page)).toHaveAccessibleName(new RegExp(`${name}$`));
}

async function setLayout(page: Page, layout: 'Unified' | 'Side by side') {
  await page.getByRole('radio', { name: layout }).click();
  await expect(page.getByRole('radio', { name: layout })).toBeChecked();
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('unified diff', async ({ page }) => {
      await openDemo(page);
      await selectFile(page, 'TabBar.tsx');
      await setLayout(page, 'Unified');
      await expect(page.locator('.yaggui-hunk')).toHaveCount(2);
      // Word-level highlight of the changed part only.
      await expect(
        page.locator('.yaggui-word').filter({ hasText: '{...drag.containerProps}' }),
      ).toBeVisible();
      await capture(page, theme, 'diff-unified');
    });

    test('side-by-side diff', async ({ page }) => {
      await openDemo(page);
      await selectFile(page, 'TabBar.tsx');
      await setLayout(page, 'Side by side');
      await expect(page.locator('.cm-editor')).toHaveCount(2);
      await capture(page, theme, 'diff-split');
    });

    test('large file behind a guard', async ({ page }) => {
      await openDemo(page);
      await selectFile(page, 'huge-snapshot.json');
      await expect(page.getByText('Large diff not shown')).toBeVisible();
      await capture(page, theme, 'diff-too-large');
      await page.getByRole('button', { name: 'Show anyway' }).click();
      await expect(page.locator('.cm-editor').first()).toBeVisible();
    });

    test('binary file', async ({ page }) => {
      await openDemo(page);
      await selectFile(page, 'screenshot.png');
      await expect(page.getByText('48.2 KB')).toBeVisible();
      await expect(page.getByText('51.7 KB')).toBeVisible();
      await capture(page, theme, 'diff-binary');
    });

    test('rename with similarity', async ({ page }) => {
      await openDemo(page);
      await selectFile(page, 'GraphCanvas.tsx');
      await expect(page.getByText('Renamed from src/graph/Canvas.tsx (87% similar)')).toBeVisible();
      await capture(page, theme, 'diff-rename');
    });

    test('notices: line endings, mode, encoding', async ({ page }) => {
      await openDemo(page);
      await selectFile(page, 'install.bat');
      await expect(page.getByText(/Line endings changed: LF → CRLF/)).toBeVisible();
      await selectFile(page, 'release.sh');
      await expect(page.getByText('File mode changed: 100644 → 100755')).toBeVisible();
      await selectFile(page, 'NOTES.txt');
      await expect(page.getByText(/Not UTF-8/)).toBeVisible();
      await capture(page, theme, 'diff-encoding');
    });

    test('small window', async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 560 });
      await openDemo(page);
      await selectFile(page, 'TabBar.tsx');
      await setLayout(page, 'Side by side');
      await capture(page, theme, 'diff-min-size');
    });

    test('working tree diff in place of the graph', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await page.getByRole('option', { name: /^yaggui\b/ }).click();
      const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
      await expect(unstaged.getByRole('option')).toHaveCount(4);
      await unstaged.getByRole('option', { name: /README\.md/ }).click();
      await expect(diffView(page)).toHaveAccessibleName('Diff of README.md');
      await expect(page.getByRole('button', { name: 'Discard hunk' })).toBeVisible();
      await capture(page, theme, 'diff-wip');
      await page.keyboard.press('Escape');
      await expect(diffView(page)).toBeHidden();
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
    });
  });
}

test.describe('keyboard and preferences', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('j / k move between files, n / p between changes', async ({ page }) => {
    await openDemo(page);
    await selectFile(page, 'layout.ts');
    await page.keyboard.press('j');
    await expect(diffView(page)).toHaveAccessibleName(/TabBar\.tsx$/);
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await expect(diffView(page)).toHaveAccessibleName(/lanes\.generated\.ts$/);
    await page.keyboard.press('j');
    await expect(diffView(page)).toHaveAccessibleName(/layout\.ts$/);

    await expect(page.locator('.yaggui-current')).toHaveCount(0);
    await page.keyboard.press('n');
    await expect(page.locator('.yaggui-current').first()).toBeVisible();
    const first = await page.locator('.yaggui-current').first().textContent();
    await page.keyboard.press('n');
    await expect(page.locator('.yaggui-current').first()).not.toHaveText(first ?? '');
    await page.keyboard.press('p');
    await expect(page.locator('.yaggui-current').first()).toHaveText(first ?? '');
  });

  test('the layout is a stored preference toggled with Mod+D', async ({ page }) => {
    await openDemo(page);
    await selectFile(page, 'TabBar.tsx');
    await expect(page.getByRole('radio', { name: 'Side by side' })).toBeChecked();
    await page.keyboard.press('Control+D');
    await expect(page.getByRole('radio', { name: 'Unified' })).toBeChecked();
    await expect(page.locator('.cm-editor')).toHaveCount(1);
    await page.reload();
    await expect(diffView(page)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Unified' })).toBeChecked();
  });

  test('context lines and whole file options', async ({ page }) => {
    await openDemo(page);
    await selectFile(page, 'TabBar.tsx');
    await setLayout(page, 'Unified');
    const lines = page.locator('.cm-line');
    const withContext = await lines.count();
    await page.getByRole('button', { name: 'Diff options' }).click();
    await page.getByRole('menuitemradio', { name: '0 lines', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => lines.count()).toBeLessThan(withContext);
    await page.getByRole('button', { name: 'Diff options' }).click();
    await page.getByRole('menuitemcheckbox', { name: /Show the whole file/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.yaggui-hunk')).toHaveCount(1);
  });
});

test.describe('side by side scrolling', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('both sides scroll horizontally together', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 560 });
    await openDemo(page);
    await selectFile(page, 'TabBar.tsx');
    await setLayout(page, 'Side by side');
    const scrollers = page.locator('.cm-scroller');
    await expect(scrollers).toHaveCount(2);
    const widths = await scrollers.evaluateAll((els) => els.map((el) => el.scrollWidth));
    expect(widths[0]).toBe(widths[1]);
    const overflow = await scrollers.first().evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(true);
    await scrollers.first().evaluate((el) => {
      el.scrollLeft = 120;
    });
    await expect.poll(() => scrollers.nth(1).evaluate((el) => el.scrollLeft)).toBe(120);
    await scrollers.nth(1).evaluate((el) => {
      el.scrollLeft = 40;
    });
    await expect.poll(() => scrollers.first().evaluate((el) => el.scrollLeft)).toBe(40);
  });
});
