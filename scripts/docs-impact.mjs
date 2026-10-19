// docs-impact: which documentation pages may be out of date given a set of changed files?
//
//   node scripts/docs-impact.mjs [--base <ref>] [--files-from-stdin] [--github]
//
// Matches the changed files against the `sources` globs of every English docs page
// (website/src/content/docs/en/**), and reports:
//   - pages whose sources changed without the page being touched;
//   - pages touched in one language only (the French counterpart is flagged too);
//   - changed user-facing files that no page lists in its `sources`.
// It is advisory: it always exits 0. `Docs: not needed (<reason>)` in the PR description (env
// `PR_BODY`) silences it. With --github it also writes ::warning annotations and the job summary.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS_ROOT = 'website/src/content/docs';

/** Files that change what users see or can do; one of these covered by no page is a gap. */
export const USER_FACING = [
  'src/features/**',
  'src/app/**',
  'src/ui/**',
  'src/i18n/*.json',
  'src-tauri/src/commands/**',
  'src-tauri/src/repo/**',
  'src-tauri/src/git/ops/**',
  'src-tauri/src/git/errors.rs',
];

/** Never user-facing, even under a user-facing folder. */
const IGNORED = ['**/*.test.*', '**/*.module.css.d.ts', '**/__snapshots__/**'];

/** Converts a repository-relative glob (`*`, `**`, `?`) to a regular expression. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/** Reads `sources` from the YAML frontmatter (block list, inline list, or empty). */
export function parseSources(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  const start = lines.findIndex((line) => /^sources\s*:/.test(line));
  if (start === -1) return [];
  const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const inline = lines[start]
    .replace(/^sources\s*:/, '')
    .replace(/\s+#.*$/, '')
    .trim();
  if (inline.startsWith('[')) {
    return inline.slice(1, inline.lastIndexOf(']')).split(',').map(unquote).filter(Boolean);
  }
  const sources = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(.*?)\s*(?:\s#.*)?$/.exec(line);
    if (item) sources.push(unquote(item[1]));
    else if (line.trim() !== '' && !/^\s*#/.test(line)) break;
  }
  return sources;
}

/** English pages with their sources: `[{ page, fr, sources }]`, paths relative to the repository. */
export function loadPages(repoRoot = '.') {
  const enDir = path.join(repoRoot, DOCS_ROOT, 'en');
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mdx?$/.test(entry.name) && !entry.name.startsWith('_')) {
        const page = path.relative(repoRoot, full).split(path.sep).join('/');
        pages.push({
          page,
          fr: page.replace(`${DOCS_ROOT}/en/`, `${DOCS_ROOT}/fr/`),
          sources: parseSources(readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(enDir);
  return pages.sort((a, b) => a.page.localeCompare(b.page));
}

/** Pure analysis of a change set against the pages. */
export function analyze(changed, pages) {
  const set = new Set(changed);
  const stale = [];
  const unsynced = [];
  const covered = new Set();

  for (const page of pages) {
    const hits = changed.filter((file) => matchesAny(file, page.sources));
    for (const file of hits) covered.add(file);
    const enTouched = set.has(page.page);
    const frTouched = set.has(page.fr);
    if (hits.length > 0 && !enTouched) stale.push({ ...page, hits, frTouched });
    if (enTouched !== frTouched) {
      unsynced.push({ page: page.page, fr: page.fr, missing: enTouched ? 'fr' : 'en' });
    }
  }

  const uncovered = changed.filter(
    (file) =>
      !file.startsWith(`${DOCS_ROOT}/`) &&
      matchesAny(file, USER_FACING) &&
      !matchesAny(file, IGNORED) &&
      !covered.has(file),
  );
  return { stale, unsynced, uncovered };
}

/** `src/features/foo/Bar.tsx` → `src/features/foo/**`; other files stay as they are. */
function folderOf(file) {
  const parts = file.split('/');
  return parts[0] === 'src' && parts[1] === 'features' && parts.length > 3
    ? `${parts.slice(0, 3).join('/')}/**`
    : file;
}

export function render({ stale, unsynced, uncovered }) {
  if (stale.length + unsynced.length + uncovered.length === 0) return null;
  const out = ['## Docs impact', ''];
  out.push(
    'Advisory only. Update the pages below in this PR (English and French together), or put ' +
      '`Docs: not needed (<reason>)` in the PR description.',
    '',
  );
  if (stale.length > 0) {
    out.push('### Pages whose sources changed but that were not updated', '');
    for (const p of stale) {
      const files = p.hits.slice(0, 5).map((f) => `\`${f}\``);
      const more = p.hits.length > 5 ? `, +${String(p.hits.length - 5)} more` : '';
      out.push(`- \`${p.page}\` (and \`${p.fr}\`): ${files.join(', ')}${more}`);
    }
    out.push('');
  }
  if (unsynced.length > 0) {
    out.push('### Pages updated in one language only', '');
    for (const u of unsynced) {
      const todo = u.missing === 'fr' ? u.fr : u.page;
      out.push(`- \`${todo}\` is missing the matching update`);
    }
    out.push('');
  }
  if (uncovered.length > 0) {
    out.push(
      '### Changed user-facing files that no page lists in `sources`',
      '',
      'Add them to the `sources` of the page that documents them, or create a page.',
      '',
    );
    for (const folder of [...new Set(uncovered.map(folderOf))]) out.push(`- \`${folder}\``);
    out.push('');
  }
  return out.join('\n');
}

/** `::warning` workflow commands, one per finding. */
export function annotations({ stale, unsynced, uncovered }) {
  const lines = [];
  for (const p of stale) {
    lines.push(
      `::warning file=${p.page},title=Docs may be out of date::Sources changed (${p.hits[0]}) but this page and its French counterpart were not updated. Update them or add "Docs: not needed (reason)" to the PR description.`,
    );
  }
  for (const u of unsynced) {
    const file = u.missing === 'fr' ? u.fr : u.page;
    lines.push(
      `::warning file=${file},title=Docs in one language only::The other language of this page was updated in this PR but this one was not.`,
    );
  }
  if (uncovered.length > 0) {
    lines.push(
      `::warning title=User-facing files without docs::${[...new Set(uncovered.map(folderOf))].join(', ')} are listed in the sources of no docs page.`,
    );
  }
  return lines;
}

export const SKIP_PATTERN = /Docs:\s*not needed/i;

function changedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    if (SKIP_PATTERN.test(process.env.PR_BODY ?? '')) {
      console.log('Docs impact: skipped (`Docs: not needed` in the PR description).');
      return;
    }
    const changed = flag('--files-from-stdin')
      ? readFileSync(0, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : changedFiles(value('--base') ?? 'origin/master');
    const result = analyze(changed, loadPages());
    const report = render(result);
    if (report === null) {
      console.log('Docs impact: nothing to report.');
      return;
    }
    console.log(report);
    if (flag('--github')) {
      for (const line of annotations(result)) console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    }
  } catch (error) {
    // Advisory tool: a failure to analyze must not block a PR.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::warning title=docs-impact could not run::${message.replace(/\n/g, ' ')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
