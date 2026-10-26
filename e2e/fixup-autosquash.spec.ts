import { expect, test, type Page } from '@playwright/test';

/**
 * M7-3: "Create a fixup for this commit" in the commit menu, then "Autosquash" opening the
 * interactive rebase with the fixup already under its target (F-147), on the mock backend,
 * repository `yaggui`. M8-2: `squash!` and `amend!` commits arranged too.
 */

const MOCK_NOW_MS = 1_791_795_600_000;
// A toast's text is also announced in a live region: scope the match to the toast list.
const toastWith = (page: Page, text: string | RegExp) =>
  page.locator('ol > li').filter({ hasText: text });

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`fixup-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
}

/** The commit two below HEAD on the current branch, read from the mock. */
async function grandparent(page: Page): Promise<{ sha: string; summary: string }> {
  const commit = await page.evaluate(async () => {
    const mock = window.__yagguiMock;
    const plan = await mock?.commands.interactiveRebasePlan(1, 'HEAD~3');
    return plan?.status === 'ok' ? (plan.data.commits[0] ?? null) : null;
  });
  if (!commit) throw new Error('no commit two below HEAD');
  return commit;
}

const fixupItem = (page: Page) =>
  page.getByRole('menuitem', { name: /^Create a fixup for this commit/ });
const todo = (page: Page) => page.getByRole('listbox', { name: /^Commits to rebase/ });
const rows = (page: Page) => todo(page).getByRole('option');

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('fixup from the commit menu, then autosquash pre-arranged for review', async ({
      page,
    }) => {
      await openRepo(page);
      const target = await grandparent(page);
      const row = page.locator(`[data-row][data-sha="${target.sha}"]`);

      await page.getByRole('button', { name: 'Stage all', exact: true }).click();
      await row.click({ button: 'right' });
      await expect(fixupItem(page)).not.toHaveAttribute('aria-disabled', 'true');
      await capture(page, theme, 'menu');
      await fixupItem(page).click();
      await expect(toastWith(page, /Fixup [0-9a-f]{7} created for/)).toBeVisible();
      const fixupRow = page.locator('[data-row]').filter({ hasText: `fixup! ${target.summary}` });
      await expect(fixupRow.first()).toBeVisible();

      // The fixup commit has its own menu entry to autosquash.
      await fixupRow.first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Autosquash the fixups…' }).click();

      // From the parent of the target: target, fixup and the two commits after it.
      await expect(rows(page)).toHaveCount(4);
      await expect(page.getByText('1 commit moved under its target')).toBeVisible();
      // Newest first: the fixup sits right above its target, melded into it.
      await expect(rows(page).nth(2)).toHaveAttribute('data-action', 'fixup');
      await expect(rows(page).nth(2)).toContainText(`Melded into “${target.summary}”`);
      await expect(rows(page).nth(3)).toContainText(target.summary);
      const result = page.getByRole('region', { name: 'Result' });
      await expect(result).toContainText('3 commits');
      await expect(result).toContainText('1 melded');
      await capture(page, theme, 'autosquash');

      // Esc leaves the view without rebasing: the arranged list differs from the plan, so it
      // asks first.
      await todo(page).focus();
      await page.keyboard.press('Escape');
      const leave = page.getByRole('dialog');
      await expect(leave).toContainText('Discard the changes to the list?');
      await leave.getByRole('button', { name: 'Discard' }).click();
      await expect(todo(page)).toBeHidden();

      // Everything staged went into the fixup: the entry now says why it is unavailable.
      await row.click({ button: 'right' });
      await expect(fixupItem(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(fixupItem(page)).toContainText('Stage the changes of the fixup first');
      await capture(page, theme, 'menu-disabled');
    });

    test('squash! and amend! commits are arranged like git rebase --autosquash', async ({
      page,
    }) => {
      await openRepo(page);
      const target = await grandparent(page);
      await page.evaluate((summary) => {
        const mock = window.__yagguiMock;
        mock?.simulateCommit(1, `squash! ${summary}`, 'Also parse the header.');
        mock?.simulateCommit(1, `amend! ${summary}`, 'feat: parse the whole file\n\nReworded.');
        mock?.simulateCommit(1, `fixup! squash! ${summary}`);
      }, target.summary);
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('autosquash');
      await page.keyboard.press('Enter');

      // Target, then (newest first above it) squash!, amend!, fixup!, and the 2 commits after.
      await expect(rows(page)).toHaveCount(6);
      await expect(page.getByText('3 commits moved under their targets')).toBeVisible();
      await expect(rows(page).nth(5)).toContainText(target.summary);
      await expect(rows(page).nth(4)).toHaveAttribute('data-action', 'squash');
      await expect(rows(page).nth(3)).toHaveAttribute('data-action', 'fixup');
      await expect(rows(page).nth(3)).toHaveAttribute('data-amend', 'true');
      await expect(rows(page).nth(3)).toContainText('with this commit’s message (fixup -C)');
      await expect(rows(page).nth(2)).toHaveAttribute('data-action', 'fixup');
      // The amend! comes after the squash!: its message is added to the combination.
      await expect(rows(page).nth(3)).toContainText(target.summary);
      const result = page.getByRole('region', { name: 'Result' });
      await expect(result).toContainText('3 melded');
      await capture(page, theme, 'autosquash-squash-amend');
    });

    test('autosquash from the palette with no fixup says so', async ({ page }) => {
      await openRepo(page);
      await page.keyboard.press('ControlOrMeta+K');
      await page.keyboard.type('autosquash');
      await page.keyboard.press('Enter');
      await expect(
        toastWith(page, 'No fixup!, squash! or amend! commit to squash on this branch'),
      ).toBeVisible();
      await expect(todo(page)).toBeHidden();
    });
  });
}
