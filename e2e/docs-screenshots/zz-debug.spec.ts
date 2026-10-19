import { test } from '@playwright/test';
import { openRepo, start } from './capture';
test('dbg', async ({ page }) => {
  await start(page);
  await openRepo(page);
  const tree = page.getByRole('tree');
  const s = tree.getByRole('treeitem', { name: /^Stashes/ });
  if ((await s.getAttribute('aria-expanded')) !== 'true') await s.click();
  await tree.getByRole('treeitem', { name: 'lanes', exact: true }).click();
  const d = page.getByRole('region', { name: 'Stash details' });
  await d.waitFor();
  await page.waitForTimeout(500);
  console.log(await d.getByRole('option').allTextContents());
});
