// Internal link check over the built site (`dist/`): every same-site href and src must resolve to
// a built file, and every #fragment to an id of the target page. Covers all versions and locales.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve(import.meta.dirname, '..', 'dist');
const site = 'https://yaggui.tropico.dev';

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return htmlFiles(full);
    return e.name.endsWith('.html') ? [full] : [];
  });
}

/** Built file a site path resolves to, as Cloudflare Pages serves it. */
function resolveFile(urlPath: string): string | undefined {
  const local = path.join(dist, decodeURIComponent(urlPath));
  const candidates = urlPath.endsWith('/')
    ? [path.join(local, 'index.html')]
    : [local, `${local}.html`, path.join(local, 'index.html')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

const idCache = new Map<string, Set<string>>();
function ids(file: string): Set<string> {
  let found = idCache.get(file);
  if (!found) {
    const html = readFileSync(file, 'utf8');
    found = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''));
    idCache.set(file, found);
  }
  return found;
}

const errors: string[] = [];
// The 404 page is served for any path: its canonical and alternate links name no real page.
const pages = htmlFiles(dist).filter((f) => path.relative(dist, f) !== '404.html');
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const pageUrl = new URL(`/${path.relative(dist, page).split(path.sep).join('/')}`, site);
  // Links, images, and the targets of the docs version switcher.
  const refs = [
    ...html.matchAll(/\s(?:href|src)="([^"]*)"/g),
    ...html.matchAll(/<option value="(\/[^"]*)"/g),
  ];
  for (const match of refs) {
    const raw = (match[1] ?? '').replaceAll('&amp;', '&');
    if (raw === '' || (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw) && !raw.startsWith(site)))
      continue;
    const target = new URL(raw, pageUrl);
    const file = resolveFile(target.pathname);
    const where = `${path.relative(dist, page)}: ${raw}`;
    if (!file) {
      errors.push(`${where} (no such page or file)`);
      continue;
    }
    const fragment = decodeURIComponent(target.hash.slice(1));
    if (fragment && file.endsWith('.html') && fragment !== 'top' && !ids(file).has(fragment)) {
      errors.push(`${where} (no #${fragment} there)`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Broken internal links (${errors.length}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`Internal links: ${pages.length} pages checked, no broken link.`);
