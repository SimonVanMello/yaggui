import { describe, expect, it } from 'vitest';

import type { RemoteRefs } from '../../ipc';
import { fetchRemotes } from './fetchRemotes';

const remote = (name: string, url: string | null): RemoteRefs => ({
  name,
  url,
  pushUrl: null,
  branches: [],
});

describe('fetchRemotes', () => {
  it('lists the configured remotes, origin first, in the order of the refs', () => {
    expect(
      fetchRemotes([remote('upstream', 'u'), remote('fork', 'f'), remote('origin', 'o')]),
    ).toEqual(['origin', 'upstream', 'fork']);
  });

  it('skips the branches left by a removed remote and handles missing refs', () => {
    expect(fetchRemotes([remote('origin', 'o'), remote('gone', null)])).toEqual(['origin']);
    expect(fetchRemotes(undefined)).toEqual([]);
  });
});
