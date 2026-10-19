// Regenerates website/src/content/docs/_data/shortcuts.json from the app's action registry.
// The generator is a Vitest test (the registry needs the app's modules and a DOM) whose file
// snapshot is the data file: `-u` rewrites it, a plain run (`pnpm check`) fails when it is stale.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'src/features/keybindings/shortcutReference.test.ts', '--update'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
