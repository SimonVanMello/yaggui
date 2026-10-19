// Latest release, read once per build from the GitHub API. Without network or on an API error
// (rate limit, no published release yet), falls back to the version of the app's package.json and
// the asset names of docs/RELEASING.md.
import appPackage from '../../../package.json' with { type: 'json' };

export const REPOSITORY = 'SimonVanMello/yaggui';
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const AUR_URL = 'https://aur.archlinux.org/packages/yaggui-bin';
export const HOMEBREW_COMMAND = 'brew install --cask simonvanmello/yaggui/yaggui';
export const CHANGELOG_URL = `${REPOSITORY_URL}/blob/master/CHANGELOG.md`;

export type Platform =
  | 'macos-arm64'
  | 'macos-x64'
  | 'windows-exe'
  | 'windows-msi'
  | 'linux-appimage'
  | 'linux-deb'
  | 'linux-rpm';

/** Asset file names per platform, from docs/RELEASING.md. */
export const ASSET_NAMES: Record<Platform, (version: string) => string> = {
  'macos-arm64': (v) => `yaggui_${v}_aarch64.dmg`,
  'macos-x64': (v) => `yaggui_${v}_x64.dmg`,
  'windows-exe': (v) => `yaggui_${v}_x64-setup.exe`,
  'windows-msi': (v) => `yaggui_${v}_x64_en-US.msi`,
  'linux-appimage': (v) => `yaggui_${v}_amd64.AppImage`,
  'linux-deb': (v) => `yaggui_${v}_amd64.deb`,
  'linux-rpm': (v) => `yaggui-${v}-1.x86_64.rpm`,
};

export interface Release {
  version: string;
  /** Release page on GitHub. */
  url: string;
  /** Download URL per platform; a platform the release lacks links to the release page. */
  assets: Record<Platform, string>;
  source: 'github' | 'package.json';
}

interface ApiRelease {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string }[];
}

function isApiRelease(value: unknown): value is ApiRelease {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tag_name === 'string' && typeof r.html_url === 'string' && Array.isArray(r.assets)
  );
}

function fromPackage(): Release {
  const version = appPackage.version;
  const base = `${RELEASES_URL}/download/v${version}`;
  const assets = Object.fromEntries(
    Object.entries(ASSET_NAMES).map(([p, name]) => [p, `${base}/${name(version)}`]),
  ) as Record<Platform, string>;
  return { version, url: `${RELEASES_URL}/tag/v${version}`, assets, source: 'package.json' };
}

async function fromGitHub(): Promise<Release> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isApiRelease(body)) throw new Error('GitHub API: unexpected response');
  const version = body.tag_name.replace(/^v/, '');
  const byName = new Map(body.assets.map((a) => [a.name, a.browser_download_url]));
  const assets = Object.fromEntries(
    Object.entries(ASSET_NAMES).map(([p, name]) => [p, byName.get(name(version)) ?? body.html_url]),
  ) as Record<Platform, string>;
  return { version, url: body.html_url, assets, source: 'github' };
}

let latest: Promise<Release> | undefined;

export function getLatestRelease(): Promise<Release> {
  latest ??= fromGitHub().catch((error: unknown) => {
    console.warn(`[release] ${String(error)}; using package.json`);
    return fromPackage();
  });
  return latest;
}
