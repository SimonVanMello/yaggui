import { describe, expect, it } from 'vitest';

import { planAgainstCurrent, planDrop } from './dropActions';

const local = { kind: 'branch', name: 'feat/x', remote: false } as const;
const remote = { kind: 'branch', name: 'origin/feat/x', remote: true } as const;

describe('planDrop', () => {
  it('offers merge, rebase and fast-forward for a branch on another branch', () => {
    const actions = planDrop(local, 'main', 'main');
    expect(actions.map((a) => a.id)).toEqual(['merge', 'rebase', 'fastForward']);
    expect(actions.every((a) => a.disabled === null && !a.needsCheckout)).toBe(true);
    expect(actions[0]).toMatchObject({ source: 'feat/x', target: 'main' });
  });

  it('marks a target that is not checked out, so the front checks it out first', () => {
    const actions = planDrop(local, 'develop', 'main');
    expect(actions.filter((a) => a.id !== 'rebase').every((a) => a.needsCheckout)).toBe(true);
    expect(
      planDrop(local, 'develop', null)
        .filter((a) => a.id !== 'rebase')
        .every((a) => a.needsCheckout),
    ).toBe(true);
  });

  it('does not check the target out for a rebase: the rebased branch is checked out instead', () => {
    const rebase = planDrop(local, 'develop', 'main').find((a) => a.id === 'rebase');
    expect(rebase?.needsCheckout).toBe(false);
  });

  it('offers nothing for a branch dropped on itself', () => {
    expect(planDrop(local, 'feat/x', 'main')).toEqual([]);
  });

  it('lists the rebase of a remote branch as unavailable', () => {
    const rebase = planDrop(remote, 'main', 'main').find((a) => a.id === 'rebase');
    expect(rebase?.disabled).toBe('remoteSource');
    const merge = planDrop(remote, 'main', 'main').find((a) => a.id === 'merge');
    expect(merge?.disabled).toBeNull();
  });

  it('offers a cherry-pick for dragged commits, onto the target branch', () => {
    const actions = planDrop({ kind: 'commits', shas: ['a1', 'b2'] }, 'release', 'main');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: 'cherryPick',
      target: 'release',
      shas: ['a1', 'b2'],
      needsCheckout: true,
    });
  });

  it('offers nothing for an empty commit drag', () => {
    expect(planDrop({ kind: 'commits', shas: [] }, 'main', 'main')).toEqual([]);
  });
});

describe('planAgainstCurrent', () => {
  it('maps the sidebar menu to the same actions, on the current branch', () => {
    const plan = planAgainstCurrent(local, 'main');
    expect(plan.merge).toMatchObject({ source: 'feat/x', target: 'main', needsCheckout: false });
    expect(plan.rebase?.id).toBe('rebase');
    expect(plan.fastForward?.id).toBe('fastForward');
  });

  it('has nothing for the current branch or a detached HEAD', () => {
    expect(planAgainstCurrent(local, 'feat/x').merge).toBeNull();
    expect(planAgainstCurrent(local, null).merge).toBeNull();
  });
});
