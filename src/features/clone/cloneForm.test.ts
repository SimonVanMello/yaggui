import { describe, expect, it } from 'vitest';

import {
  buildCloneRequest,
  buildInitRequest,
  joinPath,
  lastSegment,
  parseDepth,
  phaseKey,
  repoNameFromUrl,
  toggleTemplate,
  validateClone,
  validateInit,
  type CloneForm,
} from './cloneForm';

const form: CloneForm = {
  url: 'https://github.com/acme/widget.git',
  parent: '/Users/alex/dev',
  name: 'widget',
  branch: '',
  shallow: false,
  depth: '1',
  submodules: false,
};

describe('repoNameFromUrl', () => {
  it.each([
    ['https://github.com/acme/widget.git', 'widget'],
    ['https://github.com/acme/widget', 'widget'],
    ['https://github.com/acme/widget.git/', 'widget'],
    ['git@github.com:acme/widget.git', 'widget'],
    ['ssh://git@host:2222/srv/widget.git', 'widget'],
    ['file:///srv/git/widget.git', 'widget'],
    ['/srv/git/widget', 'widget'],
    ['C:\\repos\\widget', 'widget'],
    ['git@host:widget.git', 'widget'],
    ['  ', ''],
  ])('%s → %s', (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name);
  });
});

describe('joinPath', () => {
  it('uses the separator of the folder', () => {
    expect(joinPath('/a/b', 'c')).toBe('/a/b/c');
    expect(joinPath('/a/b/', 'c')).toBe('/a/b/c');
    expect(joinPath('C:\\dev', 'c')).toBe('C:\\dev\\c');
    expect(joinPath('C:\\dev\\', 'c')).toBe('C:\\dev\\c');
    expect(joinPath('', 'c')).toBe('c');
  });
  it('lastSegment gives the folder name', () => {
    expect(lastSegment('/a/b/proj/')).toBe('proj');
    expect(lastSegment('C:\\a\\proj')).toBe('proj');
  });
});

describe('validateClone', () => {
  it('accepts a complete form', () => {
    expect(validateClone(form)).toBeNull();
  });
  it('reports the first problem', () => {
    expect(validateClone({ ...form, url: ' ' })).toBe('url');
    expect(validateClone({ ...form, parent: '' })).toBe('parent');
    expect(validateClone({ ...form, name: '' })).toBe('name');
    expect(validateClone({ ...form, name: '../x' })).toBe('name');
    expect(validateClone({ ...form, name: '..' })).toBe('name');
    expect(validateClone({ ...form, shallow: true, depth: '0' })).toBe('depth');
    expect(validateClone({ ...form, shallow: true, depth: '1.5' })).toBe('depth');
  });
  it('ignores the depth when the clone is not shallow', () => {
    expect(validateClone({ ...form, depth: 'abc' })).toBeNull();
  });
});

describe('parseDepth', () => {
  it('accepts whole numbers from 1', () => {
    expect(parseDepth(' 25 ')).toBe(25);
    expect(parseDepth('0')).toBeNull();
    expect(parseDepth('-3')).toBeNull();
    expect(parseDepth('2000000')).toBeNull();
    expect(parseDepth('')).toBeNull();
  });
});

describe('buildCloneRequest', () => {
  it('builds the target and drops empty options', () => {
    expect(buildCloneRequest({ ...form, url: ' https://h/x.git ' }, 'c1')).toEqual({
      cloneId: 'c1',
      url: 'https://h/x.git',
      target: '/Users/alex/dev/widget',
      branch: null,
      depth: null,
      recurseSubmodules: false,
    });
  });
  it('carries branch, depth and submodules', () => {
    const request = buildCloneRequest(
      { ...form, branch: ' dev ', shallow: true, depth: '5', submodules: true },
      'c2',
    );
    expect(request).toMatchObject({ branch: 'dev', depth: 5, recurseSubmodules: true });
  });
});

describe('init form', () => {
  it('validates the folder and the branch', () => {
    const init = { folder: '/p', branch: 'main', gitignore: [], readme: false } as const;
    expect(validateInit(init)).toBeNull();
    expect(validateInit({ ...init, folder: ' ' })).toBe('folder');
    expect(validateInit({ ...init, branch: '' })).toBe('branch');
  });
  it('builds the request', () => {
    expect(
      buildInitRequest({ folder: ' /p ', branch: ' trunk ', gitignore: ['rust'], readme: true }),
    ).toEqual({ target: '/p', defaultBranch: 'trunk', gitignore: ['rust'], readme: true });
  });
  it('toggles templates in a stable order', () => {
    const all = ['node', 'rust', 'dotNet'] as const;
    expect(toggleTemplate(['rust'], 'node', all)).toEqual(['node', 'rust']);
    expect(toggleTemplate(['node', 'rust'], 'node', all)).toEqual(['rust']);
  });
});

describe('phaseKey', () => {
  it('maps the phases of Git and leaves the others alone', () => {
    expect(phaseKey('Receiving objects')).toBe('receiving');
    expect(phaseKey('Resolving deltas')).toBe('resolving');
    expect(phaseKey('Updating files')).toBe('updating');
    expect(phaseKey('Cloning into')).toBeNull();
  });
});
