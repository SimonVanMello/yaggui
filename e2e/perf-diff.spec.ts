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

interface DiffCoverage {
  frames: number;
  /** Share of frames where part of a pane showed no rendered line. */
  gapShare: number;
  gapMax: number;
  /** Share of frames where the two columns of a split view were not at the same offset. */
  driftShare: number;
  driftMedian: number;
  driftMax: number;
}

/**
 * What the frame paints right after a scroll step, on layout.ts (4 563 lines): the scroll
 * offset is applied, the scroll listeners (CodeMirror's viewport, the split sync) run at the
 * next frame. Uncovered pane height and the offset between the two columns are what a fast
 * flick shows as blank strips and tearing.
 */
async function diffCoverage(
  page: Page,
  layout: 'Unified' | 'Side by side',
  speed: number,
): Promise<DiffCoverage> {
  await page.goto('about:blank');
  await page.goto('/#diff-demo');
  await expect(page.getByRole('region', { name: /^Diff of / })).toBeVisible();
  await page.getByRole('radio', { name: layout }).click();
  await page
    .getByRole('listbox', { name: /^Commit / })
    .getByRole('option', { name: /layout\.ts/ })
    .click();
  const region = page.getByRole('region', { name: /^Diff of / });
  await expect(region.locator('.cm-line').first()).toBeVisible();
  await region.evaluate((root) => {
    // The split view scrolls both columns in a container around the editors.
    const scroller =
      root.querySelector<HTMLElement>('[data-view="split"]') ??
      root.querySelector<HTMLElement>('.cm-scroller');
    if (scroller) scroller.scrollTop = 500;
  });
  await page.waitForTimeout(1000);
  return region.evaluate(
    (root, args) =>
      new Promise<DiffCoverage>((resolve) => {
        const panes = [...root.querySelectorAll<HTMLElement>('.cm-editor')];
        const scroller = (pane: HTMLElement) => {
          // The element that scrolls vertically: the editor's own scroller or an ancestor.
          for (
            let el: HTMLElement | null = pane.querySelector('.cm-scroller');
            el;
            el = el.parentElement
          )
            if (
              el.scrollHeight > el.clientHeight + 1 &&
              getComputedStyle(el).overflowY !== 'visible'
            )
              return el;
          throw new Error('no scroller');
        };
        const main = scroller(panes[0] as HTMLElement);
        const gap = (pane: HTMLElement) => {
          const view = scroller(pane).getBoundingClientRect();
          const top = Math.max(view.top, pane.getBoundingClientRect().top);
          const bottom = Math.min(view.bottom, pane.getBoundingClientRect().bottom);
          const spans: [number, number][] = [];
          for (const node of pane.querySelectorAll<HTMLElement>('.cm-content > *')) {
            const r = node.getBoundingClientRect();
            const a = Math.max(r.top, top);
            const b = Math.min(r.bottom, bottom);
            if (b > a) spans.push([a, b]);
          }
          spans.sort((x, y) => x[0] - y[0]);
          let covered = 0;
          let reach = top;
          for (const [a, b] of spans) {
            if (b <= reach) continue;
            covered += b - Math.max(a, reach);
            reach = b;
          }
          return Math.max(0, bottom - top - covered);
        };
        const drift = () => {
          if (panes.length < 2) return 0;
          const [a, b] = panes.map(
            (p) => p.querySelector('.cm-content')?.getBoundingClientRect().top ?? 0,
          );
          return Math.abs((a ?? 0) - (b ?? 0));
        };
        const gaps: number[] = [];
        const drifts: number[] = [];
        const range = main.scrollHeight - main.clientHeight;
        const start = performance.now();
        const tick = (now: number) => {
          const elapsed = now - start;
          const half = args.duration / 2;
          const travel = Math.min(range - 1000, args.speed * (half / 1000));
          const t = elapsed < half ? elapsed / half : Math.max(0, 2 - elapsed / half);
          main.scrollTop = 500 + t * travel;
          gaps.push(Math.max(...panes.map(gap)));
          drifts.push(drift());
          if (elapsed < args.duration) requestAnimationFrame(tick);
          else {
            const share = (xs: number[]) => xs.filter((x) => x > 0.5).length / xs.length;
            resolve({
              frames: gaps.length,
              gapShare: share(gaps),
              gapMax: Math.max(...gaps),
              driftShare: share(drifts),
              driftMedian: [...drifts].sort((x, y) => x - y)[Math.floor(drifts.length / 2)] ?? 0,
              driftMax: Math.max(...drifts),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    { duration: 4000, speed },
  );
}

test('P-06: diff lines cover the panes while scrolling fast', async ({ page }) => {
  test.setTimeout(180_000);
  const lines: string[] = [];
  for (const layout of ['Side by side', 'Unified'] as const) {
    for (const speed of [6_000, 12_000]) {
      const c = await diffCoverage(page, layout, speed);
      lines.push(
        `${layout.padEnd(12)} ${String(speed)} px/s: ${String(c.frames)} frames, ` +
          `blank in ${(c.gapShare * 100).toFixed(1)} % (max ${c.gapMax.toFixed(0)} px), ` +
          `columns apart in ${(c.driftShare * 100).toFixed(1)} % (median ${c.driftMedian.toFixed(0)} px, max ${c.driftMax.toFixed(0)} px)`,
      );
    }
  }
  const text = `P-06 diff scroll coverage, layout.ts (4 563 lines), on the painted frame\n${lines.join('\n')}\n`;
  console.log(text);
  writeFileSync(test.info().outputPath('p06-coverage.txt'), text);
});
