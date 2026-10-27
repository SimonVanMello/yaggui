import { expect, test, type Page } from '@playwright/test';

/** Opt-in cloud on the tags a remote holds, and its preference, on the mock backend. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`remote-tags-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openYaggui(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui/);
}

/** Brings the first tag of the sidebar into the graph and returns its label there. */
async function tagPill(page: Page) {
  const tree = page.getByRole('tree');
  const tags = tree.getByRole('treeitem', { name: /^Tags/ });
  if ((await tags.getAttribute('aria-expanded')) !== 'true') await tags.click();
  const first = tree.getByRole('treeitem', { name: /^v\d/ }).first();
  const name = ((await first.textContent()) ?? '').match(/v[\d.]+/)?.[0] ?? '';
  await first.click();
  const pill = page.locator(`[data-row] [data-ref-kind="tag"][data-ref-name="${name}"]`);
  await expect(pill).toBeVisible();
  return { pill, name };
}

const prefsDialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });
const toastWith = (page: Page, text: string) => page.locator('ol > li').filter({ hasText: text });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1280, height: 900 } });

    test('the preference explains itself, then tags on a remote get a cloud', async ({ page }) => {
      await openYaggui(page);
      const { pill, name } = await tagPill(page);
      const cloud = pill.getByLabel('on origin');
      await expect(cloud).toHaveCount(0);

      // Off by default, nothing asked: push the tag first, the cloud waits for the preference.
      await pill.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Push the tag/ }).click();
      const origin = page.getByRole('menuitem', { name: 'origin', exact: true });
      if (await origin.isVisible()) await origin.click();
      await expect(toastWith(page, `Tag ${name}`)).toBeVisible();
      await expect(cloud).toHaveCount(0);
      expect(await page.evaluate(() => window.__yagguiMock?.remoteTagRequests.length)).toBe(0);

      await page.keyboard.press('Control+,');
      await expect(prefsDialog(page)).toBeVisible();
      await prefsDialog(page).getByRole('tab', { name: 'Behavior', exact: true }).click();
      const toggle = prefsDialog(page).getByRole('switch', { name: /Show tags on the remotes/ });
      await expect(toggle).not.toBeChecked();
      await prefsDialog(page).getByText('Learn more').click();
      await expect(prefsDialog(page).getByText('Good to know')).toBeVisible();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await capture(page, theme, 'preference');
      await page.keyboard.press('Escape');

      await expect(cloud).toBeVisible();
      await expect(pill).toHaveAttribute('title', `${name} — on origin`);
      await capture(page, theme, 'graph');
    });
  });
}
