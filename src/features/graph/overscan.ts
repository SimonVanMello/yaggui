import type { Range } from '@tanstack/react-virtual';

/**
 * Indexes to render for the visible `range`: `ahead` extra rows in the scroll direction,
 * `behind` on the other side.
 */
export function directionalRange(
  range: Range,
  forward: boolean,
  ahead: number,
  behind: number,
): number[] {
  const start = Math.max(0, range.startIndex - (forward ? behind : ahead));
  const end = Math.min(range.count - 1, range.endIndex + (forward ? ahead : behind));
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
}
