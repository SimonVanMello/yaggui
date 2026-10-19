// Extracts the docs of every released version listed in versions.json from git, into
// `.cache/versions/<version>/` (gitignored). Called by astro.config.ts, so `astro dev`, `astro build`
// and `astro check` always see the versions of versions.json. Each extraction is keyed by its ref:
// a version is re-extracted only when its ref changes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { VERSIONS_CACHE, type DocsVersion } from '../src/lib/docs-versions.ts';

/** Paths extracted from each ref: the docs and the images they import relatively. */
const EXTRACTED = ['website/src/content/docs', 'website/src/assets'];

function git(repo: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasPath(repo: string, commit: string, file: string): boolean {
  try {
    git(repo, ['cat-file', '-e', `${commit}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

export function extractVersions(websiteRoot: string, all: DocsVersion[]): void {
  const repo = path.resolve(websiteRoot, '..');
  const cache = path.join(websiteRoot, VERSIONS_CACHE);
  const released = all.filter((v): v is DocsVersion & { ref: string } => v.ref !== undefined);
  const wanted = new Set(released.map((v) => v.id));

  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      if (!wanted.has(dir)) rmSync(path.join(cache, dir), { recursive: true, force: true });
    }
  }

  for (const v of released) {
    const dir = path.join(cache, v.id);
    const stamp = path.join(dir, '.ref');
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === v.ref) continue;

    let commit: string;
    try {
      commit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${v.ref}^{commit}`])
        .toString()
        .trim();
    } catch {
      throw new Error(
        `versions.json: ref ${v.ref} of ${v.id} is not in this clone. ` +
          'Fetch the full history (`git fetch --unshallow --tags`, or `fetch-depth: 0` in CI).',
      );
    }
    const paths = EXTRACTED.filter((p) => hasPath(repo, commit, p));
    if (!paths.includes(EXTRACTED[0] ?? '')) {
      throw new Error(`versions.json: ${v.id} (${v.ref}) has no ${EXTRACTED[0]}`);
    }

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const archive = git(repo, ['archive', '--format=tar', commit, '--', ...paths]);
    const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive });
    if (tar.status !== 0) throw new Error(`tar failed for ${v.id}: ${tar.stderr.toString()}`);
    writeFileSync(stamp, v.ref);
  }
}
