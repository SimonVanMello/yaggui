import { expect, test, type Page } from '@playwright/test';

/**
 * M4-7a: commit message helpers (Conventional Commits, templates, recent messages), identity
 * profiles, signing state and badge, "Add to .gitignore" and the stash of selected files, on
 * the mock backend.
 */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`${state}-${theme}.png`),
    animations: 'disabled',
  });
}

async function openRepo(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
}

const unstaged = (page: Page) => page.getByRole('listbox', { name: 'Unstaged', exact: true });
const file = (list: ReturnType<typeof unstaged>, path: string) =>
  list.getByRole('option').and(list.locator(`[title="${path}"]`));
const summary = (page: Page) => page.getByRole('textbox', { name: 'Commit summary' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('conventional header, recent messages, templates, identity and signing', async ({
      page,
    }) => {
      await openRepo(page);
      await expect(page.getByText('Signed · SSH')).toBeVisible();

      await page.getByRole('button', { name: 'Conventional' }).click();
      const header = page.getByRole('group', { name: 'Conventional Commits header' });
      await header.getByRole('combobox', { name: 'Type' }).selectOption('fix');
      await expect(summary(page)).toHaveValue('fix: ');
      await header.getByRole('combobox', { name: 'scope' }).fill('staging');
      await summary(page).focus();
      await page.keyboard.press('End');
      await page.keyboard.type('keep the selection');
      await expect(summary(page)).toHaveValue('fix(staging): keep the selection');
      await expect(header.getByText('subject 18/50')).toBeVisible();
      await capture(page, theme, 'commit-conventional');

      await page.getByRole('button', { name: 'Recent messages' }).click();
      await expect(page.getByRole('menuitem')).toHaveCount(3);
      await capture(page, theme, 'commit-recent');
      await page.getByRole('menuitem', { name: /refactor\(ipc\)/ }).click();
      await expect(summary(page)).toHaveValue('refactor(ipc): split the mock client');
      await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue(
        'One module per feature.',
      );

      await page.getByRole('button', { name: 'Message templates' }).click();
      await capture(page, theme, 'commit-templates-menu');
      await page.getByRole('menuitem', { name: /^feat:/ }).click();
      await expect(summary(page)).toHaveValue('feat: ');

      await page.getByRole('button', { name: 'Commit identity' }).click();
      await capture(page, theme, 'commit-identity-menu');
      await page.getByRole('menuitem', { name: /^Work/ }).click();
      await expect(page.getByRole('button', { name: 'Commit identity' })).toContainText(
        'alex.martin@example.com',
      );
      await expect(page.getByRole('button', { name: 'Commit identity' })).toContainText('Work');
    });

    test('templates and identity profiles dialogs', async ({ page }) => {
      await openRepo(page);
      await page.getByRole('button', { name: 'Message templates' }).click();
      await page.getByRole('menuitem', { name: 'Manage templates…' }).click();
      const templates = page.getByRole('dialog', { name: 'Message templates' });
      await templates.getByLabel('Name').fill('Release');
      await templates
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill('chore(release): v\n\nChangelog:');
      await templates.getByRole('button', { name: 'Add template' }).click();
      await expect(templates.getByRole('listitem')).toHaveCount(2);
      await capture(page, theme, 'templates-dialog');
      await templates.getByRole('button', { name: 'Close' }).first().click();

      await page.getByRole('button', { name: 'Message templates' }).click();
      await page.getByRole('menuitem', { name: /Release/ }).click();
      await expect(summary(page)).toHaveValue('chore(release): v');

      await page.getByRole('button', { name: 'Commit identity' }).click();
      await page.getByRole('menuitem', { name: 'Manage profiles…' }).click();
      const profiles = page.getByRole('dialog', { name: 'Identity profiles' });
      await expect(profiles.getByRole('button', { name: 'In use' })).toBeVisible();
      await profiles.getByLabel('Label').fill('Open source');
      await profiles.getByLabel('Name').fill('Alex M.');
      await profiles.getByLabel('Email').fill('alex@oss.example.com');
      await profiles.getByRole('button', { name: 'Add profile' }).click();
      await expect(profiles.getByRole('listitem')).toHaveCount(3);
      await capture(page, theme, 'profiles-dialog');
    });

    test('add an untracked file to .gitignore, then undo', async ({ page }) => {
      await openRepo(page);
      await file(unstaged(page), 'notes/todo.md').click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Add to .gitignore…' })).toBeVisible();
      await capture(page, theme, 'file-context-menu');
      await page.getByRole('menuitem', { name: 'Add to .gitignore…' }).click();

      const dialog = page.getByRole('dialog', { name: 'Add to .gitignore' });
      await expect(dialog.getByLabel('Rule added')).toHaveText('/notes/todo.md');
      await dialog.getByRole('radio', { name: 'Its folder' }).check();
      await expect(dialog.getByLabel('Rule added')).toHaveText('/notes/');
      await expect(dialog.getByText('Hides 1 untracked file:')).toBeVisible();
      await capture(page, theme, 'gitignore-dialog');
      await dialog.getByRole('radio', { name: 'Every file with this extension' }).check();
      await expect(dialog.getByLabel('Rule added')).toHaveText('*.md');
      await dialog.getByRole('radio', { name: 'Its folder' }).check();
      await dialog.getByRole('button', { name: 'Add rule' }).click();

      await expect(file(unstaged(page), 'notes/todo.md')).toHaveCount(0);
      await expect(file(unstaged(page), '.gitignore')).toBeVisible();

      await page.getByRole('button', { name: 'Undo: addition of /notes/ to .gitignore' }).click();
      await expect(file(unstaged(page), 'notes/todo.md')).toBeVisible();
      await expect(file(unstaged(page), '.gitignore')).toHaveCount(0);
    });

    test('stash two selected files, then undo', async ({ page }) => {
      await openRepo(page);
      await file(unstaged(page), 'README.md').click();
      await file(unstaged(page), 'src/ui/Icon.tsx').click({ modifiers: ['ControlOrMeta'] });
      await file(unstaged(page), 'src/ui/Icon.tsx').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Stash 2 files…' }).click();

      const dialog = page.getByRole('dialog', { name: 'Stash 2 files' });
      await dialog.getByLabel('Message').fill('icons and readme');
      await capture(page, theme, 'stash-files-dialog');
      await dialog.getByRole('button', { name: 'Stash 2 files' }).click();

      await expect(file(unstaged(page), 'README.md')).toHaveCount(0);
      await expect(file(unstaged(page), 'src/ui/Icon.tsx')).toHaveCount(0);
      await expect(file(unstaged(page), 'src/features/tabs/TabBar.tsx')).toBeVisible();
      await expect(page.getByRole('treeitem', { name: 'icons and readme' })).toBeVisible();
      // The graph names the stash by its message, not by `stash@{0}` (here in the `+N` chip).
      const more = page
        .locator('[data-row]')
        .getByLabel(/^\d+ more refs$/)
        .first();
      await expect(more).toHaveAttribute('title', /^icons and readme$/m);

      await page.getByRole('button', { name: 'Undo: stash of 2 files' }).click();
      await expect(page.getByRole('treeitem', { name: 'icons and readme' })).toHaveCount(0);
      await expect(file(unstaged(page), 'README.md')).toBeVisible();
      await expect(file(unstaged(page), 'src/ui/Icon.tsx')).toBeVisible();
    });

    test('signature badge in the commit details', async ({ page }) => {
      await openRepo(page);
      const graph = page.getByRole('listbox', { name: 'Commit graph' });
      const details = page.getByRole('region', { name: 'Commit details' });
      const badge = details.getByText(/^(Verified|Signed, not verified) \((SSH|GPG)\)$/);
      for (let row = 1; row < 40; row++) {
        await graph.getByRole('option').nth(row).click();
        await expect(details).toBeVisible();
        await expect(details.getByRole('heading')).toBeVisible();
        if ((await details.getByText('Signature', { exact: false }).count()) > 0) break;
      }
      await expect(badge).toBeVisible();
      await capture(page, theme, 'signature-badge');
    });
  });
}
