// Docs versions, shared by the Astro config (content loader, sidebar), the route middleware and
// the version switcher. Every `vX.Y.Z` tag whose tree has the docs is a version; versions.json can
// override that. Extraction of each version's files lives in scripts/versions.ts.
import { execFileSync } from 'node:child_process';

import overridesFile from '../../versions.json' with { type: 'json' };

/** A released version and the git ref its docs come from. */
export interface VersionEntry {
  version: string;
  ref: string;
}

/** One entry of `website/versions.json`: another ref for a version, or a version hidden. */
export interface VersionOverride {
  version: string;
  ref?: string;
  hidden?: boolean;
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

export function parseOverrides(raw: unknown): VersionOverride[] {
  if (!Array.isArray(raw)) throw new Error('versions.json must be an array');
  const seen = new Set<string>();
  return raw.map((item: unknown, i) => {
    if (typeof item !== 'object' || item === null) throw new Error(`versions.json[${i}]: object`);
    const { version, ref, hidden } = item as Record<string, unknown>;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw new Error(`versions.json[${i}].version must be X.Y.Z`);
    }
    // The ref is passed to git: a strict format rules out options and revision expressions.
    if (ref !== undefined && (typeof ref !== 'string' || !REF_RE.test(ref))) {
      throw new Error(`versions.json[${i}].ref must be a commit SHA or a vX.Y.Z tag`);
    }
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      throw new Error(`versions.json[${i}].hidden must be a boolean`);
    }
    if (ref === undefined && hidden !== true) {
      throw new Error(`versions.json[${i}]: give a ref or "hidden": true`);
    }
    if (seen.has(version)) throw new Error(`versions.json: ${version} is listed twice`);
    seen.add(version);
    return { version, ...(ref !== undefined && { ref }), ...(hidden !== undefined && { hidden }) };
  });
}

/** Docs folder in a ref's tree, from the repository root. */
export const DOCS_PATH = `website/${MASTER_CONTENT}`;

/** Release tags (`vX.Y.Z`) of the repository whose tree has the docs. */
export function taggedVersions(cwd = process.cwd()): VersionEntry[] {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return git(['tag', '--list', 'v*'])
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .filter((tag) => {
      try {
        git(['cat-file', '-e', `${tag}^{commit}:${DOCS_PATH}`]);
        return true;
      } catch {
        return false;
      }
    })
    .map((tag) => ({ version: tag.slice(1), ref: tag }));
}

/** Tagged versions with the overrides of versions.json applied. */
export function resolveEntries(
  tagged: VersionEntry[],
  overrides: VersionOverride[],
): VersionEntry[] {
  const byVersion = new Map(tagged.map((e) => [e.version, e]));
  for (const o of overrides) {
    if (o.hidden) byVersion.delete(o.version);
    else if (o.ref) byVersion.set(o.version, { version: o.version, ref: o.ref });
  }
  return [...byVersion.values()];
}

/**
 * The published docs versions, in switcher order: latest release (default), `next`, older releases.
 * With no released docs yet (bootstrap), `master` alone is served at `/docs/`.
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

export const versions: DocsVersion[] = docsVersions(
  resolveEntries(taggedVersions(), parseOverrides(overridesFile)),
);

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
