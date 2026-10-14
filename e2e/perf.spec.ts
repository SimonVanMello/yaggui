import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * P-07 (spec §3): tab switch < 50 ms, state kept in memory. Measured from the keydown to the
 * next painted frame, on the mock backend: switching tabs calls no backend command (the repo
 * state is cached, `staleTime: Infinity`), so this is the whole cost the user sees.
 */

const SWITCHES = 60;
const TARGET_MS = 50;

async function openThreeRepos(page: Page) {
  for (const [index, name] of ['yaggui', 'linux', 'blog'].entries()) {
    if (index > 0) await page.keyboard.press('Control+T');
    await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
    await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
      new RegExp(`^${name}`),
    );
  }
}

/** Switches tabs `count` times with ⌃1/⌃2/⌃3 and returns each duration in ms. */
function measureSwitches(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (count) => {
    const nextFrame = () =>
      new Promise<void>((resolve) => {
        // rAF runs before the paint; the message after it runs once the frame is painted.
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            resolve();
          };
          channel.port2.postMessage(null);
        });
      });
    const durations: number[] = [];
    for (let i = 0; i < count; i++) {
      const digit = String((i % 3) + 1);
      await nextFrame();
      const start = performance.now();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: digit, code: `Digit${digit}`, ctrlKey: true }),
      );
      await nextFrame();
      durations.push(performance.now() - start);
      const selected = document.querySelector('[role="tab"][aria-selected="true"]');
      const panel = document.getElementById('tab-panel');
      if (!selected || panel?.getAttribute('aria-labelledby') !== selected.id) {
        throw new Error(`tab ${digit} not shown after the switch`);
      }
    }
    return durations;
  }, count);
}

function stats(durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { median: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)), runs: sorted.length };
}

test.use({ colorScheme: 'dark', locale: 'en-US' });

test('P-07 tab switch stays under 50 ms', async ({ page }) => {
  await page.goto('/');
  await openThreeRepos(page);
  // Warm-up: first mounts of each view.
  await measureSwitches(page, 6);

  const normal = stats(await measureSwitches(page, SWITCHES));

  // Pessimistic run: CPU slowed down 4× (closer to a modest laptop under load).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const throttled = stats(await measureSwitches(page, SWITCHES));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const result = { target: TARGET_MS, normal, throttled4x: throttled };
  console.log(`P-07 tab switch (ms): ${JSON.stringify(result)}`);
  writeFileSync(test.info().outputPath('p07.json'), JSON.stringify(result, null, 2));
  expect(normal.median).toBeLessThan(TARGET_MS);
  expect(normal.p95).toBeLessThan(TARGET_MS);
});

/** Opens a repository the mock generates from its path (no fixture), in a new tab. */
async function openPath(page: Page, path: string) {
  await page.keyboard.press('Control+T');
  await page.getByRole('button', { name: 'Enter a path…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open a repository' });
  await dialog.getByRole('textbox').fill(path);
  await dialog.getByRole('button', { name: /^Open/ }).last().click();
  await expect(dialog).toBeHidden();
}

/**
 * M5-3: JS heap and DOM size with 5 repository tabs, each shown once, after a forced garbage
 * collection. Reported, not asserted: kept views trade memory for P-07.
 */
test('memory with 5 tabs open', async ({ page }) => {
  await page.goto('/');
  await openThreeRepos(page);
  await openPath(page, '/Users/alex/dev/service-a');
  await openPath(page, '/Users/alex/dev/service-b');
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(5);
  for (const digit of ['1', '2', '3', '4', '5', '1']) {
    await page.keyboard.press(`Control+${digit}`);
    await expect(page.getByRole('listbox', { name: 'Commit graph' })).toBeVisible();
  }
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  const result = {
    jsHeapUsedMB: Math.round((metric('JSHeapUsedSize') / 1024 / 1024) * 10) / 10,
    jsHeapTotalMB: Math.round((metric('JSHeapTotalSize') / 1024 / 1024) * 10) / 10,
    domNodes: metric('Nodes'),
    jsEventListeners: metric('JSEventListeners'),
    mountedViews: await page.locator('[data-tab-view]').count(),
  };
  console.log(`M5-3 memory, 5 tabs: ${JSON.stringify(result)}`);
  writeFileSync(test.info().outputPath('memory.json'), JSON.stringify(result, null, 2));
});
