#!/usr/bin/env node
// P-01 (spec §3): cold start until the window is interactive, target < 800 ms.
//
// Usage (release build first: `pnpm tauri build --no-bundle`):
//   node scripts/measure-startup.mjs [--runs 10] [--binary path] [--drop-caches]
//   Linux without a display: xvfb-run -a node scripts/measure-startup.mjs
//
// Each run starts the release binary with YAGGUI_PERF_PROBE=1: the app prints a line when its
// main window becomes visible (the frontend shows it once the restored tabs are rendered, see
// src/app/Shell.tsx) and quits. Measured from just before spawning the process, so executable
// loading, webview creation, JS boot, preferences and tab restoration are all included.
//
// Scenarios: `welcome` (empty config, first launch) and `restore` (one repository tab restored).
// `--drop-caches` (Linux, root) empties the page cache before each run for a true cold start;
// otherwise the first run is the coldest and the others are warm.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_MS = 800;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runs = Number(option('runs', '10'));
const dropCaches = process.argv.includes('--drop-caches');
const binary = resolve(
  option(
    'binary',
    join(ROOT, 'src-tauri/target/release', process.platform === 'win32' ? 'yaggui.exe' : 'yaggui'),
  ),
);

if (!existsSync(binary)) {
  console.error(`No release binary at ${binary}. Run \`pnpm tauri build --no-bundle\` first.`);
  process.exit(1);
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Small repository with one commit, so the restored tab shows a real state. */
function makeFixtureRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', 'README.md');
  git(
    dir,
    '-c',
    'user.name=yaggui',
    '-c',
    'user.email=yaggui@example.com',
    'commit',
    '-q',
    '-m',
    'init',
  );
  writeFileSync(join(dir, 'dirty.txt'), 'local change\n');
}

function tryDropCaches() {
  try {
    execFileSync('sync');
    writeFileSync('/proc/sys/vm/drop_caches', '3');
    return true;
  } catch {
    return false;
  }
}

/** Starts the app once; resolves with the time until its window became visible. */
function launch(configDir, args = []) {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(binary, args, {
      env: {
        ...process.env,
        YAGGUI_PERF_PROBE: '1',
        YAGGUI_CONFIG_DIR: configDir,
        RUST_LOG: 'warn',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let visibleAfter = null;
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (visibleAfter === null && output.includes('yaggui-perf window-visible')) {
        visibleAfter = performance.now() - started;
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the app did not show its window within 30 s'));
    }, 30_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const inProcess = /since_run_ms=(\d+)/.exec(output)?.[1];
      if (visibleAfter === null)
        reject(new Error(`the app exited (${code}) before showing its window`));
      else resolvePromise({ totalMs: visibleAfter, inProcessMs: Number(inProcess) });
    });
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const round = (n) => Math.round(n);
  return {
    first: round(values[0]),
    min: round(sorted[0]),
    median: round(median),
    max: round(sorted.at(-1)),
  };
}

const work = mkdtempSync(join(tmpdir(), 'yaggui-p01-'));
const results = {};
try {
  const repo = join(work, 'fixture-repo');
  makeFixtureRepo(repo);

  // Restore scenario: a first launch with `yaggui <path>` saves one repository tab.
  const restoreConfig = join(work, 'config-restore');
  await launch(restoreConfig, [repo]);

  for (const scenario of ['welcome', 'restore']) {
    const totals = [];
    const inProcess = [];
    let dropped = false;
    for (let i = 0; i < runs; i++) {
      if (dropCaches) dropped = tryDropCaches();
      const configDir =
        scenario === 'welcome' ? mkdtempSync(join(work, 'config-welcome-')) : restoreConfig;
      const result = await launch(configDir);
      totals.push(result.totalMs);
      inProcess.push(result.inProcessMs);
    }
    results[scenario] = {
      spawnToVisibleMs: stats(totals),
      inProcessMs: stats(inProcess),
      cachesDropped: dropped,
    };
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const report = { target: TARGET_MS, runs, binary, platform: process.platform, results };
console.log(JSON.stringify(report, null, 2));
const out = join(ROOT, 'test-results/perf');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'p01.json'), JSON.stringify(report, null, 2));
const worst = Math.max(...Object.values(results).map((r) => r.spawnToVisibleMs.median));
console.log(
  `P-01 median ${worst} ms (target < ${TARGET_MS} ms): ${worst < TARGET_MS ? 'OK' : 'MISSED'}`,
);
