import { describe, expect, it } from 'vitest';

import { planAgainstCurrent, planDrop, type BranchDrag } from './dropActions';

const local = { kind: 'branch', name: 'feat/x', remote: false } as const;
const remote = { kind: 'branch', name: 'origin/feat/x', remote: true } as const;

describe('planDrop', () => {
  it('offers merge, rebase and fast-forward for a branch on another branch', () => {
    const actions = planDrop(local, 'main', 'main');
    expect(actions.map((a) => a.id)).toEqual(['merge', 'rebase', 'fastForward']);
    expect(actions.every((a) => a.disabled === null && !a.needsCheckout)).toBe(true);
    expect(actions[0]).toMatchObject({ source: 'feat/x', target: 'main' });
  });

  it('marks a merge target that is not checked out, so the front checks it out first', () => {
    expect(planDrop(local, 'develop', 'main').find((a) => a.id === 'merge')?.needsCheckout).toBe(
      true,
    );
    expect(planDrop(local, 'develop', null).find((a) => a.id === 'merge')?.needsCheckout).toBe(
      true,
    );
  });

  it('never checks out for a fast-forward: the backend moves the branch without it', () => {
    const ff = planDrop(local, 'develop', 'main').find((a) => a.id === 'fastForward');
    expect(ff).toMatchObject({ source: 'feat/x', target: 'develop', needsCheckout: false });
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

  it('fast-forwards whichever branch is behind, whatever was dragged onto what', () => {
    const ff = (relation: Parameters<typeof planDrop>[3], payload: BranchDrag = local) =>
      planDrop(payload, 'develop', 'main', relation).find((a) => a.id === 'fastForward');
    // develop is behind feat/x: dropping feat/x on develop moves develop…
    expect(ff('ahead')).toMatchObject({ source: 'feat/x', target: 'develop', disabled: null });
    // …and so does dropping develop on feat/x (feat/x dragged here is behind develop: it moves).
    expect(ff('behind')).toMatchObject({ source: 'develop', target: 'feat/x', disabled: null });
    expect(ff('same')?.disabled).toBe('upToDate');
    expect(ff('diverged')?.disabled).toBe('diverged');
    // A remote branch behind the target cannot move: the target already contains it.
    expect(ff('behind', remote)).toMatchObject({
      source: 'origin/feat/x',
      target: 'develop',
      disabled: 'upToDate',
    });
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
