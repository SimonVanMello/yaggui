import { expect, test, type Page } from '@playwright/test';

/** M1-2: commit graph on the mock backend. Captures go to test-results/. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`graph-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page, name: RegExp) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(name);
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('yaggui graph', async ({ page }) => {
      await openRepo(page, /^yaggui\b/);
      await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
      await page.waitForTimeout(500);
      await capture(page, theme, 'yaggui');
    });

    test('commit detail with files', async ({ page }) => {
      await openRepo(page, /^yaggui\b/);
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      await graph.getByRole('option').nth(1).click();
      await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();
      await expect(page.getByRole('listbox', { name: /^Commit [0-9a-f]{7}$/ })).toBeVisible();
      await page.waitForTimeout(300);
      await capture(page, theme, 'detail');
    });

    test('search', async ({ page }) => {
      await openRepo(page, /^yaggui\b/);
      await page.getByRole('listbox', { name: 'Commit graph' }).focus();
      await page.keyboard.press('Control+f');
      await page.keyboard.type('fix');
      await page.waitForTimeout(600);
      await capture(page, theme, 'search');
    });

    test('signed commits (F-066)', async ({ page }) => {
      await openRepo(page, /^yaggui\b/);
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      const mark = graph.getByRole('img', { name: /^Signed \((GPG|SSH)\), not verified/ }).first();
      await expect(mark).toBeVisible();
      await expect(mark).toHaveAttribute(
        'title',
        /^Signed \((GPG|SSH)\), not verified — check it in the commit details$/,
      );
      // The row mark never verifies; the detail still does, on demand.
      await mark.click();
      await expect(
        page.getByRole('region', { name: 'Commit details' }).getByText(/\((GPG|SSH)\)$/),
      ).toBeVisible();
      await page.waitForTimeout(300);
      await capture(page, theme, 'signed');
    });

    test('linux 100k scrolled', async ({ page }) => {
      await openRepo(page, /^linux\b/);
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      await expect(graph.getByRole('option').first()).toBeVisible();
      await graph.evaluate((el) => {
        el.scrollTop = 1_200_000;
      });
      await page.waitForTimeout(800);
      await capture(page, theme, 'linux-scrolled');
    });

    test('history walk in progress', async ({ page }) => {
      // M5-4: first open without commit-graph, the backend still walks the history.
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await page.evaluate(() => {
        window.__yagguiMock?.holdHistoryWalk(1500);
      });
      await page.getByRole('option', { name: /^linux\b/ }).click();
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      await expect(graph.getByRole('option').first()).toBeVisible();
      const status = page.getByRole('status').filter({ hasText: 'Reading the history' });
      await expect(status).toHaveText('Reading the history… 1,500 commits');
      await page.waitForTimeout(300);
      await capture(page, theme, 'walking');
      await page.evaluate(() => {
        window.__yagguiMock?.releaseHistoryWalk();
      });
      await expect(status).toBeHidden();
    });

    test('empty repository', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Open a repository' });
      await dialog.getByRole('textbox').fill('/Users/alex/dev/unborn-project');
      await dialog.getByRole('button', { name: /^Open/ }).last().click();
      await expect(page.getByText('No commits yet')).toBeVisible();
      await capture(page, theme, 'empty');
    });
  });
}

test.describe('history taller than the browser can lay out', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('400k rows: wheel 1:1, thumb and End reach any point', async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
    await page.goto('/');
    await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/huge-history'));
    await page.getByRole('button', { name: /^Open/ }).first().click();
    const graph = page.getByRole('listbox', { name: 'Commit graph' });
    await expect(graph.getByRole('option').first()).toBeVisible({ timeout: 60_000 });
    const rowsShown = () =>
      graph.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>('[data-row]')]
          .filter((row) => {
            const box = row.getBoundingClientRect();
            const view = el.getBoundingClientRect();
            return row.dataset.row !== 'wip' && box.bottom > view.top && box.top < view.bottom;
          })
          .map((row) => Number(row.dataset.row))
          .sort((a, b) => a - b),
      );
    // The scroll area is capped (10 M px), not 400k × row height.
    const height = await graph.evaluate((el) => el.scrollHeight);
    expect(height).toBeLessThanOrEqual(10_000_000);

    // Thumb dragged to the middle: middle of the history.
    await graph.evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    });
    await expect.poll(async () => (await rowsShown())[0] ?? 0).toBeGreaterThan(190_000);
    const middle = (await rowsShown())[0] ?? 0;
    expect(middle).toBeLessThan(210_000);

    // Wheel: native speed (a few rows, not thousands).
    await graph.hover();
    await page.mouse.wheel(0, 280);
    await expect.poll(async () => (await rowsShown())[0] ?? 0).toBeGreaterThan(middle);
    expect(((await rowsShown())[0] ?? 0) - middle).toBeLessThan(30);

    // End: the last commit, with its row data loaded.
    await graph.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => (await rowsShown()).at(-1)).toBe(399_999);
    await expect(graph.locator('[data-row="399999"][data-sha]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath('graph-huge-end-graphite.png') });

    // Home: back to the first commit.
    await page.keyboard.press('Home');
    await expect.poll(async () => (await rowsShown())[0]).toBe(0);
  });
});

const LONG_REF = 'feature/PROJ-1234-login-timeout-on-slow-networks';

async function openLongRefs(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/long-refs'));
  await page.getByRole('button', { name: /^Open/ }).first().click();
  const graph = page.getByRole('listbox', { name: 'Commit graph' });
  await expect(graph.getByRole('option').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return graph;
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme, long ref names`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('pills share a wide message column: names in full', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 900 });
      const graph = await openLongRefs(page);
      const pill = graph.locator(`[data-drop-branch="${LONG_REF}"]`);
      await expect(pill).toHaveAttribute('title', new RegExp(`^${LONG_REF} — `));
      await expect(pill.getByText(LONG_REF, { exact: true })).toBeVisible();
      await expect(pill.locator('span[aria-hidden="true"]')).toHaveCount(0);
      await expect(graph.getByText('origin/release/2.4', { exact: true })).toBeVisible();
      await page.waitForTimeout(300);
      await capture(page, theme, 'long-refs-wide');
    });

    test('pills at 900×560: cut in the middle, full name kept', async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 560 });
      const graph = await openLongRefs(page);
      // A ~190 px message column: one long name per row at most, cut in the middle.
      const name = 'users/aïcha/refactor-lane-layout-perf';
      const pill = graph.locator(`[data-drop-branch="${name}"]`);
      await expect(pill).toHaveAttribute('title', new RegExp(`^${name} — `));
      // Leading segment and end kept, the middle cut.
      await expect(pill.locator('span[aria-hidden="true"]')).toHaveText(/^users\/…[^…]+$/);
      // Assistive tech still gets the full name.
      await expect(pill).toContainText(name);
      // What does not fit even at the minimum name width folds into `+N`, listed in its title.
      const more = graph
        .getByRole('option')
        .first()
        .getByLabel(/^\d+ more refs$/);
      await expect(more).toHaveAttribute('title', new RegExp(LONG_REF));
      // The summary keeps its share of the column on every row with pills.
      for (let i = 0; i < 3; i++) {
        const summaryWidth = await graph
          .getByRole('option')
          .nth(i)
          .evaluate(
            (row) => row.firstElementChild?.lastElementChild?.getBoundingClientRect().width,
          );
        expect(summaryWidth ?? 0).toBeGreaterThan(80);
      }
      await page.waitForTimeout(300);
      await capture(page, theme, 'long-refs-min');
    });
  });
}
