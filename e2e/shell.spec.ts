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

/** No toolbar overflow, and its buttons do not run into the branch selector on the right. */
async function expectToolbarFits(page: Page) {
  const toolbar = page.getByRole('toolbar', { name: 'Repository actions' });
  const layout = await toolbar.evaluate((el) => {
    const end = el.lastElementChild?.getBoundingClientRect().left ?? Infinity;
    const lastButton = [...el.children]
      .slice(0, -1)
      .map((child) => child.getBoundingClientRect().right)
      .reduce((max, right) => Math.max(max, right), 0);
    return { overflow: el.scrollWidth > el.clientWidth, lastButton, end };
  });
  expect(layout.overflow).toBe(false);
  expect(layout.lastButton).toBeLessThanOrEqual(layout.end);
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

const tabs = (page: Page) => page.getByRole('tablist').getByRole('tab');
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Repository actions' });

async function openFromWelcome(page: Page, name: string) {
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

/** yaggui (dirty, ahead 2), linux (interactive rebase 3/7 with a conflict), blog (clean). */
async function openThreeRepos(page: Page) {
  await openFromWelcome(page, 'yaggui');
  await page.keyboard.press('Control+T');
  await openFromWelcome(page, 'linux');
  await page.keyboard.press('Control+T');
  await openFromWelcome(page, 'blog');
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await start(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });

    test('welcome screen', async ({ page }) => {
      await expect(page.getByRole('group', { name: 'Favorites' }).getByRole('option')).toHaveCount(
        2,
      );
      await expect(page.getByRole('option', { name: /legacy-api/ })).toContainText(
        'Folder not found',
      );
      await capture(page, theme, 'welcome');
    });

    test('repository open', async ({ page }) => {
      await openFromWelcome(page, 'yaggui');
      await expect(
        page.getByRole('button', { name: /Current branch: feat\/graph-lanes/ }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Push (2)' })).toBeVisible();
      await capture(page, theme, 'repo');
    });

    test('three tabs with a rebase in progress', async ({ page }) => {
      await openThreeRepos(page);
      await expect(tabs(page)).toHaveCount(3);
      await page.keyboard.press('Control+2');
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
        /^linux, Rebase in progress, 1 conflict, 5 changes/,
      );
      await expect(page.getByText('Rebasing sched/eevdf-fixes')).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'step 3 / 7' })).toBeVisible();
      await capture(page, theme, 'tabs-rebase');
    });

    test('command log open', async ({ page }) => {
      await openFromWelcome(page, 'yaggui');
      await page.keyboard.press('Control+J');
      const log = page.getByRole('region', { name: 'Command log' });
      await expect(log).toBeVisible();
      await expect(
        log.getByRole('button', { name: /git fetch --progress --prune origin/ }),
      ).toBeVisible();
      await log.getByRole('button', { name: /git commit -F -/ }).click();
      await expect(log).toContainText('3 files changed, 142 insertions(+)');
      await capture(page, theme, 'command-log');
    });

    test('typed error with its action', async ({ page }) => {
      await openFromWelcome(page, 'yaggui');
      // A remote whose host can't be reached: fetching all remotes fails with a typed error.
      await page.evaluate(() => window.__yagguiMock?.addOfflineRemote(1));
      await toolbar(page).getByRole('button', { name: 'Fetch', exact: true }).click();
      const toast = toastWith(page, 'Fetch failed');
      await expect(toast).toBeVisible();
      await expect(toast).toContainText("The remote host can't be reached");
      await expect(toast.getByRole('button', { name: 'Retry' })).toBeVisible();
      await capture(page, theme, 'error-toast');

      // The suggested action runs the fetch again, which fails the same way.
      await toast.getByRole('button', { name: 'Retry' }).click();
      await expect(toastWith(page, 'Fetch failed')).toBeVisible();
      await page.keyboard.press('Control+J');
      const log = page.getByRole('region', { name: 'Command log' });
      const failed = log.getByRole('button', { name: /git fetch --progress --prune --all/ });
      await expect(failed).toHaveCount(2);
      await failed.last().click();
      await expect(log).toContainText('Could not resolve host: offline.invalid');
      await capture(page, theme, 'error-action-log');
    });

    test('success toast', async ({ page }) => {
      await openFromWelcome(page, 'blog');
      await toolbar(page).getByRole('button', { name: 'Fetch', exact: true }).click();
      await expect(toastWith(page, 'Fetch complete')).toBeVisible();
      await expect(page.locator('footer')).toContainText('Fetch completed');
      await capture(page, theme, 'success-toast');
    });

    test('inline error in the open dialog', async ({ page }) => {
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Open a repository' });
      await dialog.getByRole('textbox').fill('/Users/alex/not-a-repo');
      await dialog.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('is not a Git repository');
      await capture(page, theme, 'open-dialog-error');
    });
  });
}

test.describe('behavior', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test('tab keyboard shortcuts', async ({ page }) => {
    await openThreeRepos(page);
    const selected = page.getByRole('tab', { selected: true });

    await page.keyboard.press('Control+1');
    await expect(selected).toHaveAccessibleName(/^yaggui/);
    await page.keyboard.press('Control+9');
    await expect(selected).toHaveAccessibleName(/^blog/);
    await page.keyboard.press('Control+Tab');
    await expect(selected).toHaveAccessibleName(/^yaggui/);
    await page.keyboard.press('Control+Shift+Tab');
    await expect(selected).toHaveAccessibleName(/^blog/);

    await page.keyboard.press('Control+W');
    await expect(tabs(page)).toHaveCount(2);
    await expect(selected).toHaveAccessibleName(/^linux/);

    // Closing the last tab leaves a welcome screen.
    await page.keyboard.press('Control+W');
    await page.keyboard.press('Control+W');
    await expect(tabs(page)).toHaveCount(1);
    await expect(selected).toHaveAccessibleName('New tab');
  });

  test('arrow keys move between tabs with a visible focus', async ({ page }) => {
    await openThreeRepos(page);
    await page.getByRole('tab', { selected: true }).focus();
    await page.keyboard.press('ArrowLeft');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAccessibleName(/^linux/);
    await expect(focused).toHaveAttribute('aria-selected', 'true');
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');

    await page.keyboard.press('Control+Shift+ArrowLeft');
    await expect(tabs(page).first()).toHaveAccessibleName(/^linux/);
  });

  test('drag reorders tabs', async ({ page }) => {
    await openThreeRepos(page);
    const first = tabs(page).first();
    const last = tabs(page).last();
    const from = await first.boundingBox();
    const to = await last.boundingBox();
    if (!from || !to) throw new Error('tabs not laid out');
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(tabs(page).last()).toHaveAccessibleName(/^yaggui/);
    await expect(tabs(page).first()).toHaveAccessibleName(/^linux/);
  });

  test('opening an already open repository switches to its tab', async ({ page }) => {
    await openFromWelcome(page, 'yaggui');
    await page.keyboard.press('Control+T');
    await page.getByRole('option', { name: /^yaggui\b/ }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
  });

  test('fuzzy search and keyboard opening', async ({ page }) => {
    const search = page.getByRole('combobox', { name: /Search repositories/ });
    await expect(search).toBeFocused();
    await search.fill('blg');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option')).toContainText('blog');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^blog/);
  });

  test('favorites toggle', async ({ page }) => {
    const linux = page.getByRole('option', { name: /^linux\b/ });
    await linux.hover();
    await linux.getByRole('button', { name: 'Add to favorites' }).click();
    await expect(
      page.getByRole('group', { name: 'Favorites' }).getByRole('option', { name: /^linux\b/ }),
    ).toBeVisible();
  });

  test('dropping a folder opens it', async ({ page }) => {
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/uri-list', 'file:///Users/alex/dev/dropped-repo');
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: data }));
    });
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^dropped-repo/);
  });

  test('a stale index lock offers its fix after confirmation', async ({ page }) => {
    await openFromWelcome(page, 'yaggui');
    await page.evaluate(() =>
      window.__yagguiMock?.setRepoState(1, {
        indexLock: { path: '/Users/alex/dev/yaggui/.git/index.lock', ageSecs: 42, stale: true },
      }),
    );
    await page.getByRole('button', { name: 'Remove the lock…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the index lock?' });
    await dialog.getByRole('button', { name: 'Remove lock' }).click();
    await expect(page.getByRole('button', { name: 'Remove the lock…' })).toBeHidden();
  });

  test('panels collapse and resize per tab', async ({ page }) => {
    await openFromWelcome(page, 'yaggui');
    const sidebar = page.getByRole('navigation', { name: 'References' });
    await expect(sidebar).toBeVisible();
    await page.getByRole('button', { name: 'Toggle left panel' }).click();
    await expect(sidebar).toBeHidden();

    const resizer = page.getByRole('separator', { name: 'Resize the right panel' });
    const before = Number(await resizer.getAttribute('aria-valuenow'));
    await resizer.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(before + 16));

    // Another tab keeps its own layout.
    await page.keyboard.press('Control+T');
    await openFromWelcome(page, 'blog');
    await expect(page.getByRole('navigation', { name: 'References' })).toBeVisible();
  });

  test('running operation shows progress and can be cancelled', async ({ page }) => {
    await openFromWelcome(page, 'yaggui');
    await page.evaluate(() => window.__yagguiMock?.simulateOp(1, { stepMs: 2_000 }));
    const footer = page.locator('footer');
    await expect(footer).toContainText('Fetch');
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
      /Fetch in progress/,
    );
    await footer.getByRole('button', { name: 'Cancel' }).click();
    await expect(footer).toContainText('Fetch cancelled');
  });

  test('tabs are saved for the next launch', async ({ page }) => {
    await openThreeRepos(page);
    await page.keyboard.press('Control+1');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await window.__yagguiMock?.commands.getTabs();
          return result?.status === 'ok'
            ? {
                active: result.data.tabs.findIndex((t) => t.id === result.data.activeTabId),
                repos: result.data.tabs.map((t) => t.repoId),
              }
            : null;
        }),
      )
      .toEqual({ active: 0, repos: [1, 2, 3] });

    // The mock keeps its store in localStorage: a reload is a real "next launch".
    await page.reload();
    await expect(tabs(page)).toHaveCount(3);
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
    await expect(tabs(page).nth(1)).toHaveAccessibleName(/^linux/);
    await expect(
      page.getByRole('button', { name: /Current branch: feat\/graph-lanes/ }),
    ).toBeVisible();
  });

  test('the theme is applied before the first paint after a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page
      .getByRole('dialog', { name: 'Preferences' })
      .getByRole('radio', { name: 'Light' })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    // Record data-theme as soon as the document exists, before any app script runs.
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') {
          (window as { firstTheme?: string }).firstTheme = document.documentElement.dataset.theme;
        }
      });
    });
    await page.reload();
    expect(await page.evaluate(() => (window as { firstTheme?: string }).firstTheme)).toBe('paper');
  });
});

test.describe('watcher unavailable', () => {
  test.use({ locale: 'en-US' });
  for (const { name: theme, colorScheme } of THEMES) {
    test(`shows a discreet banner with a manual refresh (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await start(page);
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Open a repository' });
      await dialog.getByRole('textbox').fill('/Users/alex/dev/no-watch');
      await dialog.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(page.getByText('Automatic refresh unavailable')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
      await capture(page, theme, 'watch-unavailable');
    });
  }
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme, minimum window size`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 900, height: 560 } });

    test('rebase banner, columns and log fit at 900×560', async ({ page }) => {
      await start(page);
      await openFromWelcome(page, 'linux');
      await page.keyboard.press('Control+J');
      const log = page.getByRole('region', { name: 'Command log' });
      await expect(log).toBeVisible();
      // The log is capped to half of the window.
      const box = await log.boundingBox();
      expect(box?.height ?? 0).toBeLessThanOrEqual(280);
      // The banner keeps its actions inside the center (no overlap with the right panel).
      const abort = page.getByRole('button', { name: 'Abort rebase' });
      const center = page.getByRole('main', { name: 'Commit graph' });
      const [abortBox, centerBox] = await Promise.all([abort.boundingBox(), center.boundingBox()]);
      expect((abortBox?.x ?? 0) + (abortBox?.width ?? 0)).toBeLessThanOrEqual(
        (centerBox?.x ?? 0) + (centerBox?.width ?? 0),
      );
      await capture(page, theme, 'min-size-rebase-log');
    });

    test('clean repository with its likely next actions', async ({ page }) => {
      await start(page);
      await openFromWelcome(page, 'blog');
      const pull = page.getByRole('button', { name: /Pull 4 commits/ });
      await expect(pull).toBeEnabled();
      await expect(page.getByRole('button', { name: /New branch/ })).toBeVisible();
      // The toolbar (Branch then Tag, Terminal then Files, icon-only here) fits without overlap.
      const toolbar = page.getByRole('toolbar', { name: 'Repository actions' });
      await expect(toolbar.getByRole('button', { name: 'Tag', exact: true })).toBeInViewport();
      await expect(toolbar.getByRole('button', { name: 'Files', exact: true })).toBeInViewport();
      await expectToolbarFits(page);
      await capture(page, theme, 'min-size-clean');
      // Just above the breakpoint where labels come back, the toolbar still fits.
      await page.setViewportSize({ width: 1100, height: 560 });
      await expect(toolbar.getByText('Tag', { exact: true })).toBeVisible();
      await expect(toolbar.getByText('Files', { exact: true })).toBeVisible();
      await expectToolbarFits(page);
      await page.setViewportSize({ width: 900, height: 560 });
      // Once up to date, pulling is no longer suggested; fetching is.
      await pull.click();
      await expect(pull).toBeHidden();
      await expect(
        page.getByRole('region', { name: 'Local changes' }).getByRole('button', { name: /^Fetch/ }),
      ).toBeVisible();
    });
  });
}

test.describe('tab strip', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('many tabs shrink evenly, stay readable, then scroll', async ({ page }) => {
    await start(page);
    for (let i = 0; i < 12; i++) {
      await page.evaluate((index) => {
        const data = new DataTransfer();
        data.setData('text/uri-list', `file:///Users/alex/dev/project-${String(index)}`);
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: data }));
      }, i);
      await expect(tabs(page)).toHaveCount(i + 1);
    }
    const widths = await tabs(page).evaluateAll((elements) =>
      elements.map((el) => Math.round(el.getBoundingClientRect().width)),
    );
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThanOrEqual(128);
    const overflow = await page
      .getByRole('tablist')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(true);
    // The active (last) tab is scrolled into view.
    await expect(tabs(page).last()).toBeInViewport();
    await capture(page, 'graphite', 'many-tabs');
  });

  test('Mod+T on a welcome tab focuses its search instead of adding a tab', async ({ page }) => {
    await start(page);
    const search = page.getByRole('combobox', { name: /Search repositories/ });
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await expect(search).not.toBeFocused();
    await page.keyboard.press('Control+T');
    await expect(tabs(page)).toHaveCount(1);
    await expect(search).toBeFocused();
  });

  test('window buttons are reachable with the keyboard', async ({ page }) => {
    await start(page);
    const maximize = page.getByRole('group', { name: 'Window' }).getByRole('button', {
      name: 'Maximize',
    });
    await maximize.focus();
    await expect(maximize).toBeFocused();
  });
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme, scrollbars`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('the branch selector covers the right edge of the scrolled graph', async ({ page }) => {
      await start(page);
      await openFromWelcome(page, 'yaggui');
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      // Headless Chromium hides scrollbars, so this only guards the stacking order; the WebKit
      // overlay scrollbars this is about are turned off by the styled ones of global.css.
      const edge = await graph.evaluate((el) => {
        el.scrollTop = 200;
        return el.getBoundingClientRect().right - 4;
      });

      await page.getByRole('button', { name: /^Current branch:/ }).click();
      const search = page.getByRole('combobox', { name: 'Find a branch…' });
      await expect(search).toBeVisible();
      const covered = await search.evaluate((input, x) => {
        const popover = input.closest('[data-radix-popper-content-wrapper]');
        const box = popover?.getBoundingClientRect();
        if (!popover || !box || x < box.left || x > box.right) return null;
        const hit = document.elementFromPoint(x, box.top + box.height / 2);
        return hit !== null && popover.contains(hit);
      }, edge);
      expect(covered).toBe(true);
      await capture(page, theme, 'branch-selector-over-graph');
    });
  });
}
