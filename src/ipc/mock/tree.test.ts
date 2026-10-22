import { beforeEach, describe, expect, it } from 'vitest';

import type { TreeEntry } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

async function yaggui() {
  return (await unwrap(mock.openRepo('/Users/alex/dev/yaggui'))).id;
}

/** The mock answers like the real backend (`src-tauri/tests/tree.rs`). */
describe('mock tree at a commit', () => {
  it('lists folders first, then files by name, and resolves the revision', async () => {
    const id = await yaggui();
    const page = await unwrap(mock.treeList(id, 'HEAD', '', 0, 500));
    expect(page.rev).toMatch(/^[0-9a-f]{40}$/);
    const kinds = page.entries.map((e) => e.kind === 'dir');
    expect(kinds.indexOf(false)).toBe(kinds.filter(Boolean).length);
    const files = page.entries.filter((e) => e.kind !== 'dir').map((e) => e.name.toLowerCase());
    expect(files).toEqual([...files].sort());
    expect(page.total).toBe(page.entries.length);
    // The same commit by its SHA gives the same listing.
    expect(await unwrap(mock.treeList(id, page.rev, '', 0, 500))).toEqual(page);
  });

  it('pages a large folder and never above 500 entries', async () => {
    const id = await yaggui();
    const first = await unwrap(mock.treeList(id, 'HEAD', 'vendor/many', 0, 100_000));
    expect(first.total).toBe(1200);
    expect(first.entries).toHaveLength(500);
    const all: TreeEntry[] = [...first.entries];
    for (let start = 500; start < first.total; start += 500) {
      all.push(...(await unwrap(mock.treeList(id, 'HEAD', 'vendor/many', start, 500))).entries);
    }
    expect(all).toHaveLength(1200);
    expect(new Set(all.map((e) => e.name)).size).toBe(1200);
  });

  it('rejects unknown revisions, missing folders and bad paths', async () => {
    const id = await yaggui();
    expect(await mock.treeList(id, 'nope', '', 0, 10)).toMatchObject({
      error: { code: 'revisionNotFound' },
    });
    for (const path of ['missing', '../x', 'a//b']) {
      expect(await mock.treeList(id, 'HEAD', path, 0, 10)).toMatchObject({
        error: { code: 'invalidArgument' },
      });
    }
    // A file is not a folder, a folder is not a file.
    expect(await mock.treeList(id, 'HEAD', 'README.md', 0, 10)).toMatchObject({
      error: { code: 'invalidArgument' },
    });
    expect(await mock.treeFile(id, 'HEAD', 'docs', false)).toMatchObject({
      error: { code: 'invalidArgument' },
    });
  });

  it('shows each kind of file, and only reads a large text when forced', async () => {
    const id = await yaggui();
    const content = async (path: string, force = false) =>
      (await unwrap(mock.treeFile(id, 'HEAD', path, force))).content.kind;
    expect(await content('README.md')).toBe('text');
    expect(await content('assets/logo.png')).toBe('image');
    expect(await content('assets/archive.bin')).toBe('binary');
    expect(await content('assets/model.bin')).toBe('lfs');
    expect(await content('docs/readme-link')).toBe('symlink');
    expect(await content('libs/vendored')).toBe('submodule');
    expect(await content('data/huge-dump.txt')).toBe('tooLarge');
    expect(await content('data/huge-dump.txt', true)).toBe('text');
    expect((await unwrap(mock.treeFile(id, 'HEAD', 'scripts/run.sh', false))).executable).toBe(
      true,
    );
  });

  it('versions files per commit: some change, some only exist in some commits', async () => {
    const id = await yaggui();
    const refs = await unwrap(mock.listRefs(id));
    const shas = [...new Set(refs.local.map((b) => b.sha))];
    const texts = new Set<string>();
    for (const sha of shas) {
      const file = await unwrap(mock.treeFile(id, sha, 'src/app/App.tsx', false));
      if (file.content.kind === 'text') texts.add(file.content.text);
    }
    expect(texts.size).toBeGreaterThan(1);
  });

  it('saves a version, never a submodule, and a cancel writes nothing', async () => {
    const id = await yaggui();
    expect(await unwrap(mock.saveTreeFile(id, 'HEAD', 'src/main.tsx', 'Save'))).toBe(
      '~/Downloads/main.tsx',
    );
    mockBackend.setPickedSave(null);
    expect(await unwrap(mock.saveTreeFile(id, 'HEAD', 'README.md', 'Save'))).toBeNull();
    expect(await mock.saveTreeFile(id, 'HEAD', 'libs/vendored', 'Save')).toMatchObject({
      error: { code: 'invalidArgument' },
    });
    expect(mockBackend.savedTreeFilesList()).toHaveLength(1);
  });
});
