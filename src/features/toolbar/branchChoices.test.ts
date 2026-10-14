import { describe, expect, it } from 'vitest';
import { MAX_CHOICES, rankChoices, type BranchChoice } from './branchChoices';

function choice(name: string, remote = false): BranchChoice {
  return {
    name,
    remote,
    current: false,
    target: { kind: 'local', branch: { name } } as unknown as BranchChoice['target'],
    indices: [],
  };
}

describe('rankChoices', () => {
  const all = [choice('main'), choice('feat/graph'), choice('origin/main', true), choice('dev')];

  it('without query: recent first, then local, then remote', () => {
    const { items, total } = rankChoices(all, '', ['dev']);
    expect(items.map((c) => c.name)).toEqual(['dev', 'feat/graph', 'main', 'origin/main']);
    expect(total).toBe(4);
  });

  it('with a query: filters, fills match indices, prefers local on ties', () => {
    const { items } = rankChoices(all, 'main', []);
    expect(items.map((c) => c.name)).toEqual(['main', 'origin/main']);
    expect(items[0]?.indices.length).toBe(4);
  });

  it('caps the rendered list but reports the total', () => {
    const many = Array.from({ length: 300 }, (_, i) => choice(`b${i}`));
    const { items, total } = rankChoices(many, '', []);
    expect(items).toHaveLength(MAX_CHOICES);
    expect(total).toBe(300);
  });
});
