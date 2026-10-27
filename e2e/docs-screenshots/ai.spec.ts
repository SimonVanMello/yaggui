import { expect, test, type Page } from '@playwright/test';

import { capture, openRepo, start } from './capture';

/** Screenshots of everyday/ai-commit-messages.mdx: the AI preferences tab and the commit area. */

const SETUP = `(mock) => {
  mock.seedPreferences({ aiEnabled: true });
  mock.simulateAiSetup({ keySource: 'keychain' });
  mock.simulateAiLatency(50);
}`;

const prefsDialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });
const summary = (page: Page) => page.getByRole('textbox', { name: 'Commit summary' });
const description = (page: Page) => page.getByRole('textbox', { name: 'Description (optional)' });

async function openAiTab(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  const dialog = prefsDialog(page);
  await dialog.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(dialog.getByText('What leaves your machine')).toBeVisible();
  return dialog;
}

test.use({ viewport: { width: 1280, height: 900 } });

test('ai-prefs', async ({ page }, testInfo) => {
  await start(page, SETUP);
  const dialog = await openAiTab(page);
  await dialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(dialog.getByText(/Claude API answered in/)).toBeVisible();
  await capture(page, testInfo, 'ai-prefs', dialog);
});

test('ai-prefs-claude-code', async ({ page }, testInfo) => {
  await start(page, SETUP);
  const dialog = await openAiTab(page);
  await dialog.getByRole('radio', { name: 'Claude Code' }).click();
  await expect(dialog.getByText(/Detected: \/usr\/local\/bin\/claude/)).toBeVisible();
  await dialog.getByLabel('Skill').fill('commit');
  await dialog.getByLabel('Skill').blur();
  await expect(dialog.getByText(/yours · Write a commit message/)).toBeVisible();
  await capture(page, testInfo, 'ai-prefs-claude-code', dialog);
});

test('ai-preview', async ({ page }, testInfo) => {
  await start(page, SETUP);
  await openRepo(page);
  const dialog = await openAiTab(page);
  await dialog.getByRole('button', { name: 'Show what would be sent' }).click();
  const preview = page.getByRole('dialog', { name: 'Context sent to the provider' });
  await expect(preview.getByRole('textbox')).toHaveValue(/Changed files:/);
  await expect(preview.getByText(/changed files · .* sent/)).toBeVisible();
  await capture(page, testInfo, 'ai-preview', preview);
});

test('ai-commit-area', async ({ page }, testInfo) => {
  await start(page, SETUP);
  await openRepo(page);
  const resizer = page.getByRole('separator', { name: 'Resize the right panel' });
  await resizer.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await resizer.blur();
  await page.addStyleTag({ content: 'footer { visibility: hidden; }' });
  await summary(page).fill('wip: my draft');
  await page.getByRole('button', { name: /^Generate a commit message with AI/ }).click();
  await expect(summary(page)).toHaveValue(/^Update 2 files/);
  await expect(
    page.locator('button[aria-label="Restore previous message"]:not(ol *)'),
  ).toBeVisible();
  // The toast would hide the commit button and stay in English in the French capture.
  await page.locator('ol > li').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('ol > li')).toHaveCount(0);
  await description(page).blur();
  const area = summary(page).locator(
    'xpath=ancestor::div[.//button[starts-with(normalize-space(.), "Commit on")]][1]',
  );
  await capture(page, testInfo, 'ai-commit-area', area);
});
