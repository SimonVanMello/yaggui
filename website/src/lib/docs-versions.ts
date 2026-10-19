// Docs versions: the pure part shared by the Astro config (content loader, sidebar), the route
// middleware and the version switcher. Extraction from git lives in scripts/versions.ts.
import versionsFile from '../../versions.json' with { type: 'json' };

/** One entry of `website/versions.json`: a released version and the commit its docs come from. */
export interface VersionEntry {
  version: string;
  ref: string;
}

export interface DocsVersion {
  /** `0.4.0`, or `next` for the docs of `master`. */
  id: string;
  /** URL segment after `/docs/`: empty for the default version. */
  segment: string;
  /** Released version number, absent for `master`. */
  version?: string;
  /** Git commit to extract, absent for `master` (read from the working tree). */
  ref?: string;
  isDefault: boolean;
  /** The highest released version (the default once any version is released). */
  isLatest: boolean;
}

export const NEXT_ID = 'next';
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
/** Root of the extracted versions, relative to `website/`. */
export const VERSIONS_CACHE = '.cache/versions';
/** Docs content of `master`, relative to `website/`. */
export const MASTER_CONTENT = 'src/content/docs';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REF_RE = /^[0-9a-f]{7,40}$|^v\d+\.\d+\.\d+$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseVersionEntries(raw: unknown): VersionEntry[] {
  if (!Array.isArray(raw)) throw new Error('versions.json must be an array');
  const seen = new Set<string>();
  return raw.map((item: unknown, i) => {
    if (typeof item !== 'object' || item === null) throw new Error(`versions.json[${i}]: object`);
    const { version, ref } = item as Record<string, unknown>;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw new Error(`versions.json[${i}].version must be X.Y.Z`);
    }
    // The ref is passed to git: a strict format rules out options and revision expressions.
    if (typeof ref !== 'string' || !REF_RE.test(ref)) {
      throw new Error(`versions.json[${i}].ref must be a commit SHA or a vX.Y.Z tag`);
    }
    if (seen.has(version)) throw new Error(`versions.json: ${version} is listed twice`);
    seen.add(version);
    return { version, ref };
  });
}

/**
 * The published docs versions, in switcher order: latest release (default), `next`, older releases.
 * With no release listed (bootstrap), `master` alone is served at `/docs/`.
 */
export function docsVersions(entries: VersionEntry[]): DocsVersion[] {
  const released = [...entries].sort((a, b) => compareVersions(b.version, a.version));
  const [latest, ...older] = released;
  if (!latest) return [{ id: NEXT_ID, segment: '', isDefault: true, isLatest: false }];
  const asVersion = (e: VersionEntry, isLatest: boolean): DocsVersion => ({
    id: e.version,
    segment: isLatest ? '' : e.version,
    version: e.version,
    ref: e.ref,
    isDefault: isLatest,
    isLatest,
  });
  return [
    asVersion(latest, true),
    { id: NEXT_ID, segment: NEXT_ID, isDefault: false, isLatest: false },
    ...older.map((e) => asVersion(e, false)),
  ];
}

export const versions: DocsVersion[] = docsVersions(parseVersionEntries(versionsFile));

function findDefault(all: DocsVersion[]): DocsVersion {
  const found = all.find((v) => v.isDefault);
  if (!found) throw new Error('docs versions: no default version');
  return found;
}

/** Version served at `/docs/`. */
export const defaultVersion: DocsVersion = findDefault(versions);

/** Folder holding the `en/` and `fr/` docs of a version, relative to `website/`. */
export function contentDir(v: DocsVersion): string {
  return v.ref ? `${VERSIONS_CACHE}/${v.id}/website/${MASTER_CONTENT}` : MASTER_CONTENT;
}

/** Content id prefix of a version in the root (English) locale: `docs`, `docs/next`, `docs/0.3.0`. */
export function idPrefix(v: DocsVersion): string {
  return v.segment ? `docs/${v.segment}` : 'docs';
}

function slugifySegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Page path inside a version (`guides/staging`, `` for the docs home) from a file path. */
export function pagePath(fileInLocale: string): string {
  const segments = fileInLocale
    .replace(/\.mdx?$/, '')
    .split('/')
    .map(slugifySegment);
  if (segments.at(-1) === 'index') segments.pop();
  return segments.join('/');
}

export interface ParsedId {
  locale: Locale;
  version: DocsVersion;
  /** Page path inside the version, without leading or trailing slash. */
  page: string;
}

/** Splits a Starlight content id (`fr/docs/next/guides/staging`) into locale, version and page. */
export function parseId(id: string, all: DocsVersion[] = versions): ParsedId | undefined {
  let rest = id;
  let locale: Locale = 'en';
  if (rest === 'fr' || rest.startsWith('fr/')) {
    locale = 'fr';
    rest = rest.slice(3);
  }
  if (rest !== 'docs' && !rest.startsWith('docs/')) return undefined;
  rest = rest.slice(5);
  const [first = '', ...tail] = rest.split('/');
  const version = all.find((v) => v.segment !== '' && v.segment === first);
  if (version) return { locale, version, page: tail.join('/') };
  return { locale, version: findDefault(all), page: rest };
}

export function contentId(locale: Locale, v: DocsVersion, page: string): string {
  return [locale === 'en' ? '' : locale, idPrefix(v), page].filter(Boolean).join('/');
}

export function docsHref(locale: Locale, v: DocsVersion, page = ''): string {
  return `/${contentId(locale, v, page)}/`;
}
