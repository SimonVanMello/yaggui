import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

/**
 * P-05, front share: `status-changed` received → refetch of the repo state and of both file
 * lists → changes panel rendered with the new list. The mock answers instantly: what is
 * measured is the frontend (event handling, invalidation, React render). The backend share
 * (disk change → event → status read) is `cargo test --release --test status p05`.
 */

const RUNS = 15;

test('P-05: changes panel refresh after status-changed', async ({ page }) => {
  await page.goto('/');
  // A repository whose mock working tree follows its dirty counts (not the `yaggui` showcase).
  const name = await page.evaluate(async () => {
    const repos = await window.__yagguiMock?.commands.listRepos();
    const found =
      repos?.status === 'ok' ? repos.data.find((r) => r.exists && r.name !== 'yaggui') : null;
    if (!found) throw new Error('no generic mock repository');
    return found.name;
  });
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  const unstaged = page.getByRole('listbox', { name: 'Unstaged', exact: true });
  await expect(unstaged.getByRole('option').first()).toBeVisible();

  const durations: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const duration = await page.evaluate(
      async ({ run, name }) => {
        const mock = window.__yagguiMock;
        if (!mock) throw new Error('mock backend missing');
        const repos = await mock.commands.listRepos();
        if (repos.status !== 'ok') throw new Error('listRepos failed');
        const repo = repos.data.find((r) => r.name === name);
        if (!repo) throw new Error(`no ${name} repo`);
        const state = await mock.commands.repoState(repo.id);
        if (state.status !== 'ok') throw new Error('repoState failed');
        const list = document.querySelector('[role="listbox"][aria-label="Unstaged"]');
        if (!list) throw new Error('no unstaged list');
        const before = list.querySelectorAll('[role="option"]').length;
        return new Promise<number>((resolve) => {
          const observer = new MutationObserver(() => {
            if (list.querySelectorAll('[role="option"]').length === before) return;
            observer.disconnect();
            // The DOM is updated; the next frame is the one painted with it.
            requestAnimationFrame(() => {
              resolve(performance.now() - started);
            });
          });
          observer.observe(list, { childList: true, subtree: true });
          const started = performance.now();
          // One more (or one less) modified file: another working tree.
          const unstagedCount = state.data.dirty.unstaged + (run % 2 === 0 ? 1 : -1);
          mock.setRepoState(repo.id, { dirty: { ...state.data.dirty, unstaged: unstagedCount } });
        });
      },
      { run, name },
    );
    durations.push(duration);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const max = sorted.at(-1) ?? 0;
  const text = `P-05 front share (status-changed → changes panel painted), ${String(RUNS)} runs: median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p05-front.txt'), text);
  expect(median).toBeLessThan(50);
});
