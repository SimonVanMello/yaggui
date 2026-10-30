import { expect, test, type Page } from '@playwright/test';

import type { MockBackend } from '../src/ipc/mockClient';

/** Logs and bug reports (F-304): crash notice, Troubleshooting settings, palette commands. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

type Crash = MockBackend['pendingCrashes'][number];

const CRASH: Crash = {
  file: '/home/me/.local/share/dev.tropico.yaggui/logs/crash-1791795000000-4242.txt',
  at: 1_791_795_000,
  message: 'index out of bounds: the len is 3 but the index is 7',
};

async function start(page: Page, crashes: Crash[] = []) {
  await page.addInitScript((pending) => {
    window.__yagguiMockSetup = (mock) => {
      mock.seedPreferences({ checkUpdates: false });
      mock.pendingCrashes = pending;
    };
  }, crashes);
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

function mockCounter(page: Page, name: 'logsFolderOpens' | 'issueTrackerOpens') {
  return page.evaluate((key) => window.__yagguiMock?.[key] ?? -1, name);
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

async function openTroubleshooting(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: 'General', exact: true })
    .click();
  const report = prefs.getByRole('button', { name: 'Report a bug…' });
  await report.scrollIntoViewIfNeeded();
  return prefs;
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({
      colorScheme,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });

    test('tells once about a crash of an earlier session', async ({ page }) => {
      await start(page, [CRASH]);
      const notice = page.getByRole('listitem').filter({
        hasText: 'yaggui ran into an internal error during an earlier session',
      });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(CRASH.message);
      await expect
        .poll(() => page.evaluate(() => window.__yagguiMock?.pendingCrashes.length))
        .toBe(0);
      await capture(page, `diagnostics-crash-notice-${theme}.png`);

      await notice.getByRole('button', { name: 'Report it' }).click();
      await expect.poll(() => mockCounter(page, 'issueTrackerOpens')).toBe(1);
      const report = await page.evaluate(() => navigator.clipboard.readText());
      expect(report).toContain('### Environment');
    });

    test('the Troubleshooting settings report a bug and open the logs', async ({ page }) => {
      await start(page);
      const prefs = await openTroubleshooting(page);
      await expect(prefs).toContainText('Troubleshooting');
      await expect(prefs).toContainText('Logs and bug reports');
      await capture(page, `diagnostics-preferences-${theme}.png`);

      await prefs.getByRole('button', { name: 'Open logs folder' }).click();
      await expect.poll(() => mockCounter(page, 'logsFolderOpens')).toBe(1);

      await prefs.getByRole('button', { name: 'Copy report' }).click();
      await expect(
        // The modal hides the rest of the page from the accessibility tree, not from view.
        page.locator('li').filter({ hasText: 'Diagnostic report copied' }),
      ).toBeVisible();
      expect(await mockCounter(page, 'issueTrackerOpens')).toBe(0);

      await prefs.getByRole('button', { name: 'Report a bug…' }).click();
      await expect.poll(() => mockCounter(page, 'issueTrackerOpens')).toBe(1);
      await expect(
        page
          .locator('li')
          .filter({ hasText: 'Diagnostic report copied: paste it into the bug form' }),
      ).toBeVisible();
      await capture(page, `diagnostics-report-copied-${theme}.png`);
    });
  });
}

test.describe('commands and error forwarding', () => {
  test.use({ locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });

  test('the palette opens the logs folder and reports a bug', async ({ page }) => {
    await start(page);
    const palette = page.getByRole('listbox', { name: 'Command palette' });
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('open logs folder');
    await expect(palette.getByRole('option').first()).toContainText('Open logs folder');
    await page.keyboard.press('Enter');
    await expect.poll(() => mockCounter(page, 'logsFolderOpens')).toBe(1);

    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('report a bug');
    await expect(palette.getByRole('option').first()).toContainText('Report a bug…');
    await page.keyboard.press('Enter');
    await expect.poll(() => mockCounter(page, 'issueTrackerOpens')).toBe(1);
  });

  test('an uncaught error lands in the session log', async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      void Promise.reject(new Error('nobody caught me'));
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.__yagguiMock?.frontendErrors.map((error) => error.message)),
      )
      .toContain('Error: nobody caught me');
  });
});

test.describe('French', () => {
  test.use({ locale: 'fr-FR' });

  test('labels go through the French catalog', async ({ page }) => {
    await page.addInitScript(() => {
      window.__yagguiMockSetup = (mock) => {
        mock.seedPreferences({ checkUpdates: false });
      };
    });
    await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+,');
    const prefs = page.getByRole('dialog', { name: 'Préférences' });
    await expect(prefs).toContainText('Dépannage');
    await expect(prefs.getByRole('button', { name: 'Signaler un bug…' })).toBeVisible();
    await expect(
      prefs.getByRole('button', { name: 'Ouvrir le dossier des journaux' }),
    ).toBeVisible();
  });
});
