import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import starlight from '@astrojs/starlight';
import type { StarlightUserConfig } from '@astrojs/starlight/types';
import { defineConfig } from 'astro/config';

import { extractVersions } from './scripts/versions';
import { contentDir, idPrefix, versions, type DocsVersion } from './src/lib/docs-versions';
import { sidebarGroupLabel } from './src/lib/sidebar';

const root = fileURLToPath(new URL('.', import.meta.url));
extractVersions(root, versions);

type SidebarItem = NonNullable<StarlightUserConfig['sidebar']>[number];

/** `sidebar.json` slugs are relative to the docs root of their version: prefix them. */
function prefixItem(file: string, prefix: string, item: SidebarItem): SidebarItem {
  const slug = (s: string) => (s === 'index' || s === '' ? prefix : `${prefix}/${s}`);
  if (typeof item === 'string') return slug(item);
  if ('slug' in item) return { ...item, slug: slug(item.slug) };
  if ('items' in item)
    return { ...item, items: item.items.map((i) => prefixItem(file, prefix, i)) };
  // Starlight autogenerates from file paths, which differ between versions: list the slugs.
  if ('autogenerate' in item) throw new Error(`${file}: \`autogenerate\` is not supported`);
  return item;
}

/** One group per version; the route middleware keeps only the group of the page's version. */
function versionSidebar(v: DocsVersion): SidebarItem {
  const file = `${contentDir(v)}/sidebar.json`;
  if (!existsSync(`${root}${file}`)) throw new Error(`docs ${v.id}: ${file} is missing`);
  const items = JSON.parse(readFileSync(`${root}${file}`, 'utf8')) as SidebarItem[];
  return { label: sidebarGroupLabel(v), items: items.map((i) => prefixItem(file, idPrefix(v), i)) };
}

/**
 * The app scopes its themes to `[data-theme='graphite' | 'paper']` (on any element, for the live
 * preview); the site (like Starlight) uses `data-theme='dark' | 'light'` on the root. Graphite becomes the default, so the site stays dark if the
 * theme script does not run.
 */
const appThemeSelectors = {
  postcssPlugin: 'yaggui-app-theme',
  Rule(rule: { selector: string }) {
    if (!rule.selector.includes('data-theme=')) return;
    rule.selector = rule.selector
      .replace(/(?::root)?\[data-theme='graphite'\]/g, ':root')
      .replace(/(?::root)?\[data-theme='paper'\]/g, ":root[data-theme='light']");
  },
};

const github = 'https://github.com/SimonVanMello/yaggui';

export default defineConfig({
  site: 'https://yaggui.tropico.dev',
  // The demo (`public/demo/`, built from the app) has its own language preference.
  redirects: { '/fr/demo': '/demo/?lang=fr' },
  vite: {
    css: { postcss: { plugins: [appThemeSelectors] } },
    // The theme files are read from the app (`../src/theme/`).
    server: { fs: { allow: ['..'] } },
  },
  integrations: [
    starlight({
      title: 'yaggui',
      description: 'A fast, native Git client for macOS, Windows and Linux.',
      favicon: '/favicon.svg',
      locales: {
        root: { label: 'English', lang: 'en' },
        fr: { label: 'Français', lang: 'fr' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: github }],
      customCss: ['./src/styles/theme.css', './src/styles/docs.css'],
      components: {
        Search: './src/components/starlight/Search.astro',
        SiteTitle: './src/components/starlight/SiteTitle.astro',
      },
      routeMiddleware: './src/route-middleware.ts',
      sidebar: versions.map(versionSidebar),
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        styleOverrides: {
          borderColor: 'var(--border-subtle)',
          borderRadius: '10px',
          codeBackground: 'var(--bg-titlebar)',
          frames: {
            editorTabBarBackground: 'var(--bg-panel)',
            terminalTitlebarBackground: 'var(--bg-panel)',
            frameBoxShadowCssValue: 'none',
          },
        },
      },
    }),
  ],
});
