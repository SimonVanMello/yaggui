/** A run of the edit script: `a[aStart, aEnd)` replaced by `b[bStart, bEnd)` (one side may be empty). */
export interface Edit {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Myers O(ND) diff of two sequences, returning only the changed runs, in order.
 * Common prefix and suffix are trimmed first; above `maxCost` edits the middle is reported
 * as one replacement instead of searching further (bounded time on unrelated inputs).
 */
export function myers<T>(a: readonly T[], b: readonly T[], maxCost = 2_000): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const n = aEnd - start;
  const m = bEnd - start;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ aStart: start, aEnd, bStart: start, bEnd }];

  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [{ aStart: start, aEnd, bStart: start, bEnd }];

  // Walk the trace back, collecting single-element moves, then merge adjacent ones.
  const moves: { x: number; y: number; del: boolean }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d] ?? v;
    const k = x - y;
    const down = k === -d || (k !== d && (prev[offset + k - 1] ?? 0) < (prev[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    moves.push(down ? { x: prevX, y: prevY, del: false } : { x: prevX, y: prevY, del: true });
    x = prevX;
    y = prevY;
  }
  moves.reverse();

  const edits: Edit[] = [];
  for (const move of moves) {
    const aPos = start + move.x;
    const bPos = start + move.y;
    const last = edits.at(-1);
    const edit = move.del
      ? { aStart: aPos, aEnd: aPos + 1, bStart: bPos, bEnd: bPos }
      : { aStart: aPos, aEnd: aPos, bStart: bPos, bEnd: bPos + 1 };
    if (last && last.aEnd === edit.aStart && last.bEnd === edit.bStart) {
      last.aEnd = edit.aEnd;
      last.bEnd = edit.bEnd;
    } else {
      edits.push(edit);
    }
  }
  return edits;
}
