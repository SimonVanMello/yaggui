import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * P-04 (spec §3): graph scroll at 60 fps on the 100k-commit mock repository (linux).
 * An in-page rAF loop scrolls the graph at a constant speed for DURATION_MS, down then up,
 * and records every frame interval; with normal CPU and with a 4× CPU throttle (CDP).
 * Reports the median fps, the 95th percentile frame time and the share of frames over 20 ms.
 */

const DURATION_MS = 6_000;
const SPEED_PX_PER_S = 6_000; // ≈ 215 rows/s, a fast flick
const FRAME_BUDGET_MS = 1000 / 60;

interface Stats {
  frames: number;
  fps: number;
  medianMs: number;
  p95Ms: number;
  slowShare: number;
  maxMs: number;
}

async function measure(page: Page, throttle: number): Promise<Stats> {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto('about:blank');
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.getByRole('option', { name: /^linux\b/ }).click();
  const graph = page.getByRole('listbox', { name: 'Commit graph' });
  await expect(graph.getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(1000);

  await client.send('Performance.enable');
  const before = await client.send('Performance.getMetrics');
  const intervals = await graph.evaluate(
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
              ? 1000 + (elapsed / 1000) * args.speed
              : 1000 + travel - ((elapsed - half) / 1000) * args.speed;
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
  const medianMs = at(0.5);
  return {
    frames: intervals.length,
    fps: 1000 / medianMs,
    medianMs,
    p95Ms: at(0.95),
    slowShare: intervals.filter((d) => d > 20).length / intervals.length,
    maxMs: sorted.at(-1) ?? 0,
  };
}

test('P-04: graph scroll frame rate on 100k commits', async ({ page }) => {
  test.setTimeout(120_000);
  const lines: string[] = [];
  const results: Record<string, Stats> = {};
  for (const throttle of [1, 4]) {
    const s = await measure(page, throttle);
    results[String(throttle)] = s;
    lines.push(
      `CPU ×${String(throttle)}: ${String(s.frames)} frames, median ${s.medianMs.toFixed(1)} ms (${s.fps.toFixed(0)} fps), ` +
        `p95 ${s.p95Ms.toFixed(1)} ms, >20 ms: ${(s.slowShare * 100).toFixed(1)} %, max ${s.maxMs.toFixed(1)} ms`,
    );
  }
  const text = `P-04 graph scroll, linux mock (100k commits), ${String(SPEED_PX_PER_S)} px/s for ${String(DURATION_MS / 1000)} s (target: 60 fps)\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p04.txt'), text);
  expect(results['1']?.medianMs ?? Infinity).toBeLessThanOrEqual(FRAME_BUDGET_MS * 1.1);
  expect(results['1']?.slowShare ?? 1).toBeLessThan(0.05);
});
