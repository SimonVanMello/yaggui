import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * P-08 (spec §3): palette search over 10k refs, target < 30 ms per keystroke.
 * Mock repository `many-refs` (5 000 local branches, remote branches and 3 000 tags).
 * For each keystroke, an in-page script sets the input value, dispatches `input` (React
 * flushes it synchronously: that duration is the filter + render cost) and measures again at
 * the next animation frame (adds style, layout and paint). The opening is measured from the
 * shortcut to the first frame showing results.
 */

const QUERIES = [
  'f',
  'fe',
  'fea',
  'feat',
  'feat/',
  'feat/gr',
  'depend',
  'dependabot/react',
  'zzz',
  '',
];
const ROUNDS = 5;

interface Series {
  syncMs: number[];
  frameMs: number[];
}

async function openPalette(page: Page, throttle: number) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.goto('about:blank');
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.evaluate(() => window.__yagguiMock?.setPickedFolder('/Users/alex/dev/many-refs'));
  await page.getByRole('button', { name: /^Open/ }).first().click();
  await expect(page.getByRole('tree').getByRole('treeitem').first()).toBeVisible();
  await page.waitForTimeout(500);
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  return client;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

const fmt = (s: ReturnType<typeof stats>) =>
  `median ${s.median.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms`;

async function measure(page: Page, throttle: number) {
  const client = await openPalette(page, throttle);
  const opening: number[] = [];
  const series: Series = { syncMs: [], frameMs: [] };
  let total = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const ms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const start = performance.now();
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }),
          );
          const poll = () => {
            if (document.querySelectorAll('[role="option"]').length > 0) {
              resolve(performance.now() - start);
            } else requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        }),
    );
    opening.push(ms);
    if (round === 0) {
      total = Number(
        (await page.locator('[aria-live="polite"]').last().textContent())?.match(/\d+/)?.[0] ?? 0,
      );
    }
    const timings = await page.evaluate(async (queries) => {
      const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
      if (!input) throw new Error('palette is not open');
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      const out: { sync: number; frame: number }[] = [];
      for (const query of queries) {
        const start = performance.now();
        descriptor?.set?.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const sync = performance.now() - start;
        await new Promise<void>((done) => {
          requestAnimationFrame(() => {
            done();
          });
        });
        out.push({ sync, frame: performance.now() - start });
      }
      return out;
    }, QUERIES);
    // The first round warms the JIT up: it is measured for the opening only.
    if (round > 0) {
      series.syncMs.push(...timings.map((t) => t.sync));
      series.frameMs.push(...timings.map((t) => t.frame));
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox')).toBeHidden();
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return { opening, series, total };
}

test('P-08: palette opening and filtering on 10k refs', async ({ page }) => {
  test.setTimeout(180_000);
  const lines: string[] = [];
  let sync1 = Infinity;
  for (const throttle of [1, 4]) {
    const { opening, series, total } = await measure(page, throttle);
    const sync = stats(series.syncMs);
    if (throttle === 1) sync1 = sync.p95;
    lines.push(
      `CPU ×${String(throttle)} (${String(total)} items in the empty list): opening ${fmt(stats(opening))}`,
      `  keystroke, filter + render: ${fmt(sync)}`,
      `  keystroke, until next frame: ${fmt(stats(series.frameMs))}`,
    );
  }
  const text = `P-08 palette on the many-refs mock (target: < 30 ms per keystroke)\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p08.txt'), text);
  expect(sync1).toBeLessThan(30);
});
