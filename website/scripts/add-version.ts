// Adds a released version to versions.json: `node website/scripts/add-version.ts 0.5.0 <sha>`.
// Run by .github/workflows/docs-version.yml when a release is published. Prints `added`,
// `present` (already listed) or `bootstrap` (versions.json still empty: the first entry is added by
// hand once the docs are complete, see website/README.md).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { compareVersions, parseVersionEntries } from '../src/lib/docs-versions.ts';

const [version, ref] = process.argv.slice(2);
if (!version || !ref) {
  console.error('usage: add-version.ts <x.y.z> <commit sha>');
  process.exit(2);
}

const file = path.resolve(import.meta.dirname, '..', 'versions.json');
const entries = parseVersionEntries(JSON.parse(readFileSync(file, 'utf8')));

if (entries.length === 0) {
  console.log('bootstrap');
} else if (entries.some((e) => e.version === version)) {
  console.log('present');
} else {
  // Validates the new entry with the same rules as the build.
  const next = parseVersionEntries([...entries, { version, ref }]).sort((a, b) =>
    compareVersions(b.version, a.version),
  );
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log('added');
}
