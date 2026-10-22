import { expect, test, type Page } from '@playwright/test';

/** M7-8: the tree at a commit on the mock backend. Captures go to test-results/. */

const MOCK_NOW_MS = 1_791_795_600_000;

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`tree-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const graphRow = (page: Page, index: number) => page.locator(`[data-row="${String(index)}"]`);
const details = (page: Page) => page.getByRole('region', { name: 'Commit details' });
const treeView = (page: Page) => page.getByRole('region', { name: /^Files at / });
const tree = (page: Page) => page.getByRole('tree', { name: 'Files and folders at this commit' });
// The accessible name of a row ends with the file size.
const item = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name.replace('.', '\\.')}( |$)`) });

async function openTree(page: Page) {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(graphRow(page, 0)).toBeVisible();
  await graphRow(page, 2).click();
  await details(page).getByRole('button', { name: 'Browse files at this commit' }).click();
  await expect(treeView(page)).toBeVisible();
  await expect(item(page, 'README.md')).toBeVisible();
}

test.use({ locale: 'en-US' });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('browses folders and reads a file with the keyboard', async ({ page }) => {
      await openTree(page);
      // Folders come first, then files by name.
      const names = await tree(page).getByRole('treeitem').locator('[title]').allTextContents();
      expect(names.slice(0, 4)).toEqual(['assets', 'data', 'docs', 'libs']);

      await tree(page).focus();
      await page.keyboard.press('ArrowDown');
      await expect(item(page, 'assets')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(item(page, 'assets')).toHaveAttribute('aria-expanded', 'true');
      await expect(item(page, 'logo.png')).toBeVisible();
      await page.keyboard.press('ArrowLeft');
      await expect(item(page, 'logo.png')).toHaveCount(0);

      await item(page, 'README.md').click();
      const file = treeView(page).getByRole('region', { name: 'Contents of README.md' });
      await expect(file.locator('.cm-editor')).toBeVisible();
      await expect(file.locator('.cm-line').first()).toContainText('//');
      // Read-only: nothing to type in.
      await expect(file.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
      await capture(page, theme, 'text');

      await page.keyboard.press('Escape');
      await expect(treeView(page)).toHaveCount(0);
      await expect(graphRow(page, 0)).toBeVisible();
    });

    test('shows each kind of file', async ({ page }) => {
      await openTree(page);
      await item(page, 'assets').click();
      await item(page, 'logo.png').click();
      await expect(treeView(page).getByRole('img', { name: 'assets/logo.png' })).toBeVisible();
      await capture(page, theme, 'image');
      await item(page, 'archive.bin').click();
      await expect(treeView(page).getByText(/^Binary file/)).toBeVisible();
      await item(page, 'model.bin').click();
      await expect(treeView(page).getByText(/Stored with Git LFS/)).toBeVisible();
      await capture(page, theme, 'lfs');

      await item(page, 'data').click();
      await item(page, 'huge-dump.txt').click();
      await expect(treeView(page).getByText(/showing it as text may slow/)).toBeVisible();
      await treeView(page).getByRole('button', { name: 'Show anyway' }).click();
      await expect(treeView(page).locator('.cm-editor')).toBeVisible();

      await item(page, 'libs').click();
      await item(page, 'vendored').click();
      await expect(treeView(page).getByText(/^Submodule pinned at/)).toBeVisible();
      await expect(treeView(page).getByRole('button', { name: 'Save as…' })).toBeDisabled();

      await item(page, 'docs').click();
      await item(page, 'readme-link').click();
      await expect(treeView(page).getByText('Symbolic link to ../README.md')).toBeVisible();
      await treeView(page).getByRole('button', { name: 'Go to the target' }).click();
      await expect(item(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
    });

    test('pages a large folder without blocking', async ({ page }) => {
      await openTree(page);
      await item(page, 'vendor').click();
      await item(page, 'many').click();
      await expect(item(page, 'file0000.txt')).toBeVisible();
      // The later pages arrive in the background: the last entry is reachable. After the
      // folder come the three files of the root.
      await expect(tree(page).getByText('Loading…')).toHaveCount(0);
      await tree(page).focus();
      await page.keyboard.press('End');
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
      await expect(item(page, 'file1199.txt')).toBeVisible();
      await expect(item(page, 'file1199.txt')).toHaveAttribute('aria-selected', 'true');
      await capture(page, theme, 'large-folder');
    });

    test('jumps to history and blame, saves a version', async ({ page }) => {
      await openTree(page);
      await item(page, 'README.md').click();
      const file = treeView(page).getByRole('region', { name: 'Contents of README.md' });
      await expect(file.locator('.cm-editor')).toBeVisible();

      await file.getByRole('button', { name: 'Save as…' }).click();
      await expect(page.getByText('Saved to ~/Downloads/README.md', { exact: true })).toBeVisible();

      await file.getByRole('button', { name: 'Blame at this commit' }).click();
      await expect(page.getByRole('region', { name: /^Blame of README\.md/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(graphRow(page, 0)).toBeVisible();

      await graphRow(page, 2).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Browse files at this commit' }).click();
      await expect(treeView(page)).toBeVisible();
      await item(page, 'README.md').click();
      await treeView(page).getByRole('button', { name: 'File history' }).click();
      await expect(page.getByRole('region', { name: /^History of README\.md/ })).toBeVisible();
    });

    test('opens from the palette on the selected commit', async ({ page }) => {
      await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
      await page.goto('/');
      await page.getByRole('option', { name: /^yaggui\b/ }).click();
      await graphRow(page, 3).click();
      await page.keyboard.press('ControlOrMeta+K');
      await page.getByRole('combobox', { name: 'Command palette' }).fill('>browse the files');
      await page.keyboard.press('Enter');
      await expect(treeView(page)).toBeVisible();
      await expect(item(page, 'README.md')).toBeVisible();
    });
  });
}
