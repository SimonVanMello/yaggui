import { MAX_PHYSICAL_HEIGHT } from './geometry';

/** A physical move larger than this many viewports in one event is a jump (scrollbar drag, Home/End). */
const JUMP_VIEWPORTS = 3;
/** Distance to a physical edge under which the window is moved back to the middle. */
const EDGE_MARGIN = 1_000_000;

interface Scroller {
  scrollTop: number;
}

/**
 * Logical scroll offset (rows × row height, up to tens of millions of px) ↔ physical `scrollTop`
 * of a scroll area capped to `MAX_PHYSICAL_HEIGHT` (browsers clamp larger layouts).
 *
 * Below the cap the two are equal. Above it, `logical = offset + physical`: wheel, trackpad and
 * keyboard scroll at their native speed, and when the physical position nears an edge of the
 * capped area the window is moved back to its middle (`offset` changes, the logical position
 * does not). Jumps — dragging the scrollbar thumb, Home/End — map proportionally, so the thumb
 * still reaches any point of the history.
 */
export class ScrollMapper {
  /** Logical minus physical position. */
  offset = 0;
  private logicalHeight = 0;
  private viewportHeight = 0;
  private lastPhysical = 0;

  constructor(private readonly maxPhysical = MAX_PHYSICAL_HEIGHT) {}

  configure(logicalHeight: number, viewportHeight: number): void {
    this.logicalHeight = logicalHeight;
    this.viewportHeight = viewportHeight;
    this.offset = this.scaled
      ? Math.min(Math.max(0, this.offset), this.logicalRange - this.physicalRange)
      : 0;
  }

  get scaled(): boolean {
    return this.logicalHeight > this.maxPhysical;
  }

  /** Height to give the scrolled content element. */
  get physicalHeight(): number {
    return Math.min(this.logicalHeight, this.maxPhysical);
  }

  /** Current logical offset, as of the last `sync`. */
  get logical(): number {
    return Math.min(Math.max(0, this.offset + this.lastPhysical), this.logicalRange);
  }

  /**
   * Logical offset for the element's current `scrollTop`. Idempotent within a scroll event; may
   * move the window (writes `scrollTop`, changes `offset`).
   */
  sync(el: Scroller): number {
    const physical = el.scrollTop;
    if (!this.scaled) {
      this.offset = 0;
      this.lastPhysical = physical;
      return physical;
    }
    if (physical !== this.lastPhysical) {
      const jump = Math.abs(physical - this.lastPhysical) > JUMP_VIEWPORTS * this.viewportHeight;
      const atEdge = physical <= 0 || physical >= this.physicalRange;
      if (jump || atEdge) this.offset = this.proportional(physical) - physical;
      this.lastPhysical = physical;
      this.recenter(el);
    }
    return this.logical;
  }

  /** Scrolls so that the logical offset `target` is at the top of the viewport. */
  scrollTo(el: Scroller, target: number): void {
    const logical = Math.min(Math.max(0, target), this.logicalRange);
    if (!this.scaled) {
      this.lastPhysical = logical;
      el.scrollTop = logical;
      return;
    }
    let physical = logical - this.offset;
    const margin = this.margin;
    if (physical < margin || physical > this.physicalRange - margin) {
      physical = this.physicalRange === 0 ? 0 : (logical / this.logicalRange) * this.physicalRange;
      this.offset = logical - physical;
    }
    this.lastPhysical = physical;
    el.scrollTop = physical;
  }

  private get logicalRange(): number {
    return Math.max(0, this.logicalHeight - this.viewportHeight);
  }

  private get physicalRange(): number {
    return Math.max(0, this.physicalHeight - this.viewportHeight);
  }

  private get margin(): number {
    return Math.min(EDGE_MARGIN, this.physicalRange / 4);
  }

  private proportional(physical: number): number {
    return this.physicalRange === 0 ? 0 : (physical / this.physicalRange) * this.logicalRange;
  }

  private recenter(el: Scroller): void {
    const physical = this.lastPhysical;
    const middle = this.physicalRange / 2;
    const maxOffset = this.logicalRange - this.physicalRange;
    let shift = 0;
    if (physical < this.margin && this.offset > 0) {
      shift = -Math.min(this.offset, middle - physical);
    } else if (physical > this.physicalRange - this.margin && this.offset < maxOffset) {
      shift = Math.min(maxOffset - this.offset, physical - middle);
    }
    if (shift === 0) return;
    this.offset += shift;
    this.lastPhysical = physical - shift;
    el.scrollTop = this.lastPhysical;
  }
}
