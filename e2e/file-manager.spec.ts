import { expect, test, type Page } from '@playwright/test';

/** Toolbar button that opens the repository folder in the system file manager. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

function revealed(page: Page) {
  return page.evaluate(() => window.__yagguiMock?.revealed ?? []);
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 860 } });

    test('the Files button, next to Terminal, opens the repository folder', async ({ page }) => {
      await start(page);
      const toolbar = page.getByRole('toolbar');
      await expect(toolbar.getByRole('button', { name: 'Terminal' })).toBeVisible();
      const buttons = toolbar.getByRole('button');
      const names = await buttons.evaluateAll((list) =>
        list.map((button) => button.getAttribute('aria-label') ?? button.textContent.trim()),
      );
      const terminal = names.indexOf('Terminal');
      expect(terminal).toBeGreaterThanOrEqual(0);
      expect(names[terminal + 1]).toBe('Files');

      const button = toolbar.getByRole('button', { name: 'Files', exact: true });
      await button.hover();
      await expect(page.getByRole('tooltip')).toContainText(
        'Open the repository folder in the file manager',
      );
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: test.info().outputPath(`toolbar-file-manager-${theme}.png`),
        animations: 'disabled',
      });

      await button.click();
      await expect.poll(() => revealed(page)).toEqual([{ repoId: expect.any(Number), path: null }]);
    });

    test('the palette opens the repository folder too', async ({ page }) => {
      await start(page);
      await page.keyboard.press('ControlOrMeta+K');
      const input = page.getByRole('combobox', { name: 'Command palette' });
      await expect(input).toBeFocused();
      await page.keyboard.type('>file manager');
      const options = page.getByRole('listbox', { name: 'Command palette' }).getByRole('option');
      await expect(options.first()).toContainText('Open the repository in the file manager');
      await page.keyboard.press('Enter');
      await expect(input).toBeHidden();
      await expect.poll(async () => (await revealed(page)).length).toBe(1);
      expect((await revealed(page))[0]?.path).toBeNull();
    });
  });
}
