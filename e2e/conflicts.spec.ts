import { expect, test, type Page } from '@playwright/test';

/** M3-3: conflict views (3-way editor, deletion / binary choice) on the mock backend. */

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

/** Opens `yaggui` (mock id 1) stopped on the mock's 4 conflicts by a merge or a rebase. */
async function stopOn(page: Page, kind: 'merge' | 'rebase') {
  await page.clock.setFixedTime(new Date(MOCK_NOW_MS));
  await page.goto('/');
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^yaggui\b/);
  await page.evaluate((k) => window.__yagguiMock?.simulateOperation(1, k), kind);
}

const center = (page: Page) => page.getByRole('main');
const conflictsPanel = (page: Page) => page.getByRole('region', { name: 'Conflicts' });
const banner = (page: Page) => page.getByRole('status', { name: 'Operation in progress' });

/** M3-2's entry point: the conflicts panel of the working copy, "Resolve…" on a file. */
async function openFile(page: Page, path: string) {
  if (!(await conflictsPanel(page).isVisible())) {
    await page.getByRole('button', { name: 'Show conflicts' }).first().click();
  }
  await conflictsPanel(page)
    .getByRole('listitem')
    .filter({ has: page.locator(`[title="${path}"]`) })
    .getByRole('button', { name: 'Resolve…' })
    .click();
  await expect(center(page).locator(`[data-view="conflict:${path}"]`)).toBeVisible();
}

const checkbox = (page: Page, n: number, name: string) =>
  page.getByRole('checkbox', { name: `Keep conflict ${String(n)} from ${name}` });

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('binary conflict: explicit choice with sizes and previews', async ({ page }) => {
      await stopOn(page, 'merge');
      await openFile(page, 'assets/logo.png');
      await expect(page.getByText('Binary file changed on both sides')).toBeVisible();
      await expect(page.getByRole('img', { name: 'Preview of assets/logo.png' })).toHaveCount(2);
      await capture(page, theme, 'conflict-binary');
    });

    test('deletion against modification', async ({ page }) => {
      await stopOn(page, 'merge');
      await openFile(page, 'docs/legacy.md');
      await expect(page.getByRole('button', { name: 'Keep the changed version' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Accept the deletion' })).toBeVisible();
      await capture(page, theme, 'conflict-deleted');
    });

    test('3-way editor in a merge: checkboxes, order, counter and save', async ({ page }) => {
      await stopOn(page, 'merge');
      await openFile(page, 'src/app/App.tsx');
      const status = page.getByRole('status').filter({ hasText: /conflict left|blocks resolved/ });
      await expect(status).toHaveText('1 conflict left');
      await expect(page.locator('.cm-editor')).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Save and mark resolved' })).toBeDisabled();
      await capture(page, theme, 'conflict-editor');

      // Theirs first, then ours: both kept in the order ticked.
      const ours = await page.locator('[data-side="ours"] strong').first().innerText();
      const theirs = await page.locator('[data-side="theirs"] strong').first().innerText();
      await checkbox(page, 1, theirs).first().check();
      await checkbox(page, 1, ours).first().check();
      await expect(status).toHaveText('All blocks resolved');
      const result = page.getByRole('textbox', { name: 'Result' });
      await expect(result).toContainText('useState(10)');
      await expect(result).toContainText('useState(1)');
      const text = await result.innerText();
      expect(text.indexOf('useState(10)')).toBeLessThan(text.indexOf('useState(1);'));
      await capture(page, theme, 'conflict-editor-resolved');

      await page.getByRole('button', { name: 'Save and mark resolved' }).click();
      await expect(
        center(page).locator('[data-view="conflict:src/theme/colors.ts"]'),
      ).toBeVisible();
    });

    test('3-way editor in a rebase shows the rebase roles', async ({ page }) => {
      await stopOn(page, 'rebase');
      await openFile(page, 'src/app/App.tsx');
      await expect(page.getByText('rebasing onto')).toBeVisible();
      await expect(page.getByText('commit being replayed')).toBeVisible();
      await capture(page, theme, 'conflict-editor-rebase');
    });
  });
}

test.describe('editor behaviour', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('typing in an unresolved block resolves it; leaving asks first', async ({ page }) => {
    await stopOn(page, 'merge');
    await openFile(page, 'src/app/App.tsx');
    await page.locator('.yaggui-merge-unresolved').click();
    const result = page.getByRole('textbox', { name: 'Result' });
    await result.focus();
    await page.keyboard.type('  const [count, setCount] = useState(42);\n');
    await expect(page.getByText('All blocks resolved')).toBeVisible();
    await page.getByRole('button', { name: /^Graph/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Discard the resolution in progress?');
  });

  test('external tool: runs merge.tool and resolves the file', async ({ page }) => {
    await stopOn(page, 'merge');
    await openFile(page, 'src/app/App.tsx');
    await page.getByRole('button', { name: 'Open in meld' }).click();
    await expect(page.getByText('File resolved with meld', { exact: true })).toBeVisible();
  });
});

test.describe('with the conflicts panel', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('switching to another file with unsaved choices asks first', async ({ page }) => {
    await stopOn(page, 'merge');
    await openFile(page, 'src/app/App.tsx');
    await center(page).getByRole('checkbox').first().check();
    await conflictsPanel(page)
      .getByRole('listitem')
      .filter({ has: page.locator('[title="src/theme/colors.ts"]') })
      .getByRole('button', { name: 'Resolve…' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Discard the resolution in progress?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(center(page).locator('[data-view="conflict:src/app/App.tsx"]')).toBeVisible();
    await expect(center(page).getByRole('checkbox').first()).toBeChecked();
  });
});

for (const { name: theme, colorScheme } of THEMES) {
  test.describe(`${theme} theme, conflicts panel`, () => {
    test.use({ colorScheme, locale: 'en-US' });

    test('a quick resolution of the file open with unsaved choices asks first', async ({
      page,
    }) => {
      await stopOn(page, 'merge');
      await openFile(page, 'src/app/App.tsx');
      await center(page).getByRole('checkbox').first().check();
      const row = conflictsPanel(page)
        .getByRole('listitem')
        .filter({ has: page.locator('[title="src/app/App.tsx"]') });
      await row
        .getByRole('button', { name: /^Take / })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Discard the resolution in progress?');
      await expect(dialog).toContainText('the file is resolved with this choice instead');
      await capture(page, theme, 'quick-resolve-unsaved');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      // Nothing happened: the file is still open, unsaved and in conflict.
      await expect(center(page).locator('[data-view="conflict:src/app/App.tsx"]')).toBeVisible();
      await expect(center(page).getByRole('checkbox').first()).toBeChecked();
      await expect(row).not.toContainText('Resolved');

      // Confirmed, the quick resolution goes through.
      await row
        .getByRole('button', { name: /^Take / })
        .first()
        .click();
      await dialog.getByRole('button', { name: 'Discard' }).click();
      await expect(row).toContainText('Resolved');
    });

    test('every file resolved in the editor lets Continue finish the merge', async ({ page }) => {
      await stopOn(page, 'merge');
      await openFile(page, 'assets/logo.png');
      await page
        .getByRole('button', { name: /^Take .*'s version$/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Keep the changed version' }).click();
      // App.tsx, then colors.ts: one block each, taken from our side.
      for (const path of ['src/app/App.tsx', 'src/theme/colors.ts']) {
        await expect(center(page).locator(`[data-view="conflict:${path}"]`)).toBeVisible();
        await center(page).getByRole('checkbox').first().check();
        await page.keyboard.press('ControlOrMeta+S');
      }
      await expect(page.getByText('All conflicts are resolved')).toBeVisible();
      await expect(conflictsPanel(page)).toContainText('All 4 resolved');
      await capture(page, theme, 'conflicts-all-resolved');
      const next = banner(page).getByRole('button', { name: 'Continue' });
      await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    });
  });
}

test.describe('performance', () => {
  test.use({ colorScheme: 'dark', locale: 'en-US' });

  test('opens and navigates a 5,000-line conflicted file', async ({ page }) => {
    await stopOn(page, 'merge');
    // The mock's operation is a plain object: swap App.tsx for a large file.
    await page.evaluate(() => {
      const mock = window.__yagguiMock as unknown as {
        operations: Map<
          number,
          { conflicts: { path: string; base: string; ours: string; theirs: string }[] }
        >;
      };
      const conflict = mock.operations.get(1)?.conflicts.find((c) => c.path === 'src/app/App.tsx');
      if (!conflict) throw new Error('no App.tsx conflict');
      const base = Array.from(
        { length: 5000 },
        (_, i) => `export const value${String(i)} = ${String(i)};\n`,
      );
      conflict.base = base.join('');
      conflict.ours = base.map((l, i) => (i % 50 === 0 ? `// ours\n${l}` : l)).join('');
      conflict.theirs = base.map((l, i) => (i % 70 === 0 ? `// theirs\n${l}` : l)).join('');
    });
    await page.getByRole('button', { name: 'Show conflicts' }).first().click();
    const opening = Date.now();
    await openFile(page, 'src/app/App.tsx');
    await expect(page.locator('.cm-editor')).toHaveCount(3);
    await expect(page.locator('.yaggui-merge-header').first()).toBeVisible();
    const open = Date.now() - opening;
    test.info().annotations.push({ type: 'open-ms', description: String(open) });
    console.log(`open ${String(open)} ms`);
    // Lines 0, 350, 700… are changed on both sides: 15 conflicts.
    await expect(page.getByText('15 conflicts left')).toBeVisible();
    const start = Date.now();
    await page.keyboard.press('Alt+ArrowDown');
    for (let i = 0; i < 14; i++) await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator('.yaggui-merge-header[data-current="true"]').first()).toContainText(
      'Conflict 1 / 15',
    );
    const navigation = Date.now() - start;
    test
      .info()
      .annotations.push({ type: 'navigation-15-conflicts-ms', description: String(navigation) });
    console.log(`15 navigations ${String(navigation)} ms`);
    expect(open).toBeLessThan(3000);
    expect(navigation).toBeLessThan(3000);
  });
});
