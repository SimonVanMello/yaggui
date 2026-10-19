// The app version lives in package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
// src-tauri/Cargo.lock. `check` fails when they disagree (or differ from a `vX.Y.Z` tag), or when
// CHANGELOG.md has no section for it; `set` rewrites all four and turns the `Unreleased` section
// of CHANGELOG.md into the new version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = {
  package: `${root}package.json`,
  tauri: `${root}src-tauri/tauri.conf.json`,
  cargo: `${root}src-tauri/Cargo.toml`,
  lock: `${root}src-tauri/Cargo.lock`,
};
const changelog = `${root}CHANGELOG.md`;
// No pre-release suffix: the Windows MSI bundler only accepts numeric versions.
const SEMVER = /^\d+\.\d+\.\d+$/;
// First `version` of the [package] table, and the `yaggui` entry of the lockfile.
const CARGO_VERSION = /^(\[package\][^[]*?^version = ")([^"]+)(")/ms;
const LOCK_VERSION = /^(name = "yaggui"\nversion = ")([^"]+)(")/m;

function read(path) {
  return readFileSync(path, 'utf8');
}

function versions() {
  return {
    'package.json': JSON.parse(read(files.package)).version,
    'src-tauri/tauri.conf.json': JSON.parse(read(files.tauri)).version,
    'src-tauri/Cargo.toml': read(files.cargo).match(CARGO_VERSION)?.[2],
    'src-tauri/Cargo.lock': read(files.lock).match(LOCK_VERSION)?.[2],
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function check(tag) {
  const found = versions();
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    fail(
      `Versions disagree:\n${Object.entries(found)
        .map(([file, version]) => `  ${file}: ${version ?? 'not found'}`)
        .join('\n')}\nRun \`pnpm release:version <x.y.z>\`.`,
    );
  }
  const [version] = distinct;
  if (tag && tag !== `v${version}`) {
    fail(`Tag ${tag} does not match version ${version}: expected v${version}.`);
  }
  if (!read(changelog).includes(`\n## [${version}] - `)) {
    fail(`CHANGELOG.md has no section for ${version}: run \`pnpm release:version ${version}\`.`);
  }
  console.log(`version=${version}`);
}

function replaceJsonVersion(path, version) {
  const text = read(path);
  const next = text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
  writeFileSync(path, next);
}

function replaceVersion(path, pattern, version) {
  const text = read(path);
  if (!pattern.test(text)) fail(`No version found in ${path}`);
  writeFileSync(path, text.replace(pattern, `$1${version}$3`));
}

const UNRELEASED = '## [Unreleased]\n';

/** Moves the `Unreleased` entries under `## [version] - <today>`, leaving `Unreleased` empty. */
function releaseChangelog(version) {
  const text = read(changelog);
  if (text.includes(`\n## [${version}] - `)) return;
  const start = text.indexOf(UNRELEASED);
  if (start === -1) fail('CHANGELOG.md has no `## [Unreleased]` section.');
  const bodyStart = start + UNRELEASED.length;
  const next = text.indexOf('\n## ', bodyStart);
  const body = text.slice(bodyStart, next === -1 ? text.length : next + 1);
  if (!/^- /m.test(body)) {
    fail('The `Unreleased` section of CHANGELOG.md is empty: list the changes of this release.');
  }
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    changelog,
    `${text.slice(0, bodyStart)}\n## [${version}] - ${date}\n${body}${next === -1 ? '' : text.slice(next + 1)}`,
  );
}

function set(version) {
  if (!version || !SEMVER.test(version)) fail('Usage: pnpm release:version <x.y.z>');
  // First: an empty Unreleased section stops the release before any file changes.
  releaseChangelog(version);
  replaceJsonVersion(files.package, version);
  replaceJsonVersion(files.tauri, version);
  replaceVersion(files.cargo, CARGO_VERSION, version);
  replaceVersion(files.lock, LOCK_VERSION, version);
  check();
}

const [command, arg] = process.argv.slice(2);
if (command === 'check') check(arg);
else if (command === 'set') set(arg);
else fail('Usage: node scripts/version.mjs check [vX.Y.Z] | set <x.y.z>');
