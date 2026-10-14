import { describe, expect, it } from 'vitest';

import { ScrollMapper } from './scrollMapper';

const MAX = 10_000_000;
const VIEWPORT = 600;
const LINUX = 1_300_000 * 28;

function setup(logical: number) {
  const mapper = new ScrollMapper(MAX);
  mapper.configure(logical, VIEWPORT);
  const el = { scrollTop: 0 };
  /** Scrolls physically by `delta` (as the browser would), then syncs. */
  const scrollBy = (delta: number) => {
    el.scrollTop = Math.min(Math.max(0, el.scrollTop + delta), mapper.physicalHeight - VIEWPORT);
    return mapper.sync(el);
  };
  return { mapper, el, scrollBy };
}

describe('ScrollMapper', () => {
  it('is the identity below the cap', () => {
    const { mapper, el, scrollBy } = setup(2_800_000);
    expect(mapper.scaled).toBe(false);
    expect(mapper.physicalHeight).toBe(2_800_000);
    expect(scrollBy(1234)).toBe(1234);
    mapper.scrollTo(el, 50_000);
    expect(el.scrollTop).toBe(50_000);
    expect(mapper.sync(el)).toBe(50_000);
  });

  it('scrolls 1:1 on small moves above the cap', () => {
    const { mapper, el, scrollBy } = setup(LINUX);
    expect(mapper.scaled).toBe(true);
    expect(mapper.physicalHeight).toBe(MAX);
    mapper.scrollTo(el, 20_000_000);
    const start = mapper.sync(el);
    expect(start).toBeCloseTo(20_000_000, 3);
    expect(scrollBy(100)).toBeCloseTo(start + 100, 3);
    expect(scrollBy(-250)).toBeCloseTo(start - 150, 3);
  });

  it('moves the window back to the middle near an edge, without moving the logical position', () => {
    const { mapper, el, scrollBy } = setup(LINUX);
    mapper.scrollTo(el, 20_000_000);
    let logical = mapper.sync(el);
    // Wheel down long enough to reach the bottom margin of the physical area.
    let recentered = 0;
    while (logical < LINUX - VIEWPORT - 1000) {
      const before = el.scrollTop;
      const next = scrollBy(1000);
      if (el.scrollTop < before) recentered++;
      expect(next).toBeCloseTo(logical + 1000, 3);
      logical = next;
    }
    expect(recentered).toBeGreaterThan(0);
    expect(el.scrollTop).toBeLessThanOrEqual(MAX - VIEWPORT);
    // The whole history is reachable by wheel, up to its very end.
    for (let i = 0; i < 100; i++) scrollBy(100);
    expect(mapper.sync(el)).toBeCloseTo(LINUX - VIEWPORT, 3);
  });

  it('maps jumps proportionally, so the thumb reaches every point', () => {
    const { mapper, el, scrollBy } = setup(LINUX);
    scrollBy((MAX - VIEWPORT) / 2);
    expect(mapper.sync(el)).toBeCloseTo((LINUX - VIEWPORT) / 2, 0);
    el.scrollTop = MAX - VIEWPORT;
    expect(mapper.sync(el)).toBeCloseTo(LINUX - VIEWPORT, 3);
    el.scrollTop = 0;
    expect(mapper.sync(el)).toBe(0);
  });

  it('scrolls to far targets proportionally and near ones 1:1', () => {
    const { mapper, el } = setup(LINUX);
    mapper.scrollTo(el, LINUX - VIEWPORT);
    expect(el.scrollTop).toBeCloseTo(MAX - VIEWPORT, 3);
    expect(mapper.sync(el)).toBeCloseTo(LINUX - VIEWPORT, 3);
    mapper.scrollTo(el, 30_000_000);
    const physical = el.scrollTop;
    mapper.scrollTo(el, 30_000_280);
    expect(el.scrollTop).toBeCloseTo(physical + 280, 3);
    expect(mapper.sync(el)).toBeCloseTo(30_000_280, 3);
  });
});
