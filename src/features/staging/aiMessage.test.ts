import { describe, expect, it } from 'vitest';

import {
  canRestore,
  shouldOfferRestore,
  withGenerated,
  withRestored,
  type AiRestore,
} from './aiMessage';
import { EMPTY_DRAFT } from './commitDraft';

const previous = { summary: 'wip', description: 'notes' };
const generated = { summary: 'feat(ai): add a button', description: 'Details.' };
const restore: AiRestore = { previous, generated };

describe('generated message', () => {
  it('replaces the message and keeps amend, dropping the pre-filled marker', () => {
    const draft = { ...EMPTY_DRAFT, amend: true, ...previous, prefilled: previous };
    expect(withGenerated(draft, generated)).toEqual({
      amend: true,
      ...generated,
      prefilled: null,
    });
  });

  it('is restorable only while the draft still holds the generated text', () => {
    expect(canRestore(generated, restore)).toBe(true);
    expect(canRestore({ ...generated, summary: 'feat(ai): edited' }, restore)).toBe(false);
    expect(canRestore(generated, undefined)).toBe(false);
  });

  it('puts the previous message back', () => {
    const draft = { ...EMPTY_DRAFT, ...generated };
    expect(withRestored(draft, restore)).toMatchObject(previous);
    expect(withRestored(draft, undefined)).toBeNull();
  });

  it('offers a restore only over a message the user wrote', () => {
    expect(shouldOfferRestore(previous, generated)).toBe(true);
    expect(shouldOfferRestore({ summary: '  ', description: '' }, generated)).toBe(false);
    expect(shouldOfferRestore(generated, generated)).toBe(false);
  });
});
