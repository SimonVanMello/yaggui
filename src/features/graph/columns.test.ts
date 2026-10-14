import { describe, expect, it } from 'vitest';

import { DEFAULT_COLUMNS, clampColumn, fitColumns, parseGraphColumns } from './columns';

describe('parseGraphColumns', () => {
  it('falls back to the defaults on missing or invalid data', () => {
    expect(parseGraphColumns(null)).toEqual(DEFAULT_COLUMNS);
    expect(parseGraphColumns('not json')).toEqual(DEFAULT_COLUMNS);
    expect(parseGraphColumns('{"graph":{"columns":3}}')).toEqual(DEFAULT_COLUMNS);
  });

  it('reads widths and visibility, clamping out-of-range values', () => {
    const json = JSON.stringify({
      graph: { columns: { graph: 9999, author: 200, date: 1, hidden: { sha: true, date: 'x' } } },
    });
    const columns = parseGraphColumns(json);
    expect(columns.graph).toBe(640);
    expect(columns.author).toBe(200);
    expect(columns.date).toBe(64);
    expect(columns.sha).toBe(DEFAULT_COLUMNS.sha);
    expect(columns.hidden).toEqual({ author: false, date: false, sha: true });
  });
});

describe('clampColumn', () => {
  it('keeps widths within the limits', () => {
    expect(clampColumn('author', 10)).toBe(32);
    expect(clampColumn('sha', 1000)).toBe(160);
  });
});

describe('fitColumns', () => {
  it('gives hidden columns no width', () => {
    const columns = { ...DEFAULT_COLUMNS, hidden: { author: true, date: false, sha: false } };
    expect(fitColumns(columns, 100, 0).author).toBe(0);
  });

  it('drops side columns, date first, when the message would get too narrow', () => {
    const wide = fitColumns(DEFAULT_COLUMNS, 100, 1000);
    expect(wide).toMatchObject({ author: 140, date: 124, sha: 76 });
    const narrow = fitColumns(DEFAULT_COLUMNS, 100, 480);
    expect(narrow.date).toBe(0);
    expect(narrow.author).toBe(140);
    const tiny = fitColumns(DEFAULT_COLUMNS, 100, 300);
    expect(tiny).toMatchObject({ date: 0, author: 0 });
  });
});
