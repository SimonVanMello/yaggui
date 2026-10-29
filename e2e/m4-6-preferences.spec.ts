import { expect, test, type Page } from '@playwright/test';

/** M4-6: shortcuts (F-281, F-283), external tools (F-323), Git config (F-325) and themes (F-320). */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`m4-6-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function start(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

async function openRepo(page: Page) {
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });

async function openPrefs(page: Page, tab: string) {
  await page.keyboard.press('Control+,');
  const prefs = dialog(page, 'Preferences');
  await expect(prefs).toBeVisible();
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: tab, exact: true })
    .click();
  return prefs;
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 900 } });

    test('the shortcut sheet lists the shortcuts and follows the bindings', async ({ page }) => {
      await start(page);
      await page.keyboard.press('Control+/');
      const sheet = dialog(page, 'Keyboard shortcuts');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText('New tab', { exact: true })).toBeVisible();
      await expect(sheet.getByText('Show keyboard shortcuts')).toBeVisible();
      await capture(page, theme, 'shortcuts-sheet');

      // "Edit shortcuts…" goes straight to the editor.
      await sheet.getByRole('button', { name: 'Edit shortcuts…' }).click();
      await expect(
        dialog(page, 'Preferences').getByPlaceholder('Filter commands or shortcuts'),
      ).toBeVisible();
      await page.keyboard.press('Escape');

      // The palette finds it, too.
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox').fill('keyboard shortcuts');
      await page.keyboard.press('Enter');
      await expect(dialog(page, 'Keyboard shortcuts')).toBeVisible();
    });

    test('rebinding: capture, conflicts, reset and persistence', async ({ page }) => {
      await start(page);
      // A welcome tab is reused by "New tab": start from a repository tab.
      await openRepo(page);
      const prefs = await openPrefs(page, 'Shortcuts');
      const row = (id: string) => prefs.locator(`[data-binding-id="${id}"]`);
      await expect(row('tab.new')).toContainText('Ctrl');
      await capture(page, theme, 'keybindings');

      await row('tab.new')
        .getByRole('button', { name: /Change the shortcut of New tab/ })
        .click();
      await expect(prefs.getByRole('button', { name: /Press the shortcut/ })).toBeFocused();
      // A bare key cannot be a shortcut.
      await page.keyboard.press('n');
      await expect(prefs).toContainText('Use a modifier');
      await page.keyboard.press('Control+Alt+N');
      await expect(row('tab.new')).toContainText('Alt');

      // Same shortcut for another command: the conflict is shown and must be confirmed.
      await row('tab.close')
        .getByRole('button', { name: /Change the shortcut of Close tab/ })
        .click();
      await page.keyboard.press('Control+Alt+N');
      await expect(row('tab.close')).toContainText('Already used by: New tab');
      await capture(page, theme, 'keybindings-conflict');
      await row('tab.close').getByRole('button', { name: 'Cancel' }).click();
      await expect(row('tab.close')).not.toContainText('Already used');

      // Escape while capturing cancels the capture, not the dialog.
      await row('tab.close')
        .getByRole('button', { name: /Change the shortcut of Close tab/ })
        .click();
      await page.keyboard.press('Escape');
      await expect(prefs).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(prefs).toBeHidden();
      await page.keyboard.press('Control+Alt+N');
      await expect(page.getByRole('tab')).toHaveCount(2);
      // The old shortcut is free again: from the repository tab, it does nothing.
      await page.getByRole('tab').first().click();
      await page.keyboard.press('Control+T');
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);

      // Survives a reload, shows in the shortcut sheet, and goes back to the default.
      await page.reload();
      await expect(page.getByRole('tab').first()).toBeVisible();
      await page.keyboard.press('Control+/');
      await expect(dialog(page, 'Keyboard shortcuts').getByText('New tab')).toBeVisible();
      await page.keyboard.press('Escape');
      const again = await openPrefs(page, 'Shortcuts');
      await expect(again.locator('[data-binding-id="tab.new"]')).toContainText('Alt');
      await again.getByRole('button', { name: 'Reset all to defaults' }).click();
      await expect(again.locator('[data-binding-id="tab.new"]')).not.toContainText('Alt');
      await page.keyboard.press('Escape');
      await expect(again).toBeHidden();
      // From a repository tab, the default shortcut opens a new tab again.
      await page.getByRole('tab').first().click();
      await page.keyboard.press('Control+T');
      await expect(page.getByRole('tab', { selected: true }).first()).toHaveAccessibleName(
        /new tab/i,
      );
    });

    test('a shortcut can be removed and the palette shows the rebound one', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'Shortcuts');
      const row = prefs.locator('[data-binding-id="app.preferences"]');
      await row.getByRole('button', { name: /Change the shortcut of Open preferences/ }).click();
      await page.keyboard.press('Control+Alt+P');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox').fill('open preferences');
      await expect(page.getByRole('option', { name: /Open preferences/ })).toContainText('Alt');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Alt+P');
      await expect(dialog(page, 'Preferences')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+,');
      await expect(dialog(page, 'Preferences')).toBeHidden();
    });

    test('tools: launch tests for the editor, terminal, diff and merge tools', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'Tools');

      const editor = prefs.getByLabel('Editor', { exact: true });
      await editor.fill('code');
      await editor.blur();
      await prefs.getByRole('button', { name: 'Test' }).nth(0).click();
      await expect(prefs).toContainText('Started: code');
      await editor.fill('missing-editor');
      await prefs.getByRole('button', { name: 'Test' }).nth(0).click();
      await expect(prefs.getByRole('status').first()).toContainText('could not be started');

      await prefs.getByLabel('Diff tool').fill('kdiff3');
      await prefs.getByRole('button', { name: 'Test' }).nth(2).click();
      await expect(prefs).toContainText('Git knows "kdiff3" but it is not installed');
      await prefs.getByLabel('Merge tool').fill('meld');
      await prefs.getByRole('button', { name: 'Test' }).nth(3).click();
      await expect(prefs).toContainText('meld is available');
      await prefs.getByLabel('Merge tool').blur();
      await capture(page, theme, 'tools');

      await prefs.getByLabel('Diff tool').fill('nope');
      await prefs.getByRole('button', { name: 'Test' }).nth(2).click();
      await expect(prefs).toContainText('Git does not know "nope"');
      await prefs.getByLabel('Diff tool').fill('--evil');
      await prefs.getByLabel('Diff tool').blur();
      await expect(page.getByText('Could not save the preference', { exact: true })).toBeVisible();

      // The merge tool of the preferences is saved.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
      const saved = await openPrefs(page, 'Tools');
      await expect(saved.getByLabel('Merge tool')).toHaveValue('meld');
    });

    test('Git configuration: common keys, scopes and the raw editor', async ({ page }) => {
      await start(page);
      await openRepo(page);
      const prefs = await openPrefs(page, 'Git configuration');
      await expect(prefs.getByLabel('Name (user.name)')).toHaveValue('Alex Martin');
      await capture(page, theme, 'gitconfig-global');

      await prefs.getByLabel('Name (user.name)').fill('Ada Lovelace');
      await prefs.getByLabel('Name (user.name)').blur();
      await prefs.getByLabel('Pull strategy (pull.rebase)').selectOption('true');
      await expect(prefs.getByRole('cell', { name: 'pull.rebase', exact: true })).toBeVisible();
      await prefs.getByLabel('Line endings (core.autocrlf)').selectOption('input');
      await prefs.getByLabel('Default branch (init.defaultBranch)').fill('trunk');
      await prefs.getByLabel('Default branch (init.defaultBranch)').press('Enter');
      await expect(prefs.getByRole('cell', { name: 'trunk', exact: true })).toBeVisible();

      // The repository file starts empty and inherits the global values.
      await prefs.getByRole('radio', { name: 'This repository' }).click();
      await expect(prefs.getByLabel('Name (user.name)')).toHaveValue('');
      await expect(prefs.getByLabel('Name (user.name)')).toHaveAttribute(
        'placeholder',
        'Ada Lovelace',
      );
      await prefs.getByLabel('Email (user.email)').fill('work@example.com');
      await prefs.getByLabel('Email (user.email)').blur();
      await expect(prefs.getByRole('cell', { name: 'work@example.com' })).toBeVisible();

      // Raw editor: add, edit, remove (with a confirmation).
      await prefs.getByLabel('section.name').fill('alias.co');
      await prefs.getByLabel('value', { exact: true }).fill('checkout');
      await prefs.getByRole('button', { name: 'Add' }).click();
      await expect(prefs.getByRole('cell', { name: 'alias.co', exact: true })).toBeVisible();
      await prefs.getByRole('button', { name: 'Edit alias.co' }).click();
      await prefs.getByRole('textbox', { name: 'Edit alias.co' }).fill('switch');
      await prefs.getByRole('textbox', { name: 'Edit alias.co' }).press('Enter');
      await expect(prefs.getByRole('cell', { name: 'switch', exact: true })).toBeVisible();
      await capture(page, theme, 'gitconfig-repo');
      await prefs.getByRole('button', { name: 'Remove alias.co' }).click();
      await prefs.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(prefs.getByRole('cell', { name: 'alias.co', exact: true })).toHaveCount(0);

      // Invalid keys are refused with an explanation.
      await prefs.getByLabel('section.name').fill('nodot');
      await prefs.getByRole('button', { name: 'Add' }).click();
      await expect(page.getByText('not a valid Git configuration key').first()).toBeVisible();
    });

    test('Git configuration: only the global file without a repository', async ({ page }) => {
      await start(page);
      const prefs = await openPrefs(page, 'Git configuration');
      await expect(prefs.getByRole('radio', { name: 'This repository' })).toHaveCount(0);
      await expect(prefs.getByLabel('Email (user.email)')).toHaveValue('alex@example.com');
    });

    test('the Terminal style and the high contrast option', async ({ page }) => {
      await start(page);
      await openRepo(page);
      const prefs = await openPrefs(page, 'Appearance');
      await prefs.getByRole('radio', { name: 'Terminal' }).click();
      // The shape only: the color theme stays.
      await expect(page.locator('html')).toHaveAttribute('data-style', 'terminal');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(prefs).toContainText('Works with every theme');
      await capture(page, theme, 'style-terminal-prefs');
      await prefs.getByRole('switch', { name: /High contrast/ }).click();
      await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
      await page.keyboard.press('Escape');
      await capture(page, theme, 'style-terminal-contrast');

      // First paint on the next launch already uses the style.
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-style', 'terminal');
      await expect(page.getByRole('tab').first()).toBeVisible();
      const reopened = await openPrefs(page, 'Appearance');
      await reopened.getByRole('radio', { name: 'Standard' }).click();
      await expect(page.locator('html')).not.toHaveAttribute('data-style', 'terminal');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await capture(page, theme, 'style-standard-contrast');
    });

    test('the editor opens from the palette', async ({ page }) => {
      await start(page);
      await openRepo(page);
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox').fill('open in editor');
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.evaluate(() => window.__yagguiMock?.settings.openedInEditor.length))
        .toBe(1);
    });
  });
}
