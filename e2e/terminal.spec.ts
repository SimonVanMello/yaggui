import { expect, test, type Page } from '@playwright/test';

/** M4-9: integrated terminal (F-267), on the mock fake shell. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`m4-9-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

async function openRepo(page: Page, name: string) {
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

const panel = (page: Page) => page.getByRole('region', { name: 'Terminal' });
const screen = (page: Page) => panel(page).locator('.xterm-rows');
const terminalTabs = (page: Page) =>
  panel(page).getByRole('tablist', { name: 'Terminals' }).getByRole('tab');

/** Everything typed into the terminals of the mock, in order. */
function written(page: Page): Promise<string> {
  return page.evaluate(() => [...(window.__yagguiMock?.ptys.written.values() ?? [])].join(' '));
}

async function runCommand(page: Page, command: string) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function openPrefs(page: Page, tab: string) {
  // From a focused terminal, Ctrl+, would go to the shell.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Control+,');
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  await expect(prefs).toBeVisible();
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: tab, exact: true })
    .click();
  return prefs;
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('the Terminal button opens a shell in the repository', async ({ page }) => {
      await start(page);
      await openRepo(page, 'yaggui');
      const button = page.getByRole('toolbar').getByRole('button', { name: 'Terminal' });
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(panel(page)).toBeVisible();
      await expect(screen(page)).toContainText('yaggui $');
      await expect(terminalTabs(page)).toHaveText(['zsh']);

      // The keyboard goes to the shell.
      await runCommand(page, 'git status');
      await expect(screen(page)).toContainText('Changes not staged for commit');
      await runCommand(page, 'colors');
      await expect(screen(page)).toContainText('██ ██');
      await capture(page, theme, 'panel');

      // The panel resizes from its top edge; the shell gets the new size.
      const resizer = panel(page).getByRole('separator', { name: 'Resize the terminal' });
      const before = await page.evaluate(() => window.__yagguiMock?.ptys.size(1));
      const box = await resizer.boundingBox();
      if (!box) throw new Error('no resizer');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 4 });
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => window.__yagguiMock?.ptys.size(1)?.rows))
        .toBeGreaterThan(before?.rows ?? 0);

      await button.click();
      await expect(panel(page)).toBeHidden();
    });

    test('several terminals, kept across tab switches', async ({ page }) => {
      await start(page);
      await openRepo(page, 'yaggui');
      await page.keyboard.press('Control+`');
      await expect(screen(page)).toContainText('yaggui $');
      await runCommand(page, 'echo first terminal');
      await expect(screen(page)).toContainText('first terminal');

      await panel(page).getByRole('button', { name: 'New terminal' }).click();
      await expect(terminalTabs(page)).toHaveCount(2);
      await expect(screen(page)).not.toContainText('first terminal');
      await runCommand(page, 'echo second terminal');
      await expect(screen(page)).toContainText('second terminal');
      await capture(page, theme, 'tabs');

      // Another repository has its own (closed) panel; coming back finds the terminals as left.
      // (Ctrl+T would go to the shell: the terminal has the focus.)
      await page.getByRole('button', { name: 'New tab' }).click();
      await openRepo(page, 'blog');
      await expect(panel(page)).toBeHidden();
      await page.getByRole('tab', { name: /^yaggui/ }).click();
      await expect(terminalTabs(page)).toHaveCount(2);
      await expect(screen(page)).toContainText('second terminal');
      await terminalTabs(page).first().click();
      await expect(screen(page)).toContainText('first terminal');

      // Closing a terminal ends its shell; closing the last one closes the panel.
      await panel(page).getByRole('button', { name: 'Close zsh' }).first().click();
      await expect(terminalTabs(page)).toHaveCount(1);
      await panel(page).getByRole('button', { name: 'Close zsh' }).click();
      await expect(panel(page)).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.__yagguiMock?.ptys.count(1))).toBe(0);
    });

    test('a focused terminal keeps Ctrl+C, Ctrl+W and Ctrl+Z, not the palette', async ({
      page,
    }) => {
      await start(page);
      await openRepo(page, 'yaggui');
      await page.keyboard.press('Control+`');
      await expect(screen(page)).toContainText('yaggui $');

      await page.keyboard.press('Control+C');
      await page.keyboard.press('Control+W');
      await page.keyboard.press('Control+Z');
      await expect.poll(() => written(page)).toBe('\x03\x17\x1a');
      // Ctrl+W did not close the repository tab.
      await expect(page.getByRole('tab', { name: /^yaggui/ })).toBeVisible();

      await page.keyboard.press('Control+K');
      await expect(page.getByRole('combobox')).toBeFocused();
      await page.keyboard.press('Escape');

      // From the graph, the toggle opens; from the terminal, it hides.
      await page.keyboard.press('Control+Shift+`');
      await expect(terminalTabs(page)).toHaveCount(2);
      await page.keyboard.press('Control+`');
      await expect(panel(page)).toBeHidden();
    });

    test('the Terminal style and high contrast reach the emulator', async ({ page }) => {
      await start(page);
      await openRepo(page, 'yaggui');
      const prefs = await openPrefs(page, 'Appearance');
      // Style D: the Terminal shape and the Terminal colors.
      await prefs.getByRole('radio', { name: 'Terminal' }).click();
      await prefs.locator('[data-theme-id="terminal"]').click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+`');
      await expect(screen(page)).toContainText('yaggui $');
      await runCommand(page, 'colors');
      await runCommand(page, 'git status');
      await expect(screen(page)).toContainText('notes.md');
      const background = () =>
        panel(page)
          .locator('.xterm-scrollable-element')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
      // --term-bg is --bg-app of the Terminal theme.
      await expect.poll(background).toBe('rgb(10, 10, 10)');
      await capture(page, theme, 'style-terminal');

      const contrast = await openPrefs(page, 'Appearance');
      await contrast.getByRole('switch', { name: /High contrast/ }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
      await capture(page, theme, 'style-terminal-contrast');
    });

    test('in external mode, the button opens the system terminal (F-266)', async ({ page }) => {
      await start(page);
      await openRepo(page, 'yaggui');
      const prefs = await openPrefs(page, 'Tools');
      await expect(prefs.getByRole('radio', { name: 'Integrated' })).toBeChecked();
      await capture(page, theme, 'prefs-tools');
      await prefs.getByRole('radio', { name: 'External' }).click();
      await expect(prefs).toContainText('opens the external terminal');
      await page.keyboard.press('Escape');

      const button = page.getByRole('toolbar').getByRole('button', { name: 'Terminal' });
      await expect(button).not.toHaveAttribute('aria-pressed');
      await button.click();
      await expect
        .poll(() => page.evaluate(() => window.__yagguiMock?.openedTerminals.length))
        .toBe(1);
      await expect(panel(page)).toBeHidden();
    });

    test('a shell that cannot start says why', async ({ page }) => {
      await start(page);
      await page.evaluate(() => {
        if (window.__yagguiMock) window.__yagguiMock.ptys.available = false;
      });
      await openRepo(page, 'yaggui');
      await page.keyboard.press('Control+`');
      await expect(panel(page)).toContainText('The terminal could not start');
      await expect(panel(page)).toContainText('could not be started in the integrated terminal');
      await capture(page, theme, 'failed');
    });
  });
}
