import { expect, test, type Page } from '@playwright/test';

/** M0-4: native folder picker, terminal (F-266), and their error paths, on the mock backend. */

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

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

async function openYaggui(page: Page) {
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

/** F-266 is the external mode; the Terminal button opens the integrated terminal by default. */
async function useExternalTerminal(page: Page) {
  await page.keyboard.press('Control+,');
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: 'Tools', exact: true })
    .click();
  await prefs.getByRole('radio', { name: 'External' }).click();
  await page.keyboard.press('Escape');
  await expect(prefs).toHaveCount(0);
}

const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test.beforeEach(async ({ page }) => {
      await start(page);
    });

    test('open dialog with a folder picker', async ({ page }) => {
      await page.getByRole('button', { name: 'Enter a path…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Open a repository' });
      await expect(dialog.getByRole('button', { name: 'Browse…' })).toBeVisible();
      await capture(page, theme, 'open-dialog-browse');
    });

    test('terminal not found, then the terminal setting', async ({ page }) => {
      await openYaggui(page);
      await useExternalTerminal(page);
      await page.evaluate(() => {
        if (window.__yagguiMock) window.__yagguiMock.terminalAvailable = false;
      });
      await page.getByRole('toolbar').getByRole('button', { name: 'Terminal' }).click();
      const toast = toastWith(page, 'Could not open a terminal');
      await expect(toast).toContainText('No terminal was found');
      await capture(page, theme, 'terminal-not-found');

      await toast.getByRole('button', { name: 'Choose a terminal…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Terminal' });
      await dialog.getByRole('textbox').fill('wezterm');
      await capture(page, theme, 'terminal-setting');
    });
  });
}

test.describe('behavior', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test.beforeEach(async ({ page }) => {
    await start(page);
  });

  test('Open uses the native folder picker', async ({ page }) => {
    await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/picked-repo'));
    await page.getByRole('button', { name: /^Open/ }).first().click();
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^picked-repo/);
    // The repository opened in the welcome tab, no extra tab.
    await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(1);
  });

  test('⌘O from a repository opens the picked folder in a new tab', async ({ page }) => {
    await openYaggui(page);
    await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/blog'));
    await page.keyboard.press('Control+O');
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^blog/);
    await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(2);
  });

  test('cancelling the picker changes nothing', async ({ page }) => {
    await page.evaluate(() => window.__yagguiMock?.setPickedFolder(null));
    await page.keyboard.press('Control+O');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  });

  test('Browse in the path dialog opens the picked folder', async ({ page }) => {
    await page.getByRole('button', { name: 'Enter a path…' }).click();
    await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/linux'));
    await page.getByRole('button', { name: 'Browse…' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^linux/);
  });

  test('Terminal opens the system terminal in the repository', async ({ page }) => {
    await openYaggui(page);
    await useExternalTerminal(page);
    await page.getByRole('toolbar').getByRole('button', { name: 'Terminal' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__yagguiMock?.openedTerminals.length))
      .toBe(1);
    const opened = await page.evaluate(() => window.__yagguiMock?.openedTerminals[0]);
    expect(opened).toEqual({ repoId: 1, path: '/Users/alex/dev/yaggui', program: 'open' });
  });

  test('the terminal setting is saved and used', async ({ page }) => {
    await openYaggui(page);
    await useExternalTerminal(page);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page
      .getByRole('dialog', { name: 'Preferences' })
      .getByRole('navigation', { name: 'Preference sections' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Preferences' })
      .getByRole('button', { name: 'Configure…' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Terminal' });
    await dialog.getByRole('textbox').fill('  kitty  ');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole('dialog', { name: 'Preferences' })
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toHaveCount(0);
    await page.getByRole('toolbar').getByRole('button', { name: 'Terminal' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__yagguiMock?.openedTerminals.at(-1)?.program))
      .toBe('kitty');

    // Persisted like the SQLite store: still there after a reload.
    await page.reload();
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page
      .getByRole('dialog', { name: 'Preferences' })
      .getByRole('navigation', { name: 'Preference sections' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Preferences' })
      .getByRole('button', { name: 'Configure…' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Terminal' }).getByRole('textbox')).toHaveValue(
      'kitty',
    );
  });

  test('a folder opened once is still known after a reload', async ({ page }) => {
    await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/picked-repo'));
    await page.keyboard.press('Control+O');
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^picked-repo/);
    // Tabs are saved shortly after a change: wait for it, as a real restart would.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const saved = await window.__yagguiMock?.commands.getTabs();
          return saved?.status === 'ok' && saved.data.tabs.some((tab) => tab.repoId !== null);
        }),
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^picked-repo/);
    await expect(page.getByRole('toolbar')).toBeVisible();
  });
});
