import { describe, expect, it } from 'vitest';

import {
  analyze,
  annotations,
  globToRegExp,
  matchesAny,
  parseSources,
  render,
} from './docs-impact.mjs';

const PAGES = [
  {
    page: 'website/src/content/docs/en/guides/staging.mdx',
    fr: 'website/src/content/docs/fr/guides/staging.mdx',
    sources: ['src/features/staging/**', 'src-tauri/src/repo/write.rs'],
  },
  {
    page: 'website/src/content/docs/en/index.mdx',
    fr: 'website/src/content/docs/fr/index.mdx',
    sources: [],
  },
];

describe('globToRegExp', () => {
  it('handles ** across folders, * within one, and exact paths', () => {
    expect(matchesAny('src/features/staging/a/b.tsx', ['src/features/staging/**'])).toBe(true);
    expect(matchesAny('src/features/stagingx/a.tsx', ['src/features/staging/**'])).toBe(false);
    expect(matchesAny('src/i18n/en.json', ['src/i18n/*.json'])).toBe(true);
    expect(matchesAny('src/i18n/a/en.json', ['src/i18n/*.json'])).toBe(false);
    expect(matchesAny('a/b/c.rs', ['**/c.rs'])).toBe(true);
    expect(matchesAny('c.rs', ['**/c.rs'])).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('parseSources', () => {
  it('reads block lists, inline lists, quotes and comments', () => {
    const block =
      '---\ntitle: x\nsources:   # code\n  - src/a/**\n  - "src/b.rs" # why\nrequirements: []\n---\nbody';
    expect(parseSources(block)).toEqual(['src/a/**', 'src/b.rs']);
    expect(parseSources('---\nsources: [src/a/**, "src/b"]\n---')).toEqual(['src/a/**', 'src/b']);
    expect(parseSources('---\nsources: []\n---')).toEqual([]);
    expect(parseSources('no frontmatter')).toEqual([]);
  });
});

describe('analyze', () => {
  it('flags pages whose sources changed without the page', () => {
    const { stale } = analyze(['src/features/staging/Panel.tsx'], PAGES);
    expect(stale.map((p) => p.page)).toEqual([PAGES[0].page]);
  });

  it('does not flag a page that was updated, but flags the missing language', () => {
    const changed = ['src/features/staging/Panel.tsx', PAGES[0].page];
    const result = analyze(changed, PAGES);
    expect(result.stale).toEqual([]);
    expect(result.unsynced).toEqual([{ page: PAGES[0].page, fr: PAGES[0].fr, missing: 'fr' }]);
    expect(analyze([...changed, PAGES[0].fr], PAGES).unsynced).toEqual([]);
  });

  it('reports user-facing files covered by no page, ignoring tests', () => {
    const { uncovered } = analyze(
      [
        'src/features/newthing/A.tsx',
        'src/features/newthing/A.test.tsx',
        'src/i18n/fr.json',
        'README.md',
        'src/features/staging/x.ts',
      ],
      PAGES,
    );
    expect(uncovered).toEqual(['src/features/newthing/A.tsx', 'src/i18n/fr.json']);
  });

  it('is silent when nothing is concerned', () => {
    expect(
      render(analyze(['src-tauri/src/graph/lanes.rs', '.github/workflows/ci.yml'], PAGES)),
    ).toBeNull();
  });

  it('renders a report and annotations for a fake diff', () => {
    const result = analyze(
      ['src/features/staging/Panel.tsx', 'src/features/newthing/A.tsx'],
      PAGES,
    );
    const report = render(result) ?? '';
    expect(report).toContain('guides/staging.mdx');
    expect(report).toContain('`src/features/newthing/**`');
    const lines = annotations(result);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('::warning '))).toBe(true);
  });
});
