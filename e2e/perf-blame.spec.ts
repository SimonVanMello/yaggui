import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * M4-4: blame of a 20 000-line file (mock `fixtures/huge-snapshot.json`). Measures the time
 * from the menu click to the first painted lines (mock blame computed in the page included),
 * then scrolls the lines at a constant speed for DURATION_MS, down then up, recording every
 * frame interval; with normal CPU and with a 4× CPU throttle (CDP).
 */

const DURATION_MS = 6_000;
const SPEED_PX_PER_S = 6_000;
const FRAME_BUDGET_MS = 1000 / 60;

interface Stats {
  openMs: number;
  frames: number;
  medianMs: number;
  p95Ms: number;
  slowShare: number;
  maxMs: number;
}

async function measure(page: Page, throttle: number): Promise<Stats> {
  const client = await page.context().newCDPSession(page);
  await page.goto('about:blank');
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.getByRole('option', { name: /^yaggui\b/ }).click();
  await page.locator('[data-row="2"]').click();
  const details = page.getByRole('region', { name: 'Commit details' });
  await details.getByRole('option', { name: /huge-snapshot\.json/ }).click({ button: 'right' });
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });

  // Time from the click to the frame that shows the first blamed line.
  await page.evaluate(() => {
    const w = window as unknown as { blameShown?: Promise<number> };
    w.blameShown = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('[role="grid"] [role="row"]')) {
          observer.disconnect();
          requestAnimationFrame(() => {
            resolve(performance.now());
          });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });
  const item = page.getByRole('menuitem', { name: /^Blame at this commit$/ });
  const clicked = await item.evaluate((el) => {
    const at = performance.now();
    (el as HTMLElement).click();
    return at;
  });
  const shown = await page.evaluate(
    () => (window as unknown as { blameShown: Promise<number> }).blameShown,
  );
  const grid = page.getByRole('grid', { name: /^Lines of fixtures\/huge-snapshot\.json/ });
  await expect(grid).toHaveAttribute('aria-rowcount', '20000');
  await page.waitForTimeout(500);

  await client.send('Performance.enable');
  const before = await client.send('Performance.getMetrics');
  const intervals = await grid.evaluate(
    (el, args) =>
      new Promise<number[]>((resolve) => {
        const frames: number[] = [];
        const start = performance.now();
        let last = start;
        const tick = (now: number) => {
          frames.push(now - last);
          last = now;
          const elapsed = now - start;
          const half = args.duration / 2;
          const travel = args.speed * (half / 1000);
          el.scrollTop =
            elapsed < half
              ? (elapsed / 1000) * args.speed
              : travel - ((elapsed - half) / 1000) * args.speed;
          if (elapsed < args.duration) requestAnimationFrame(tick);
          else resolve(frames.slice(1));
        };
        requestAnimationFrame(tick);
      }),
    { duration: DURATION_MS, speed: SPEED_PX_PER_S },
  );
  const after = await client.send('Performance.getMetrics');
  const metric = (r: typeof before, name: string) =>
    r.metrics.find((m) => m.name === name)?.value ?? 0;
  const breakdown = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration']
    .map(
      (n) =>
        `${n.replace('Duration', '')} ${((metric(after, n) - metric(before, n)) * 1000).toFixed(0)} ms`,
    )
    .join(', ');
  console.log(`CPU ×${String(throttle)} main thread over ${String(DURATION_MS)} ms: ${breakdown}`);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return {
    openMs: shown - clicked,
    frames: intervals.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    slowShare: intervals.filter((d) => d > 20).length / intervals.length,
    maxMs: sorted.at(-1) ?? 0,
  };
}

test('blame of a 20 000-line file: opening and scroll frame rate', async ({ page }) => {
  test.setTimeout(120_000);
  const lines: string[] = [];
  const results: Record<string, Stats> = {};
  for (const throttle of [1, 4]) {
    const s = await measure(page, throttle);
    results[String(throttle)] = s;
    lines.push(
      `CPU ×${String(throttle)}: shown in ${s.openMs.toFixed(0)} ms; scroll ${String(s.frames)} frames, ` +
        `median ${s.medianMs.toFixed(1)} ms (${(1000 / s.medianMs).toFixed(0)} fps), p95 ${s.p95Ms.toFixed(1)} ms, ` +
        `>20 ms: ${(s.slowShare * 100).toFixed(1)} %, max ${s.maxMs.toFixed(1)} ms`,
    );
  }
  const text = `Blame, 20 000 lines (mock), ${String(SPEED_PX_PER_S)} px/s for ${String(DURATION_MS / 1000)} s\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('blame.txt'), text);
  expect(results['1']?.medianMs ?? Infinity).toBeLessThanOrEqual(FRAME_BUDGET_MS * 1.1);
  expect(results['1']?.slowShare ?? 1).toBeLessThan(0.05);
});
