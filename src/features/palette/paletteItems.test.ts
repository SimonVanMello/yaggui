import { describe, expect, it } from 'vitest';

import {
  kindMatchesMode,
  parseQuery,
  rankItems,
  type ItemKind,
  type PaletteItem,
} from './paletteItems';
import { MAX_RECENTS, pushRecentKey } from './paletteStore';

function item(kind: ItemKind, label: string, patch: Partial<PaletteItem> = {}): PaletteItem {
  return { key: `${kind}:${label}`, kind, label, activate: () => undefined, ...patch };
}

describe('parseQuery', () => {
  it('detects the optional prefixes', () => {
    expect(parseQuery('> new tab')).toEqual({ mode: 'action', text: 'new tab' });
    expect(parseQuery('@main')).toEqual({ mode: 'branch', text: 'main' });
    expect(parseQuery('#fix')).toEqual({ mode: 'commit', text: 'fix' });
    expect(parseQuery('/src')).toEqual({ mode: 'file', text: 'src' });
  });

  it('searches everything without a prefix', () => {
    expect(parseQuery('  feat/x ')).toEqual({ mode: 'all', text: 'feat/x' });
    expect(parseQuery('')).toEqual({ mode: 'all', text: '' });
  });

  it('lets @ cover branches and tags', () => {
    expect(kindMatchesMode('tag', 'branch')).toBe(true);
    expect(kindMatchesMode('commit', 'branch')).toBe(false);
    expect(kindMatchesMode('commit', 'all')).toBe(true);
  });
});

describe('rankItems', () => {
  const pool = [
    item('action', 'Toggle the command log'),
    item('branch', 'feat/log-viewer'),
    item('branch', 'main'),
    item('tag', 'v1.0.0'),
  ];

  it('without a query, puts recents first, most recent first', () => {
    const { items, total } = rankItems(pool, '', ['tag:v1.0.0', 'branch:main']);
    expect(items.map((r) => r.item.label).slice(0, 2)).toEqual(['v1.0.0', 'main']);
    expect(total).toBe(4);
  });

  it('ignores recents that are not in the pool', () => {
    const { items } = rankItems(pool, '', ['branch:gone']);
    expect(items).toHaveLength(4);
  });

  it('keeps only fuzzy matches and returns their indices', () => {
    const { items } = rankItems(pool, 'mai', []);
    expect(items.map((r) => r.item.label)).toEqual(['main']);
    expect(items[0]?.indices).toEqual([0, 1, 2]);
  });

  it('boosts recents among equal matches', () => {
    const both = [item('branch', 'log-a'), item('branch', 'log-b')];
    expect(rankItems(both, 'log', []).items[0]?.item.label).toBe('log-a');
    expect(rankItems(both, 'log', ['branch:log-b']).items[0]?.item.label).toBe('log-b');
  });

  it('sinks disabled items and keeps commits (already filtered by the backend) last', () => {
    const mixed = [
      item('action', 'Push', { disabled: true, boost: -20 }),
      item('commit', 'unrelated message'),
      item('branch', 'push-fix'),
    ];
    expect(rankItems(mixed, 'push', []).items.map((r) => r.item.label)).toEqual([
      'push-fix',
      'Push',
      'unrelated message',
    ]);
  });

  it('caps the results and reports the total', () => {
    const many = Array.from({ length: 300 }, (_, i) => item('branch', `branch-${String(i)}`));
    const { items, total } = rankItems(many, 'br', []);
    expect(items).toHaveLength(50);
    expect(total).toBe(300);
  });
});

describe('pushRecentKey', () => {
  it('moves a key to the front without duplicating it', () => {
    expect(pushRecentKey(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_RECENTS }, (_, i) => String(i));
    expect(pushRecentKey(many, 'new')).toHaveLength(MAX_RECENTS);
  });
});
