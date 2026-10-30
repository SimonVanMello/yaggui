// Theme check over the built site CSS (`dist/_astro/`): astro.config.ts rewrites the app's
// Graphite / Paper selectors to the site's `:root` / `:root[data-theme='light']`. When the app
// changes its selectors and the rewrite stops matching, the site silently loses its colors.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const assets = path.resolve(import.meta.dirname, '..', 'dist', '_astro');
const css = readdirSync(assets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(path.join(assets, f), 'utf8'))
  .join('\n');

const errors: string[] = [];
const leftovers = new Set(
  [...css.matchAll(/\[data-theme=['"]?([\w-]+)['"]?\]/g)]
    .map((m) => m[1] ?? '')
    .filter((t) => t !== 'dark' && t !== 'light'),
);
for (const theme of leftovers)
  errors.push(`app theme selector left unrewritten: [data-theme=${theme}]`);
if (!/:root\{[^}]*--bg-app:/.test(css)) errors.push('no :root rule defines --bg-app (dark theme)');
if (!/:root\[data-theme=['"]?light['"]?\]\{[^}]*--bg-app:/.test(css))
  errors.push(":root[data-theme='light'] does not define --bg-app (light theme)");

if (errors.length > 0) {
  console.error(
    `Theme check failed (see appThemeSelectors in astro.config.ts):\n  ${errors.join('\n  ')}`,
  );
  process.exit(1);
}
console.log('Theme: dark and light palettes present.');
