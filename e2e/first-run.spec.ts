import { expect, test, type Page } from '@playwright/test';

/** First-launch screen and "What's new" opened once after an update. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

/**
 * Starts the app with a mock setup (a function body taking `mock`) applied on the first load
 * only: a reload then shows what the app stored, like the next launch.
 */
async function start(page: Page, setup: string) {
  await page.addInitScript(`
    if (!sessionStorage.getItem('first-run-spec')) {
      sessionStorage.setItem('first-run-spec', '1');
      window.__yagguiMockSetup = (mock) => { ${setup} };
    }
  `);
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
}

const FRESH = 'mock.freshInstall();';

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

function storedPreferences(page: Page) {
  return page.evaluate(async () => {
    const result = await window.__yagguiMock?.commands.getPreferences();
    return result?.status === 'ok' ? result.data : null;
  });
}

const firstRun = (page: Page, name = 'Welcome to yaggui') => page.getByRole('dialog', { name });
const whatsNew = (page: Page) => page.getByRole('dialog', { name: "What's new" });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 800 } });

    test('a fresh install shows the first-launch screen, in English then French', async ({
      page,
    }) => {
      await start(page, FRESH);
      const dialog = firstRun(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('yaggui runs 100% locally: no account, nothing sent.');
      await expect(dialog).toContainText('Git 2.47.1 · /usr/bin/git');
      await expect(
        dialog.getByRole('switch', { name: 'Check for updates at startup' }),
      ).not.toBeChecked();
      await expect(dialog.getByRole('region', { name: 'Shortcuts' })).toContainText(
        'Command palette',
      );
      // The update question waits for the screen: no toast behind it.
      await expect(page.getByRole('listitem').filter({ hasText: 'Check for updates' })).toHaveCount(
        0,
      );
      await capture(page, `first-run-en-${theme}.png`);

      await dialog
        .getByRole('radiogroup', { name: 'Language' })
        .getByRole('radio', { name: 'Français' })
        .click();
      const french = firstRun(page, 'Bienvenue dans yaggui');
      await expect(french).toContainText(
        "yaggui fonctionne à 100 % en local : aucun compte, rien n'est envoyé.",
      );
      await expect(french.getByRole('button', { name: 'Commencer' })).toBeVisible();
      await expect.poll(async () => (await storedPreferences(page))?.locale).toBe('fr');
      await capture(page, `first-run-fr-${theme}.png`);
    });

    test("after an update, What's new opens once on the installed version", async ({ page }) => {
      await start(page, "mock.previousVersion('0.2.0');");
      const dialog = whatsNew(page);
      await expect(dialog).toBeVisible();
      const installed = dialog.locator('section[data-installed]');
      await expect(installed.getByRole('heading', { level: 3 })).toHaveText('0.3.0');
      await expect(installed).toBeInViewport();
      await expect(firstRun(page)).toHaveCount(0);
      await capture(page, `whats-new-auto-${theme}.png`);
      await expect.poll(async () => (await storedPreferences(page))?.lastSeenVersion).toBe('0.3.0');

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
      await expect(whatsNew(page)).toHaveCount(0);
    });
  });
}

test.describe('first-launch screen', () => {
  test.use({ locale: 'en-US' });

  test('"Start" persists it, and the next launch goes straight to the welcome screen', async ({
    page,
  }) => {
    await start(page, FRESH);
    const dialog = firstRun(page);
    await dialog
      .getByRole('radiogroup', { name: 'Appearance' })
      .getByRole('radio', { name: 'Dark' })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    await dialog
      .getByRole('radiogroup', { name: 'Appearance' })
      .getByRole('radio', { name: 'Light' })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await dialog.getByRole('button', { name: 'Start' }).click();
    await expect(dialog).toBeHidden();
    // Left untouched on the screen, the update question is asked the usual way.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Check for updates at startup?' }),
    ).toBeVisible();
    await expect.poll(async () => (await storedPreferences(page))?.onboarded).toBe(true);
    const stored = await storedPreferences(page);
    expect(stored?.theme).toBe('light');
    // The same launch as the screen: the version is recorded, What's new stays closed.
    expect(stored?.lastSeenVersion).toBe('0.3.0');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('answering the update question here replaces the toast', async ({ page }) => {
    await start(page, FRESH);
    const dialog = firstRun(page);
    await dialog.getByRole('switch', { name: 'Check for updates at startup' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await storedPreferences(page))?.checkUpdates).toBe(true);
    expect((await storedPreferences(page))?.onboarded).toBe(true);
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Check for updates at startup?' }),
    ).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__yagguiMock?.updateChecks ?? -1)).toBe(1);
  });

  test('an existing installation never sees it', async ({ page }) => {
    // Repositories in the store and the update question not answered yet.
    await start(page, 'mock.seedPreferences({ onboarded: false, checkUpdates: null });');
    await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Check for updates at startup?' }),
    ).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await storedPreferences(page))?.onboarded).toBe(true);
  });

  test('without Git, it says so and leads to the Git binary setting', async ({ page }) => {
    await start(page, `${FRESH} mock.gitDetected = false;`);
    const dialog = firstRun(page);
    await expect(dialog).toContainText('none was found on this computer');
    await capture(page, 'first-run-no-git.png');

    await dialog.getByRole('button', { name: 'How to install Git' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__yagguiMock?.openedDocs ?? []))
      .toEqual(['https://yaggui.tropico.dev/docs/start-here/install/#requirements']);

    await dialog.getByRole('button', { name: 'Choose the Git binary…' }).click();
    await expect(dialog).toBeHidden();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs.getByRole('textbox', { name: 'Git binary' })).toBeVisible();
    await expect.poll(async () => (await storedPreferences(page))?.onboarded).toBe(true);
  });

  test('shows the current shortcuts, a rebinding included, and links to all of them', async ({
    page,
  }) => {
    await start(
      page,
      `${FRESH} mock.settings.setKeybindings([{ action: 'git.commit', shortcut: 'Alt+C' }]);`,
    );
    const shortcuts = firstRun(page).getByRole('region', { name: 'Shortcuts' });
    await expect(shortcuts).toContainText('Commit');
    await expect(shortcuts.locator('kbd')).toContainText(['Alt', 'C']);
    await shortcuts.getByRole('button', { name: 'All shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  test('"Open the documentation" opens the docs home in the interface language', async ({
    page,
  }) => {
    await start(page, FRESH);
    await firstRun(page).getByRole('button', { name: 'Open the documentation' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__yagguiMock?.openedDocs ?? []))
      .toEqual(['https://yaggui.tropico.dev/docs/']);
    await expect(firstRun(page)).toBeVisible();
  });

  test('can be shown again from the palette and the preferences', async ({ page }) => {
    await start(page, '');
    await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('first-launch');
    await expect(
      page.getByRole('listbox', { name: 'Command palette' }).getByRole('option').first(),
    ).toContainText('Show the first-launch screen again');
    await page.keyboard.press('Enter');
    await expect(firstRun(page)).toBeVisible();
    await firstRun(page).getByRole('button', { name: 'Start' }).click();

    await page.keyboard.press('ControlOrMeta+,');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByRole('searchbox', { name: 'Search settings' }).fill('first-launch');
    await prefs.getByRole('button', { name: 'Show again' }).click();
    await expect(prefs).toBeHidden();
    await expect(firstRun(page)).toBeVisible();
  });
});

test.describe("What's new after an update", () => {
  test.use({ locale: 'en-US' });

  test('stays closed when turned off, and the version is still recorded', async ({ page }) => {
    await start(
      page,
      "mock.previousVersion('0.2.0'); mock.seedPreferences({ showWhatsNew: false });",
    );
    await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
    await expect.poll(async () => (await storedPreferences(page))?.lastSeenVersion).toBe('0.3.0');
    await expect(whatsNew(page)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+,');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByRole('searchbox', { name: 'Search settings' }).fill("what's new after");
    const toggle = prefs.getByRole('switch', { name: "Show What's new after an update" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect.poll(async () => (await storedPreferences(page))?.showWhatsNew).toBe(true);
  });

  test('a fresh install records the version without opening it', async ({ page }) => {
    await start(page, FRESH);
    await expect(firstRun(page)).toBeVisible();
    await expect(whatsNew(page)).toHaveCount(0);
    await expect.poll(async () => (await storedPreferences(page))?.lastSeenVersion).toBe('0.3.0');
  });
});
