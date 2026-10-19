// Strings of the site outside the docs content (layout, components). The docs chrome uses
// Starlight's own translations. W-2 adds the landing page strings here.
import type { Locale } from '../lib/docs-versions';

const en = {
  'site.description': 'A fast, native Git client for macOS, Windows and Linux.',
  'nav.docs': 'Docs',
  'nav.changelog': 'Changelog',
  'nav.releases': 'Releases',
  'nav.download': 'Download',
  'nav.home': 'yaggui home',
  'nav.language': 'Français',
  'nav.languageLabel': 'Lire en français',
  'theme.toggle': 'Switch between dark and light theme',
  'footer.license': 'GPL-3.0-or-later',
  'download.generic': 'Download',
  'download.for': 'Download for {os}',
  'screenshot.open': 'Enlarge: {alt}',
  'screenshot.close': 'Close',
  'screenshot.dialog': 'Enlarged screenshot',
  'versions.label': 'Docs version',
  'versions.latest': '{version} (latest)',
  'versions.next': 'Next (unreleased)',
  'placeholder.title': 'The Git client that keeps up.',
  'placeholder.lead':
    'yaggui is a fast, native Git client for macOS, Windows and Linux. This page is a placeholder: the landing page comes next.',
  'placeholder.docs': 'Read the docs',
};

type Strings = typeof en;

const fr: Strings = {
  'site.description': 'Un client Git rapide et natif pour macOS, Windows et Linux.',
  'nav.docs': 'Docs',
  'nav.changelog': 'Nouveautés',
  'nav.releases': 'Versions',
  'nav.download': 'Télécharger',
  'nav.home': 'Accueil yaggui',
  'nav.language': 'English',
  'nav.languageLabel': 'Read in English',
  'theme.toggle': 'Basculer entre thème sombre et clair',
  'footer.license': 'GPL-3.0-or-later',
  'download.generic': 'Télécharger',
  'download.for': 'Télécharger pour {os}',
  'screenshot.open': 'Agrandir : {alt}',
  'screenshot.close': 'Fermer',
  'screenshot.dialog': "Capture d'écran agrandie",
  'versions.label': 'Version de la documentation',
  'versions.latest': '{version} (dernière)',
  'versions.next': 'Prochaine (non publiée)',
  'placeholder.title': 'Le client Git qui suit le rythme.',
  'placeholder.lead':
    'yaggui est un client Git rapide et natif pour macOS, Windows et Linux. Cette page est provisoire : la page d’accueil arrive.',
  'placeholder.docs': 'Lire la documentation',
};

const strings: Record<Locale, Strings> = { en, fr };

export type StringKey = keyof Strings;

export function t(locale: Locale, key: StringKey, params: Record<string, string> = {}): string {
  return strings[locale][key].replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);
}

/** Locale of a page from its URL: French lives under `/fr/`. */
export function localeOf(url: URL): Locale {
  return url.pathname === '/fr' || url.pathname.startsWith('/fr/') ? 'fr' : 'en';
}

/** Same page in the other locale. */
export function alternatePath(url: URL): string {
  return localeOf(url) === 'fr' ? url.pathname.replace(/^\/fr(\/|$)/, '/') : `/fr${url.pathname}`;
}

/** Path of a site page in a locale: `localePath('fr', '/demo/')` is `/fr/demo/`. */
export function localePath(locale: Locale, path: string): string {
  return locale === 'en' ? path : `/${locale}${path}`;
}
