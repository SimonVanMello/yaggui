import { writeFileSync } from 'node:fs';

import { expect, test, type Browser } from '@playwright/test';

/**
 * P-04 (spec §3): graph scroll at 60 fps on the 100k-commit mock repository (linux).
 * An in-page rAF loop scrolls the graph at a constant speed for DURATION_MS, down then up,
 * and records every frame interval; with normal CPU and with a 4× CPU throttle (CDP).
 * Reports the median fps, the 95th percentile frame time and the share of frames over 20 ms.
 * `YAGGUI_PERF_FIRST_PARENT=1` measures the first-parent graph (F-032, M7-5) instead.
 */

const FIRST_PARENT = process.env.YAGGUI_PERF_FIRST_PARENT === '1';

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

/**
 * The linux repository in a fresh browser context with a CPU throttle. A fresh context each
 * time: the open tabs can outlive a cleared localStorage across reloads, and the next run
 * would then miss the welcome screen.
 */
async function openGraph(browser: Browser, throttle: number) {
  const { baseURL, viewport } = test.info().project.use;
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto('/');
  await page.getByRole('option', { name: /^linux\b/ }).click();
  const graph = page.getByRole('listbox', { name: 'Commit graph' });
  await expect(graph.getByRole('option').first()).toBeVisible();
  if (FIRST_PARENT) {
    await page.getByRole('toolbar').getByRole('button', { name: 'First parent' }).click();
    await expect(page.getByRole('status', { name: 'Graph filter' })).toContainText(
      'First-parent history',
    );
    await expect(graph.getByRole('option').first()).toBeVisible();
  }
  return { context, client, graph };
}

async function measure(browser: Browser, throttle: number): Promise<Stats> {
  const { context, client, graph } = await openGraph(browser, throttle);
  await graph.page().waitForTimeout(1000);

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
  await context.close();

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

test('P-04: graph scroll frame rate on 100k commits', async ({ browser }) => {
  test.setTimeout(120_000);
  const lines: string[] = [];
  const results: Record<string, Stats> = {};
  for (const throttle of [1, 4]) {
    const s = await measure(browser, throttle);
    results[String(throttle)] = s;
    lines.push(
      `CPU ×${String(throttle)}: ${String(s.frames)} frames, median ${s.medianMs.toFixed(1)} ms (${s.fps.toFixed(0)} fps), ` +
        `p95 ${s.p95Ms.toFixed(1)} ms, >20 ms: ${(s.slowShare * 100).toFixed(1)} %, max ${s.maxMs.toFixed(1)} ms`,
    );
  }
  const text = `P-04 graph scroll, linux mock (100k commits${FIRST_PARENT ? ', first-parent' : ''}), ${String(SPEED_PX_PER_S)} px/s for ${String(DURATION_MS / 1000)} s (target: 60 fps)\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p04.txt'), text);
  expect(results['1']?.medianMs ?? Infinity).toBeLessThanOrEqual(FRAME_BUDGET_MS * 1.1);
  expect(results['1']?.slowShare ?? 1).toBeLessThan(0.05);
});

interface Coverage {
  frames: number;
  /** Share of frames where part of the viewport had no row (DOM) or no lanes (canvas). */
  rowGapShare: number;
  laneGapShare: number;
  /** Largest uncovered height in one frame, in px. */
  rowGapMax: number;
  laneGapMax: number;
}

/**
 * What the frame paints right after a scroll step: the scroll offset is already applied, but
 * the scroll listeners (virtualizer, canvas tiles) only run at the next frame. Rows and tiles
 * that do not cover the viewport at that point are the blank strips seen on a fast flick.
 */
async function coverage(browser: Browser, throttle: number, speed: number): Promise<Coverage> {
  const { context, graph } = await openGraph(browser, throttle);
  const page = graph.page();
  // Pages around the path are loaded first: this measures rendering, not IPC latency.
  await graph.evaluate(
    (el, travel) => {
      el.scrollTop = 1000 + travel;
    },
    speed * (DURATION_MS / 2000),
  );
  await page.waitForTimeout(1500);
  await graph.evaluate((el) => {
    el.scrollTop = 1000;
  });
  await page.waitForTimeout(1500);

  const result = await graph.evaluate(
    (el, args) =>
      new Promise<Coverage>((resolve) => {
        const gap = (selector: string, skip: (node: HTMLElement) => boolean) => {
          const view = el.getBoundingClientRect();
          const spans: [number, number][] = [];
          for (const node of el.querySelectorAll<HTMLElement>(selector)) {
            if (skip(node)) continue;
            const r = node.getBoundingClientRect();
            const top = Math.max(r.top, view.top);
            const bottom = Math.min(r.bottom, view.top + el.clientHeight);
            if (bottom > top) spans.push([top, bottom]);
          }
          spans.sort((a, b) => a[0] - b[0]);
          let covered = 0;
          let reach = view.top;
          for (const [top, bottom] of spans) {
            if (bottom <= reach) continue;
            covered += bottom - Math.max(top, reach);
            reach = bottom;
          }
          return Math.max(0, el.clientHeight - covered);
        };
        const rowGaps: number[] = [];
        const laneGaps: number[] = [];
        const start = performance.now();
        const tick = (now: number) => {
          const elapsed = now - start;
          const half = args.duration / 2;
          const travel = args.speed * (half / 1000);
          el.scrollTop =
            elapsed < half
              ? 1000 + (elapsed / 1000) * args.speed
              : 1000 + travel - ((elapsed - half) / 1000) * args.speed;
          rowGaps.push(gap('[data-row]', (n) => n.dataset.row === 'wip'));
          laneGaps.push(gap('canvas', (n) => n.style.visibility === 'hidden'));
          if (elapsed < args.duration) requestAnimationFrame(tick);
          else {
            const share = (gaps: number[]) => gaps.filter((g) => g > 0.5).length / gaps.length;
            resolve({
              frames: rowGaps.length,
              rowGapShare: share(rowGaps),
              laneGapShare: share(laneGaps),
              rowGapMax: Math.max(...rowGaps),
              laneGapMax: Math.max(...laneGaps),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    { duration: DURATION_MS, speed },
  );
  await context.close();
  return result;
}

test('P-04: graph rows and lanes cover the viewport while scrolling fast', async ({ browser }) => {
  test.setTimeout(180_000);
  const lines: string[] = [];
  for (const speed of [SPEED_PX_PER_S, SPEED_PX_PER_S * 2]) {
    for (const throttle of [1, 4]) {
      const c = await coverage(browser, throttle, speed);
      lines.push(
        `${String(speed)} px/s, CPU ×${String(throttle)}: ${String(c.frames)} frames, ` +
          `rows missing in ${(c.rowGapShare * 100).toFixed(1)} % (max ${c.rowGapMax.toFixed(0)} px), ` +
          `lanes missing in ${(c.laneGapShare * 100).toFixed(1)} % (max ${c.laneGapMax.toFixed(0)} px)`,
      );
    }
  }
  const text = `P-04 graph coverage, linux mock (100k commits), viewport gaps on the painted frame\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p04-coverage.txt'), text);
});
