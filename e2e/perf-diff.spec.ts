import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * P-06 (spec §3): file diff (< 5 000 lines) shown in < 100 ms. Measured from the selection
 * (`openDiff` sets the `yaggui:diff-select` mark) to the first frame painted with the diff
 * (`yaggui:diff-render` measure, CodeDiff), cold: page reloaded before each run, so the
 * query cache is empty and the (mock) backend computes the diff. Syntax highlighting loads
 * its language lazily after that frame and is not part of the measure.
 */

const RUNS = 10;
const TARGET_MS = 100;
const FILES = [
  { name: 'lanes.generated.ts', lines: 'new file, 4 803 lines rendered' },
  { name: 'layout.ts', lines: '4 563-line file, 9 hunks' },
];

async function measureOnce(page: Page, file: string, layout: 'Unified' | 'Side by side') {
  // Same URL with a hash: a real reload is needed to start cold.
  await page.goto('about:blank');
  await page.goto('/#diff-demo');
  await expect(page.getByRole('region', { name: /^Diff of / })).toBeVisible();
  await page.getByRole('radio', { name: layout }).click();
  await page.evaluate(() => {
    performance.clearMeasures('yaggui:diff-render');
  });
  await page
    .getByRole('listbox', { name: /^Commit / })
    .getByRole('option', { name: new RegExp(file) })
    .click();
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const poll = () => {
          const entry = performance.getEntriesByName('yaggui:diff-render', 'measure')[0];
          if (entry) resolve(entry.duration);
          else setTimeout(poll, 5);
        };
        poll();
      }),
  );
}

test('P-06: file diff render time', async ({ page }) => {
  test.setTimeout(180_000);
  const report: string[] = [];
  let worst = 0;
  for (const layout of ['Side by side', 'Unified'] as const) {
    for (const file of FILES) {
      const durations: number[] = [];
      for (let i = 0; i < RUNS; i++) durations.push(await measureOnce(page, file.name, layout));
      const sorted = [...durations].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const max = sorted.at(-1) ?? 0;
      worst = Math.max(worst, median);
      report.push(
        `${layout.padEnd(12)} ${file.name} (${file.lines}): median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
      );
    }
  }
  const text = `P-06 diff render, ${String(RUNS)} cold runs each (target < ${String(TARGET_MS)} ms)\n${report.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p06.txt'), text);
  expect(worst).toBeLessThan(TARGET_MS);
});
