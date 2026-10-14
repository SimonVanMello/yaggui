import { expect, test, type Page } from '@playwright/test';

/** M2-6: clone, init and preferences, on the mock backend, in both themes. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`clone-prefs-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openWelcome(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'yaggui' })).toBeVisible();
}

const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('clone: progress, cancellation, then success opens the repository', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: /^Clone/ }).click();
      const clone = dialog(page, 'Clone a repository');
      await expect(clone).toBeVisible();
      await expect(clone.getByLabel('Clone into')).toHaveValue('/Users/alex/dev');
      await capture(page, theme, 'clone-form');

      // The folder name follows the address until it is edited.
      await clone.getByLabel('Repository address').fill('https://example.com/acme/slow-widget.git');
      await expect(clone.getByLabel('Folder name')).toHaveValue('slow-widget');
      await clone.getByLabel('Branch (optional)').fill('develop');
      await clone.getByRole('switch', { name: /Shallow clone/ }).click();
      await clone.getByLabel('Depth (commits)').fill('5');
      await clone.getByRole('switch', { name: /Clone submodules/ }).click();
      await clone.getByRole('button', { name: 'Clone', exact: true }).click();

      // In progress: a progress bar with the phase, and a way to cancel.
      const running = dialog(page, 'Cloning slow-widget…');
      await expect(running.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '47');
      await expect(running).toContainText('Receiving objects');
      await capture(page, theme, 'clone-running');

      // Escape does not abort a running clone.
      await page.keyboard.press('Escape');
      await expect(running).toBeVisible();

      await running.getByRole('button', { name: 'Cancel clone' }).click();
      await expect(dialog(page, 'Clone a repository')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(dialog(page, 'Clone a repository').getByLabel('Repository address')).toHaveValue(
        'https://example.com/acme/slow-widget.git',
      );

      // A different address completes, and the repository opens in the tab.
      await page.evaluate(() => {
        if (window.__yagguiMock) window.__yagguiMock.creator.stepMs = 10;
      });
      await clone.getByLabel('Repository address').fill('https://example.com/acme/widget.git');
      await clone.getByLabel('Folder name').fill('widget-copy');
      await clone.getByRole('button', { name: 'Clone', exact: true }).click();
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^widget-copy/);
      await expect(page.getByText('Cloned widget-copy', { exact: true })).toBeVisible();
      const request = await page.evaluate(() => window.__yagguiMock?.creator.clones.at(-1));
      expect(request).toMatchObject({
        url: 'https://example.com/acme/widget.git',
        target: '/Users/alex/dev/widget-copy',
        branch: 'develop',
        depth: 5,
        recurseSubmodules: true,
      });
    });

    for (const [url, title, text, retry] of [
      ['https://example.com/acme/auth-needed.git', 'auth', /credential helper/, false],
      ['https://git.unreachable.example/app.git', 'unreachable', /can't be reached/, true],
    ] as const) {
      test(`clone: ${title} error is explained`, async ({ page }) => {
        await openWelcome(page);
        await page.getByRole('button', { name: /^Clone/ }).click();
        const clone = dialog(page, 'Clone a repository');
        await clone.getByLabel('Repository address').fill(url);
        await clone.getByRole('button', { name: 'Clone', exact: true }).click();
        const alert = clone.getByRole('alert');
        await expect(alert).toContainText('Clone failed');
        await expect(alert).toContainText(text);
        // Only the unreachable host offers a retry, as in the backend's catalog.
        await expect(alert.getByRole('button', { name: 'Retry' })).toHaveCount(retry ? 1 : 0);
        await capture(page, theme, `clone-error-${title}`);
        // Nothing was cloned.
        expect(await page.evaluate(() => window.__yagguiMock?.creator.clones.length)).toBe(0);
      });
    }

    test('clone: a folder that already has files is refused', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: /^Clone/ }).click();
      const clone = dialog(page, 'Clone a repository');
      await clone.getByLabel('Repository address').fill('https://example.com/acme/widget.git');
      await clone.getByLabel('Clone into').fill('/Users/alex/busy');
      await clone.getByRole('button', { name: 'Clone', exact: true }).click();
      await expect(clone.getByRole('alert')).toContainText('already exists and is not empty');
    });

    test('clone: incomplete form is flagged and sends nothing', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: /^Clone/ }).click();
      const clone = dialog(page, 'Clone a repository');
      await clone.getByRole('button', { name: 'Clone', exact: true }).click();
      await expect(clone.getByLabel('Repository address')).toHaveAttribute('aria-invalid', 'true');
      await expect(clone).toBeVisible();
    });

    test('init: creates the repository with options and opens it', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: /^Init/ }).click();
      const init = dialog(page, 'Initialize a repository');
      await expect(init.getByLabel('Default branch')).toHaveValue('main');
      await init.getByLabel('Folder', { exact: true }).fill('/Users/alex/dev/new-project');
      await init.getByLabel('Default branch').fill('trunk');
      await init.getByRole('button', { name: 'Rust' }).click();
      await init.getByRole('button', { name: 'macOS' }).click();
      await init.getByRole('switch', { name: /Add a README/ }).click();
      await expect(init.getByRole('button', { name: 'Rust' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await capture(page, theme, 'init-form');
      await init.getByRole('button', { name: 'Initialize', exact: true }).click();
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^new-project/);
      const request = await page.evaluate(() => window.__yagguiMock?.creator.inits.at(-1));
      expect(request).toEqual({
        target: '/Users/alex/dev/new-project',
        defaultBranch: 'trunk',
        gitignore: ['rust', 'macOs'],
        readme: true,
      });
    });

    test('init: an existing repository is reported', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: /^Init/ }).click();
      const init = dialog(page, 'Initialize a repository');
      await init.getByLabel('Folder', { exact: true }).fill('/Users/alex/existing-repo');
      await init.getByRole('button', { name: 'Initialize', exact: true }).click();
      await expect(init.getByRole('alert')).toContainText('already is a Git repository');
      await capture(page, theme, 'init-error');
    });

    test('the palette and the shortcut open the dialogs', async ({ page }) => {
      await openWelcome(page);
      await page.keyboard.press('Control+K');
      await page.getByRole('combobox').fill('clone');
      await page.keyboard.press('Enter');
      await expect(dialog(page, 'Clone a repository')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+,');
      await expect(dialog(page, 'Preferences')).toBeVisible();
    });

    test('preferences: appearance applies at once and survives a reload', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: 'Preferences' }).click();
      const prefs = dialog(page, 'Preferences');
      await expect(prefs).toBeVisible();
      // Only the selected section is on screen.
      await expect(prefs.getByLabel('Git binary')).toBeHidden();
      await expect(prefs.getByLabel('Every (minutes)')).toBeHidden();
      await capture(page, theme, 'prefs-appearance');

      await prefs.getByRole('radio', { name: 'Compact' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await prefs.getByRole('switch', { name: /High contrast/ }).click();
      await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
      await prefs.getByLabel('Code font').fill('Fira Code');
      await prefs.getByLabel('Code font').blur();
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue('--font-code')),
        )
        .toMatch(/^"Fira Code", /);
      await prefs.getByLabel('Text size').fill('16');
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.getPropertyValue('--font-scale')),
        )
        .toBe('1.231');

      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
      await page.getByRole('button', { name: 'Preferences' }).click();
      await expect(dialog(page, 'Preferences').getByLabel('Code font')).toHaveValue('Fira Code');
    });

    test('preferences: Git path is checked, applied, and a bad one is refused', async ({
      page,
    }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: 'Preferences' }).click();
      const prefs = dialog(page, 'Preferences');
      await prefs.getByRole('tab', { name: 'Git' }).click();
      const path = prefs.getByLabel('Git binary');
      await expect(prefs).toContainText('Git 2.47.1 · /usr/bin/git');
      await capture(page, theme, 'prefs-git');

      await path.fill('/opt/old/git');
      await expect(prefs).toContainText('older than 2.30');
      await capture(page, theme, 'prefs-git-old');

      await path.fill('/opt/invalid/git');
      await expect(prefs).toContainText('not a working Git');
      await expect(prefs.getByRole('button', { name: 'Apply' })).toBeDisabled();

      await path.fill('/opt/custom/git');
      await expect(prefs).toContainText('Git 2.47.1 · /opt/custom/git');
      await prefs.getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByText('Git path saved', { exact: true })).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: 'Preferences' }).click();
      await dialog(page, 'Preferences').getByRole('tab', { name: 'Git' }).click();
      await expect(dialog(page, 'Preferences').getByLabel('Git binary')).toHaveValue(
        '/opt/custom/git',
      );

      // Back to the detected one.
      await dialog(page, 'Preferences').getByRole('button', { name: 'Auto-detect' }).click();
      await expect(dialog(page, 'Preferences').getByLabel('Git binary')).toHaveValue('');
    });

    test('preferences: behavior settings are saved', async ({ page }) => {
      await openWelcome(page);
      await page.getByRole('button', { name: 'Preferences' }).click();
      const prefs = dialog(page, 'Preferences');
      await prefs.getByRole('tab', { name: 'Behavior' }).click();
      await expect(prefs.getByRole('listitem').filter({ hasText: 'release/*' })).toBeVisible();
      await capture(page, theme, 'prefs-behavior');

      await prefs.getByLabel('Every (minutes)').fill('30');
      await prefs.getByLabel('Every (minutes)').blur();
      // Pruning is on by default (as in M2-5): turning it off is the change.
      await prefs.getByRole('switch', { name: /Prune on fetch/ }).click();
      await prefs.getByRole('radio', { name: 'Rebase' }).click();
      await prefs.getByLabel('Protected branches').fill('hotfix/*');
      await prefs.getByRole('button', { name: 'Add', exact: true }).click();
      await prefs.getByRole('button', { name: 'Remove master' }).click();
      await prefs.getByRole('switch', { name: /Drop a stash/ }).click();
      // The force push confirmation stays on and cannot be changed.
      await expect(prefs.getByRole('switch', { name: /Force push/ })).toBeChecked();
      await expect(prefs.getByRole('switch', { name: /Force push/ })).toBeDisabled();

      await page.reload();
      await page.getByRole('button', { name: 'Preferences' }).click();
      const again = dialog(page, 'Preferences');
      await again.getByRole('tab', { name: 'Behavior' }).click();
      await expect(again.getByLabel('Every (minutes)')).toHaveValue('30');
      await expect(again.getByRole('switch', { name: /Prune on fetch/ })).not.toBeChecked();
      await expect(again.getByRole('radio', { name: 'Rebase' })).toBeChecked();
      await expect(again.getByRole('listitem').filter({ hasText: 'hotfix/*' })).toBeVisible();
      await expect(again.getByRole('listitem').filter({ hasText: 'master' })).toHaveCount(0);
      await expect(again.getByRole('switch', { name: /Drop a stash/ })).not.toBeChecked();
    });
  });
}
