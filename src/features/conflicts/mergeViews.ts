import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { highlighter, languages, styleNonce } from '../diff/editor';
import {
  buildResult,
  conflictLines,
  isResolved,
  toggleChoice,
  type ConflictChoice,
  type ConflictState,
  type MergeModel,
  type Side,
} from './mergeModel';

export interface MergeEditorLabels {
  /** Title of conflict `n` (1-based) in the side panels. */
  conflict: (n: number) => string;
  /** Accessible name of the checkbox of conflict `n` on a side. */
  take: (n: number, side: Side) => string;
  /** Shown in the result where a conflict has no content chosen yet. */
  unresolved: string;
  /** Accessible names of the three code areas. */
  ours: string;
  theirs: string;
  result: string;
}

export interface MergeEditorConfig {
  model: MergeModel;
  parents: Record<Side | 'result', HTMLElement>;
  labels: MergeEditorLabels;
  /** Each change of a conflict's choice or edited state. */
  onChange: (conflicts: readonly ConflictState[]) => void;
}

export interface MergeEditors {
  views: Record<Side | 'result', EditorView>;
  toggle: (conflict: number, side: Side) => void;
  choose: (conflict: number, choice: ConflictChoice) => void;
  /** Scrolls the three panels to a conflict and outlines it. */
  reveal: (conflict: number) => void;
  /** The result as edited, with `\n` line breaks. */
  text: () => string;
  highlight: (path: string) => Promise<void>;
  destroy: () => void;
}

/** Position of the start of line index `line` (0-based), the end of the document past it. */
function linePos(doc: Text, line: number): number {
  return line < doc.lines ? doc.line(line + 1).from : doc.length;
}

/** Block widget position and side: above a line start, below the last line otherwise. */
function blockAt(doc: Text, line: number): { pos: number; side: -1 | 1 } {
  const pos = linePos(doc, line);
  return { pos, side: doc.lineAt(pos).from === pos ? -1 : 1 };
}

// --- Side panels ---------------------------------------------------------------------------

class ConflictHeader extends WidgetType {
  constructor(
    readonly index: number,
    readonly side: Side,
    readonly choice: ConflictChoice,
    readonly current: boolean,
    readonly labels: MergeEditorLabels,
    readonly onToggle: (index: number, side: Side) => void,
  ) {
    super();
  }

  override eq(other: ConflictHeader): boolean {
    return (
      other.index === this.index &&
      other.side === this.side &&
      other.current === this.current &&
      other.choice.join() === this.choice.join()
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement('label');
    el.className = 'yaggui-merge-header';
    el.dataset['conflict'] = String(this.index);
    if (this.current) el.dataset['current'] = 'true';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const order = this.choice.indexOf(this.side);
    box.checked = order >= 0;
    box.setAttribute('aria-label', this.labels.take(this.index + 1, this.side));
    box.addEventListener('change', () => {
      this.onToggle(this.index, this.side);
    });
    const title = document.createElement('span');
    title.textContent = this.labels.conflict(this.index + 1);
    el.append(box, title);
    // Both sides kept: the badge tells which comes first.
    if (order >= 0 && this.choice.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'yaggui-merge-order';
      badge.textContent = String(order + 1);
      el.append(badge);
    }
    return el;
  }

  override get estimatedHeight(): number {
    return 26;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Per-line class index of a side: 0 none, 1 changed on this side (merged), 2 conflict. */
function lineKinds(model: MergeModel, side: Side): Uint8Array {
  const kinds = new Uint8Array(model[side].length + 1);
  for (const chunk of model.chunks) {
    const value =
      chunk.kind === 'conflict' ? 2 : chunk.kind === side || chunk.kind === 'both' ? 1 : 0;
    if (value === 0) continue;
    kinds.fill(value, chunk[side].start, chunk[side].end);
  }
  return kinds;
}

const LINE_CLASS = [
  null,
  Decoration.line({ class: 'yaggui-merge-change' }),
  Decoration.line({ class: 'yaggui-merge-conflict' }),
];

/** Line backgrounds of the visible lines only (5,000-line files stay fast). */
function sideLines(kinds: Uint8Array): Extension {
  const build = (view: EditorView): DecorationSet => {
    const ranges = [];
    const { doc } = view.state;
    for (const { from, to } of view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const deco = LINE_CLASS[kinds[n - 1] ?? 0];
        if (deco) ranges.push(deco.range(doc.line(n).from));
      }
    }
    return Decoration.set(ranges);
  };
  return ViewPlugin.define(
    (view) => ({
      decorations: build(view),
      update(update: ViewUpdate) {
        if (update.viewportChanged) this.decorations = build(update.view);
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  );
}

/** Choices and current conflict, pushed to the side panels to redraw their headers. */
const setHeaders = StateEffect.define<{ choices: ConflictChoice[]; current: number | null }>();

function sideHeaders(
  model: MergeModel,
  side: Side,
  labels: MergeEditorLabels,
  onToggle: (index: number, side: Side) => void,
): Extension {
  const build = (doc: Text, choices: readonly ConflictChoice[], current: number | null) =>
    Decoration.set(
      model.conflicts.map((chunkIndex, index) => {
        const chunk = model.chunks[chunkIndex];
        const { pos, side: at } = blockAt(doc, chunk ? chunk[side].start : 0);
        return Decoration.widget({
          widget: new ConflictHeader(
            index,
            side,
            choices[index] ?? [],
            index === current,
            labels,
            onToggle,
          ),
          block: true,
          side: at,
        }).range(pos);
      }),
      true,
    );
  return StateField.define<DecorationSet>({
    create: (state) => build(state.doc, [], null),
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setHeaders))
          return build(tr.state.doc, effect.value.choices, effect.value.current);
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

// --- Result --------------------------------------------------------------------------------

interface Region extends ConflictState {
  from: number;
  to: number;
}

const setChoice = StateEffect.define<{ index: number; choice: ConflictChoice }>();
const setCurrent = StateEffect.define<number | null>();

/** Whether a change of the old document `[fromA, toA)` touches a region (inserting inside counts). */
function touches(region: Region, fromA: number, toA: number): boolean {
  if (fromA === toA) {
    return region.from === region.to
      ? fromA === region.from
      : fromA >= region.from && fromA < region.to;
  }
  return fromA < Math.max(region.to, region.from + 1) && toA > region.from;
}

function mapRegions(regions: readonly Region[], tr: Transaction): Region[] {
  const own = tr.effects.some((e) => e.is(setChoice));
  return regions.map((region) => {
    const empty = region.from === region.to;
    // An empty region grows with what is typed in it; a filled one keeps text typed at its end out.
    const from = tr.changes.mapPos(region.from, -1);
    const to = tr.changes.mapPos(region.to, empty ? 1 : -1);
    let edited = region.edited;
    if (!own && !edited) {
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (touches(region, fromA, toA)) edited = true;
      });
    }
    return { ...region, from, to: Math.max(from, to), edited };
  });
}

class Unresolved extends WidgetType {
  constructor(
    readonly label: string,
    readonly current: boolean,
  ) {
    super();
  }

  override eq(other: Unresolved): boolean {
    return other.label === this.label && other.current === this.current;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'yaggui-merge-unresolved';
    if (this.current) el.dataset['current'] = 'true';
    el.textContent = this.label;
    return el;
  }

  override get estimatedHeight(): number {
    return 24;
  }
}

const RESOLVED_LINE = Decoration.line({ class: 'yaggui-merge-resolved' });
const CURRENT_LINE = Decoration.line({ class: 'yaggui-merge-resolved yaggui-merge-current' });

export function createMergeEditors(config: MergeEditorConfig): MergeEditors {
  const { model, parents, labels, onChange } = config;
  const nonce = styleNonce();
  const language = new Compartment();
  const base = (label: string, editable: boolean): Extension[] => [
    nonce === null ? [] : EditorView.cspNonce.of(nonce),
    EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' }),
    lineNumbers(),
    editable ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
    language.of([]),
    syntaxHighlighting(highlighter),
  ];

  let current: number | null = null;
  const views = {} as Record<Side | 'result', EditorView>;
  /** Replaces a conflict's content in the result with `choice`. */
  const choose = (index: number, choice: ConflictChoice) => {
    const view = views.result;
    const region = view.state.field(regions)[index];
    const chunk = model.chunks[model.conflicts[index] ?? -1];
    if (!region || !chunk) return;
    current = index;
    view.dispatch({
      changes: {
        from: region.from,
        to: region.to,
        insert: conflictLines(model, chunk, choice).join(''),
      },
      effects: [setChoice.of({ index, choice }), setCurrent.of(index)],
      userEvent: 'input.merge',
    });
  };
  const toggle = (index: number, side: Side) => {
    const region = views.result.state.field(regions)[index];
    if (region) choose(index, toggleChoice(region.edited ? [] : region.choice, side));
  };

  const sides = (['ours', 'theirs'] as const).map((side) => {
    const view = new EditorView({
      parent: parents[side],
      state: EditorState.create({
        doc: model[side].join(''),
        extensions: [
          base(labels[side], false),
          sideLines(lineKinds(model, side)),
          sideHeaders(model, side, labels, toggle),
        ],
      }),
    });
    views[side] = view;
    return view;
  });

  const initial = buildResult(model, []);
  const regions = StateField.define<Region[]>({
    create(state) {
      return initial.regions.map((r) => ({
        from: linePos(state.doc, r.line),
        to: linePos(state.doc, r.line + r.count),
        choice: [],
        edited: false,
      }));
    },
    update(value, tr) {
      let next = tr.docChanged ? mapRegions(value, tr) : value;
      for (const effect of tr.effects) {
        if (!effect.is(setChoice)) continue;
        next = next === value ? [...value] : next;
        const region = next[effect.value.index];
        if (region)
          next[effect.value.index] = { ...region, choice: effect.value.choice, edited: false };
      }
      return next;
    },
  });
  const currentField = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setCurrent)) return effect.value;
      return value;
    },
  });
  const resultDecorations = EditorView.decorations.compute(
    [regions, currentField, 'doc'],
    (state) => {
      const ranges = [];
      const active = state.field(currentField);
      for (const [index, region] of state.field(regions).entries()) {
        if (region.from === region.to) {
          if (isResolved(region)) continue;
          ranges.push(
            Decoration.widget({
              widget: new Unresolved(labels.unresolved, index === active),
              block: true,
              side: state.doc.lineAt(region.from).from === region.from ? -1 : 1,
            }).range(region.from),
          );
          continue;
        }
        const deco = index === active ? CURRENT_LINE : RESOLVED_LINE;
        const last = state.doc.lineAt(Math.max(region.from, region.to - 1)).number;
        for (let n = state.doc.lineAt(region.from).number; n <= last; n++) {
          ranges.push(deco.range(state.doc.line(n).from));
        }
      }
      return Decoration.set(ranges, true);
    },
  );

  const publish = (state: EditorState) => {
    const list = state.field(regions);
    onChange(list.map(({ choice, edited }) => ({ choice, edited })));
    const choices = list.map((r) => (r.edited ? [] : [...r.choice]));
    for (const view of sides) {
      view.dispatch({ effects: setHeaders.of({ choices, current }) });
    }
  };

  // Alt+↑ / Alt+↓ move between conflicts (handled by the view), not lines.
  const editKeys = defaultKeymap.filter(
    (b) => b.key !== 'Alt-ArrowUp' && b.key !== 'Alt-ArrowDown',
  );
  views.result = new EditorView({
    parent: parents.result,
    state: EditorState.create({
      doc: initial.text,
      extensions: [
        base(labels.result, true),
        history(),
        keymap.of([...editKeys, ...historyKeymap, indentWithTab]),
        regions,
        currentField,
        resultDecorations,
        EditorView.updateListener.of((update) => {
          const before = update.startState.field(regions);
          const after = update.state.field(regions);
          const changed =
            before !== after &&
            after.some((r, i) => {
              const old = before.at(i);
              return !old || r.edited !== old.edited || r.choice !== old.choice;
            });
          if (changed) publish(update.state);
        }),
      ],
    }),
  });

  const lifecycle = { destroyed: false };
  const destroyed = () => lifecycle.destroyed;
  return {
    views,
    toggle,
    choose,
    reveal(index) {
      const chunk = model.chunks[model.conflicts[index] ?? -1];
      const region = views.result.state.field(regions)[index];
      if (!chunk || !region) return;
      current = index;
      for (const [side, view] of [
        ['ours', views.ours],
        ['theirs', views.theirs],
      ] as const) {
        view.dispatch({
          effects: EditorView.scrollIntoView(linePos(view.state.doc, chunk[side].start), {
            y: 'start',
            yMargin: 48,
          }),
        });
      }
      views.result.dispatch({
        effects: [
          setCurrent.of(index),
          EditorView.scrollIntoView(region.from, { y: 'start', yMargin: 48 }),
        ],
        selection: { anchor: region.from },
      });
      publish(views.result.state);
    },
    text: () => views.result.state.doc.toString(),
    async highlight(path) {
      const description = LanguageDescription.matchFilename(await languages(), path);
      if (!description || destroyed()) return;
      const support = await description.load();
      if (destroyed()) return;
      for (const view of Object.values(views)) {
        view.dispatch({ effects: language.reconfigure(support) });
      }
    },
    destroy() {
      lifecycle.destroyed = true;
      for (const view of Object.values(views)) view.destroy();
    },
  };
}
