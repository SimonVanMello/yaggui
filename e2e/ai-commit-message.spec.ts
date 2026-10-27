import { expect, test, type Page } from '@playwright/test';

/** M10-2: AI commit messages (F-072 to F-075): preferences tab and commit area, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`ai-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

interface Setup {
  enabled: boolean;
  /** An API key is saved, so the Claude API provider is ready. */
  key: boolean;
  latencyMs?: number;
}

async function start(page: Page, setup: Setup) {
  await page.addInitScript((s) => {
    window.__yagguiMockSetup = (mock) => {
      mock.seedPreferences({ aiEnabled: s.enabled });
      if (s.key) mock.simulateAiSetup({ keySource: 'keychain' });
      if (s.latencyMs !== undefined) mock.simulateAiLatency(s.latencyMs);
    };
  }, setup);
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
}

async function openYaggui(page: Page) {
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
}

async function openAiTab(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  const dialog = page.getByRole('dialog', { name: 'Preferences' });
  await dialog.getByRole('tab', { name: 'AI' }).click();
  return dialog;
}

const summary = (page: Page) => page.getByRole('textbox', { name: 'Commit summary' });
const description = (page: Page) => page.getByRole('textbox', { name: 'Description (optional)' });
const sparkle = (page: Page) =>
  page.getByRole('button', { name: /^Generate a commit message with AI/ });
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('the AI tab: switch, API key, Claude Code, test', async ({ page }) => {
      await start(page, { enabled: false, key: false, latencyMs: 50 });
      const dialog = await openAiTab(page);
      const enable = dialog.getByRole('switch', { name: /AI commit messages/ });
      await expect(enable).not.toBeChecked();
      await expect(dialog.getByText('What leaves your machine')).toBeVisible();
      await expect(dialog.getByText('No key saved')).toBeVisible();
      await capture(page, theme, 'tab-off');

      await enable.click();
      await expect(enable).toBeChecked();

      // The key is write-only: only its source comes back.
      await dialog.getByLabel('API key').fill('sk-ant-test-key');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByText('Key saved in the keychain')).toBeVisible();
      await expect(dialog.getByLabel('API key')).toHaveValue('');
      await expect(dialog.getByRole('button', { name: 'Remove' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(dialog.getByText(/Claude API answered in/)).toBeVisible();
      await capture(page, theme, 'tab-api');

      await dialog.getByRole('radio', { name: 'Claude Code' }).click();
      await expect(dialog.getByText(/Detected: \/usr\/local\/bin\/claude/)).toBeVisible();
      await dialog.getByLabel('Skill').fill('com');
      await expect(dialog.getByLabel('Skill')).toHaveValue('com');
      await dialog.getByLabel('Skill').fill('commit');
      await dialog.getByLabel('Skill').blur();
      await expect(dialog.getByText(/yours · Write a commit message/)).toBeVisible();
      await capture(page, theme, 'tab-claude-code');

      await page.evaluate(() => window.__yagguiMock?.simulateAiFailure('aiAuthFailed'));
      await dialog.getByRole('button', { name: 'Test', exact: true }).click();
      await expect(dialog.getByText(/Claude Code is not logged in/)).toBeVisible();
      await capture(page, theme, 'tab-test-error');
    });

    test('the prompt follows the built-in one until it is edited, and resets', async ({ page }) => {
      await start(page, { enabled: true, key: true });
      const dialog = await openAiTab(page);
      const prompt = dialog.getByLabel('Instructions');
      await expect(prompt).toHaveValue(/You write the Git commit message for the changes/);
      await expect(dialog.getByText('Built-in prompt, kept up to date by yaggui.')).toBeVisible();

      await prompt.fill('Write haiku commit messages.');
      await prompt.blur();
      await expect(dialog.getByText(/Customized/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Reset to default' }).click();
      await expect(prompt).toHaveValue(/You write the Git commit message for the changes/);
      await expect(dialog.getByText('Built-in prompt, kept up to date by yaggui.')).toBeVisible();

      // Typing the built-in text back is saved as "follow the default" too.
      await prompt.fill('Something else');
      await prompt.blur();
      await expect(dialog.getByText(/Customized/)).toBeVisible();
      await capture(page, theme, 'tab-prompt');
    });

    test('the preview shows the exact context', async ({ page }) => {
      await start(page, { enabled: true, key: true });
      await openYaggui(page);
      const dialog = await openAiTab(page);
      await dialog.getByRole('button', { name: 'Show what would be sent' }).click();
      const preview = page.getByRole('dialog', { name: 'Context sent to the provider' });
      await expect(preview.getByRole('textbox')).toHaveValue(/Changed files:/);
      await expect(preview.getByText(/changed files · .* sent/)).toBeVisible();
      await capture(page, theme, 'preview');
    });

    test('the sparkle is hidden while the feature is off', async ({ page }) => {
      await start(page, { enabled: false, key: true });
      await openYaggui(page);
      await expect(summary(page)).toBeVisible();
      await expect(sparkle(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Set up AI commit messages' })).toHaveCount(0);
    });

    test('without a provider ready, the sparkle opens the AI preferences', async ({ page }) => {
      await start(page, { enabled: true, key: false });
      await openYaggui(page);
      await page.getByRole('button', { name: 'Set up AI commit messages' }).click();
      const dialog = page.getByRole('dialog', { name: 'Preferences' });
      await expect(dialog.getByRole('tab', { name: 'AI' })).toHaveAttribute('data-state', 'active');
      await expect(dialog.getByText('No key saved')).toBeVisible();
    });

    test('generates, can be cancelled, and the previous message comes back', async ({ page }) => {
      await start(page, { enabled: true, key: true, latencyMs: 1500 });
      await openYaggui(page);
      await summary(page).fill('wip: my draft');
      await description(page).fill('notes to self');
      await capture(page, theme, 'commit-idle');

      // Cancel: nothing changes.
      await sparkle(page).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Writing the message…' }),
      ).toBeVisible();
      await capture(page, theme, 'commit-generating');
      await page.getByRole('button', { name: 'Cancel the generation' }).click();
      await expect(sparkle(page)).toBeVisible();
      await expect(summary(page)).toHaveValue('wip: my draft');
      await expect(toastWith(page, 'Could not generate')).toHaveCount(0);

      // Generate for real.
      await page.evaluate(() => window.__yagguiMock?.simulateAiLatency(50));
      await sparkle(page).click();
      await expect(summary(page)).toHaveValue(/^Update 2 files/);
      await expect(description(page)).toHaveValue(/Changes:/);
      const done = toastWith(page, 'Message generated');
      await expect(done).toBeVisible();
      await capture(page, theme, 'commit-generated');

      await done.getByRole('button', { name: 'Restore previous message' }).click();
      await expect(summary(page)).toHaveValue('wip: my draft');
      await expect(description(page)).toHaveValue('notes to self');
      await expect(page.getByRole('button', { name: 'Restore previous message' })).toHaveCount(0);
    });

    test('the inline button restores until the result is edited', async ({ page }) => {
      await start(page, { enabled: true, key: true, latencyMs: 50 });
      await openYaggui(page);
      await summary(page).fill('wip: my draft');
      await sparkle(page).click();
      await expect(summary(page)).toHaveValue(/^Update 2 files/);
      // The button of the commit area, not the one of the toast.
      const restore = page.locator('button[aria-label="Restore previous message"]:not(ol *)');
      await expect(restore).toBeVisible();
      await summary(page).fill('feat: edited by hand');
      await expect(restore).toHaveCount(0);
      // The toast's button no longer overwrites what was typed since.
      await page
        .locator('ol > li')
        .getByRole('button', { name: 'Restore previous message' })
        .click();
      await expect(summary(page)).toHaveValue('feat: edited by hand');
      await expect(toastWith(page, 'edited since')).toBeVisible();
    });

    test('a typed error offers its action, and the shortcut runs the generation', async ({
      page,
    }) => {
      await start(page, { enabled: true, key: true, latencyMs: 50 });
      await openYaggui(page);
      await page.evaluate(() => window.__yagguiMock?.simulateAiFailure('aiRateLimited'));
      await page.keyboard.press('ControlOrMeta+Shift+M');
      const failure = toastWith(page, 'Could not generate a message');
      await expect(failure).toBeVisible();
      await expect(failure).toContainText('limits requests');
      await capture(page, theme, 'commit-error');
      await failure.getByRole('button', { name: 'Retry' }).click();
      await expect(summary(page)).toHaveValue(/^Update 2 files/);
    });

    test('with the Conventional helper on, the header fills its fields', async ({ page }) => {
      await start(page, { enabled: true, key: true, latencyMs: 50 });
      await openYaggui(page);
      await page.getByRole('button', { name: 'Conventional', exact: true }).click();
      await sparkle(page).click();
      await expect(summary(page)).toHaveValue(/^[a-z]+(\([^)]+\))?: .+/);
      const fields = page.getByRole('group', { name: 'Conventional Commits header' });
      await expect(fields.getByLabel('Type')).not.toHaveValue('');
      await capture(page, theme, 'commit-conventional');
    });

    test('the palette action generates a message', async ({ page }) => {
      await start(page, { enabled: true, key: true, latencyMs: 50 });
      await openYaggui(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.getByRole('combobox').fill('commit message with AI');
      await page.getByRole('option', { name: /Generate a commit message with AI/ }).click();
      await expect(summary(page)).toHaveValue(/^Update 2 files/);
    });
  });
}
