import { expect, test, type Page } from '@playwright/test';

import type { MockBackend } from '../src/ipc/mockClient';

type UpdateInfo = NonNullable<MockBackend['availableUpdate']>;
type InstallChannel = UpdateInfo['channel'];

/** Update check (SPEC §10): opt-in question, notices per install channel, install progress. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

function release(channel: InstallChannel): UpdateInfo {
  return { currentVersion: '0.1.0', version: '0.2.0', notes: null, date: null, channel };
}

/** Starts the app with the mock prepared before it reads the preferences. */
async function start(
  page: Page,
  setup: { checkUpdates: boolean | null; update: UpdateInfo | null },
) {
  await page.addInitScript(({ checkUpdates, update }) => {
    window.__yagguiMockSetup = (mock) => {
      mock.seedPreferences({ checkUpdates });
      mock.availableUpdate = update;
    };
  }, setup);
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to yaggui' })).toBeVisible();
}

function mockCounter(page: Page, name: 'updateChecks' | 'updateInstalls' | 'releasePageOpens') {
  return page.evaluate((key) => window.__yagguiMock?.[key] ?? -1, name);
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 800 } });

    test('asks once at the first launch, and checks nothing before a yes', async ({ page }) => {
      await start(page, { checkUpdates: null, update: release('selfUpdate') });
      const question = page
        .getByRole('listitem')
        .filter({ hasText: 'Check for updates at startup?' });
      await expect(question).toBeVisible();
      expect(await mockCounter(page, 'updateChecks')).toBe(0);
      await capture(page, `updates-opt-in-${theme}.png`);

      await question.getByRole('button', { name: 'Check for updates' }).click();
      await expect(
        page.getByRole('listitem').filter({ hasText: 'yaggui 0.2.0 is available' }),
      ).toBeVisible();
      expect(await mockCounter(page, 'updateChecks')).toBe(1);

      // Answered: the next launches check without asking (the init script would ask again).
      const stored = await page.evaluate(async () => {
        const result = await window.__yagguiMock?.commands.getPreferences();
        return result?.status === 'ok' ? result.data.checkUpdates : undefined;
      });
      expect(stored).toBe(true);
    });

    test('updates a release install in place, with progress', async ({ page }) => {
      await start(page, { checkUpdates: true, update: release('selfUpdate') });
      const notice = page.getByRole('listitem').filter({ hasText: 'yaggui 0.2.0 is available' });
      await expect(notice).toContainText('You have 0.1.0');
      await capture(page, `updates-available-${theme}.png`);

      await notice.getByRole('button', { name: 'Update and restart' }).click();
      const progress = page.getByRole('listitem').filter({ hasText: 'Downloading yaggui 0.2.0…' });
      await expect(progress).toContainText('42%');
      expect(await mockCounter(page, 'updateInstalls')).toBe(1);
      await capture(page, `updates-downloading-${theme}.png`);
    });

    test('hands a Homebrew install to Homebrew', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await start(page, { checkUpdates: true, update: release('homebrew') });
      const notice = page.getByRole('listitem').filter({ hasText: 'yaggui 0.2.0 is available' });
      await expect(notice).toContainText('brew update && brew upgrade --cask yaggui');
      await capture(page, `updates-homebrew-${theme}.png`);

      await notice.getByRole('button', { name: 'Copy the command' }).click();
      await expect(page.getByRole('listitem').filter({ hasText: 'Command copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'brew update && brew upgrade --cask yaggui',
      );
      expect(await mockCounter(page, 'updateInstalls')).toBe(0);
    });

    test('sends a .deb or .rpm install to the release page', async ({ page }) => {
      await start(page, { checkUpdates: true, update: release('manual') });
      const notice = page.getByRole('listitem').filter({ hasText: 'yaggui 0.2.0 is available' });
      await notice.getByRole('button', { name: 'Open the release page' }).click();
      await expect.poll(() => mockCounter(page, 'releasePageOpens')).toBe(1);
    });

    test('the palette and the preferences check on demand', async ({ page }) => {
      await start(page, { checkUpdates: false, update: null });
      expect(await mockCounter(page, 'updateChecks')).toBe(0);

      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('>check for updates');
      const options = page.getByRole('listbox', { name: 'Command palette' }).getByRole('option');
      await expect(options.first()).toContainText('Check for updates');
      await page.keyboard.press('Enter');
      const answer = page.getByRole('listitem').filter({ hasText: 'yaggui is up to date' });
      await expect(answer).toBeVisible();
      await answer.getByRole('button', { name: 'Close' }).click();

      await page.keyboard.press('Control+,');
      const prefs = page.getByRole('dialog', { name: 'Preferences' });
      await prefs.getByRole('tab', { name: 'Behavior', exact: true }).click();
      const toggle = prefs.getByRole('switch', { name: 'Check for updates at startup' });
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await prefs.getByRole('button', { name: 'Check now' }).scrollIntoViewIfNeeded();
      await capture(page, `updates-preferences-${theme}.png`);
      await prefs.getByRole('button', { name: 'Check now' }).click();
      await expect.poll(() => mockCounter(page, 'updateChecks')).toBe(2);
    });
  });
}
