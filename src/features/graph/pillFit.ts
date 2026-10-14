/**
 * Width allocation and middle truncation of the ref pills of a graph row. Pure: text widths
 * come from an injected `measure` (a cached canvas `measureText` in the app, see
 * pillMetrics.ts), so nothing here reads the layout.
 */

/** Text width in px. */
export type Measure = (text: string) => number;

/** Share of the message column always left to the commit summary. */
export const MESSAGE_MIN_SHARE = 0.4;
/** Floor of that reserve on narrow columns, in `ch` of the summary font (a short summary). */
export const MESSAGE_MIN_CH = 10;
/** A name is never truncated below this many `ch` of the pill font; pills fold into `+N`. */
export const NAME_MIN_CH = 8;
/** The leading segment (`feature/`) is kept when it leaves room for this many end characters. */
const LEAD_MIN_TAIL = 3;
/** A name without leading segment keeps this share of the budget from its start. */
const START_SHARE = 1 / 3;

const ELLIPSIS = '…';
const WORD_SEPARATORS = new Set(['/', '-', '_']);

let segmenter: Intl.Segmenter | null | undefined;

/** User-perceived characters, so a cut never splits an emoji or a combining sequence. */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
  }
  if (segmenter === null) return Array.from(text);
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/** Longest `n` in [0, max] with `fits(n)`, `fits` being monotonic (true then false). */
function longest(max: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const isSeparator = (char: string | undefined) => char !== undefined && WORD_SEPARATORS.has(char);

/**
 * Kept end starting mid-word: moved to the next boundary when one is close (`ase/2.4` →
 * `/2.4`, `n-timeout` → `timeout`), a whole word reads better than a cut one.
 */
function snapTail(tail: string[], cutMidWord: boolean): string[] {
  if (!cutMidWord) return tail[0] === '/' || !isSeparator(tail[0]) ? tail : tail.slice(1);
  const limit = Math.floor(tail.length / 2);
  for (let i = 0; i <= limit; i++) {
    const char = tail[i];
    if (!isSeparator(char)) continue;
    const start = char === '/' ? i : i + 1;
    return start < tail.length ? tail.slice(start) : tail;
  }
  return tail;
}

/** Kept start ending mid-word: moved back to the previous boundary when one is close. */
function snapStart(start: string[], cutMidWord: boolean): string[] {
  if (!cutMidWord) return start;
  for (let i = start.length - 1; i >= Math.ceil(start.length / 2); i--) {
    if (isSeparator(start[i])) return start.slice(0, i + 1);
  }
  return start;
}

/**
 * Fits `name` in `budget` px by cutting its middle: the leading segment (`feature/`,
 * `origin/`) and the end, usually the distinctive part, stay.
 * `feature/PROJ-1234-login-timeout` → `feature/…login-timeout`, `origin/release/2.4` →
 * `origin/…/2.4`. A name without slash keeps a start and the end (`PROJ-…slow-networks`).
 * Returns `name` unchanged when it fits.
 */
export function truncateMiddle(name: string, budget: number, measure: Measure): string {
  if (measure(name) <= budget) return name;
  const chars = graphemes(name);
  if (chars.length <= 1) return name;
  const text = (parts: string[]) => parts.join('');
  const end = (k: number) => (k > 0 ? chars.slice(chars.length - k) : []);

  let lead: string[] = [];
  const slash = chars.indexOf('/');
  if (slash > 0 && slash < chars.length - 1) {
    const segment = chars.slice(0, slash + 1);
    const minTail = Math.min(LEAD_MIN_TAIL, chars.length - segment.length);
    // A leading segment too long for the budget is dropped: the end alone tells more.
    if (measure(text(segment) + ELLIPSIS + text(end(minTail))) <= budget) lead = segment;
  } else {
    const startBudget = budget * START_SHARE;
    const n = longest(chars.length - 1, (k) => measure(text(chars.slice(0, k))) <= startBudget);
    lead = snapStart(chars.slice(0, n), n > 0 && !isSeparator(chars[n]));
  }

  const head = text(lead) + ELLIPSIS;
  const room = chars.length - lead.length;
  const k = longest(room, (n) => measure(head + text(end(n))) <= budget);
  if (k === 0) return head;
  const tail = snapTail(end(k), !isSeparator(chars[chars.length - k - 1]));
  return head + text(tail);
}

/** One pill to lay out. */
export interface PillInput {
  name: string;
  /** Width of the name in full, px. */
  natural: number;
  /** Everything but the name: padding, border, icons and their gaps, px. */
  chrome: number;
}

export interface PillFitOptions {
  /** Width the pills may take, chip included, px. */
  available: number;
  /** Gap between two pills, px. */
  gap: number;
  /** Floor of a truncated name, px (shorter names stay whole). */
  minName: number;
  /** Width of the `+N` chip for `count` hidden refs, px. */
  moreChip: (count: number) => number;
}

export interface PillFit {
  /** How many pills are shown, from the start; the others fold into `+N`. */
  shown: number;
  /** Width budget of each shown name, px (`>= natural`: shown in full). */
  budgets: number[];
}

/**
 * Width the pills get in a message column of `width` px: the summary keeps
 * `MESSAGE_MIN_SHARE` of it, and at least `MESSAGE_MIN_CH` ch, or just its own width
 * (`summary`, px) when shorter. `extras`: other fixed items of the column (signature mark, gaps).
 */
export function pillArea(
  width: number,
  messageCh: number,
  extras: number,
  summary = Infinity,
): number {
  const reserve = Math.min(
    summary,
    Math.max(width * MESSAGE_MIN_SHARE, MESSAGE_MIN_CH * messageCh),
  );
  return Math.max(0, width - reserve - extras);
}

/** Largest cap `L` such that the names, each `clamp(natural, min, L)`, fit in `budget`. */
function waterLevel(natural: readonly number[], min: readonly number[], budget: number): number {
  const total = (level: number) =>
    natural.reduce((sum, n, i) => sum + Math.max(min[i] ?? 0, Math.min(n, level)), 0);
  let lo = 0;
  let hi = Math.max(0, ...natural);
  for (let i = 0; i < 24 && hi - lo > 0.25; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Lays out the pills of a row: as many as fit with names of at least `minName` (the rest
 * fold into `+N`), then the room left is shared so that the longest names shrink first.
 */
export function fitPills(pills: readonly PillInput[], options: PillFitOptions): PillFit {
  const { available, gap, minName, moreChip } = options;
  const total = pills.length;
  const mins = pills.map((p) => Math.min(p.natural, minName));

  const fixedWidth = (shown: number, nameWidths: readonly number[]) => {
    let width = 0;
    for (let i = 0; i < shown; i++) {
      width += (pills[i] as PillInput).chrome + (nameWidths[i] ?? 0) + (i > 0 ? gap : 0);
    }
    if (shown < total) width += moreChip(total - shown) + (shown > 0 ? gap : 0);
    return width;
  };

  let shown = total;
  while (shown > 0 && fixedWidth(shown, mins) > available) shown--;
  if (shown === 0) {
    // A `+1` chip would say less than the lone pill itself, even cut below the minimum.
    const lone = total === 1 ? pills[0] : undefined;
    if (lone) return { shown: 1, budgets: [Math.max(0, available - lone.chrome)] };
    return { shown: 0, budgets: [] };
  }

  const natural = pills.slice(0, shown).map((p) => p.natural);
  const min = mins.slice(0, shown);
  const names = available - fixedWidth(shown, new Array<number>(shown).fill(0));
  if (natural.reduce((a, b) => a + b, 0) <= names) return { shown, budgets: natural };
  const level = waterLevel(natural, min, names);
  return {
    shown,
    budgets: natural.map((n, i) => Math.max(min[i] ?? 0, Math.min(n, level))),
  };
}
