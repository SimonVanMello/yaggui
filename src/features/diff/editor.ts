import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  type BlockInfo,
  type ViewUpdate,
  type DecorationSet,
} from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';

import type { DiffLine, HunkView } from './diffModel';
import { NO_SPACERS, setSpacers, spacerExtension } from './heightSync';

/** Which numbers the gutter shows: both (unified) or one side (split columns). */
export type EditorSide = 'unified' | 'old' | 'new';

export type HunkActionKind = 'stage' | 'unstage' | 'discard';

export interface HunkActionDef {
  kind: HunkActionKind;
  label: string;
  /** Why the action is unavailable (shown as its tooltip); `undefined` when it is enabled. */
  disabled?: string;
}

export interface EditorLabels {
  noNewline: string;
  /** Hunk actions, shown on index / working tree diffs. */
  hunkActions: HunkActionDef[] | null;
}

/** Modifiers held on a gutter press, to extend or toggle the line selection. */
export interface PressModifiers {
  shift: boolean;
  toggle: boolean;
}

export interface DiffEditorConfig {
  parent: HTMLElement;
  lines: DiffLine[];
  hunks: HunkView[];
  side: EditorSide;
  labels: EditorLabels;
  /** Accessible name of the code area. */
  label: string;
  /** Called with the hunk index when a hunk action button is pressed. */
  onHunkAction?: (kind: HunkActionKind, hunk: number) => void;
  /**
   * Rows (line indexes) a gutter press can select; `undefined` for diffs without line
   * selection (commits).
   */
  selectable?: ReadonlySet<number>;
  /** Gutter press on `row`, then `onRowDrag` while the pointer moves with the button down. */
  onRowPress?: (row: number, modifiers: PressModifiers) => void;
  onRowDrag?: (row: number) => void;
  /** Soft-wrap long lines. */
  wrap?: boolean;
  /**
   * Keys pressed in the code area; return `true` when handled (the browser default, such as
   * scrolling, is then skipped).
   */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** The size or viewport of the editor may have changed (row heights to re-sync). */
  onGeometry?: () => void;
}

class HunkHeader extends WidgetType {
  constructor(
    readonly title: string,
    readonly index: number,
    readonly actions: HunkActionDef[] | null,
    readonly onAction: ((kind: HunkActionKind, hunk: number) => void) | undefined,
  ) {
    super();
  }

  override eq(other: HunkHeader): boolean {
    const key = (w: HunkHeader) =>
      (w.actions ?? []).map((a) => `${a.kind}:${a.label}:${a.disabled ?? ''}`).join('|');
    return other.title === this.title && other.index === this.index && key(other) === key(this);
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'yaggui-hunk';
    const title = document.createElement('span');
    title.className = 'yaggui-hunk-title';
    title.textContent = this.title;
    el.append(title);
    if (this.actions) {
      const acts = document.createElement('span');
      acts.className = 'yaggui-hunk-actions';
      for (const action of this.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.dataset['action'] = action.kind;
        if (action.disabled) {
          button.title = action.disabled;
          button.setAttribute('aria-disabled', 'true');
        }
        button.addEventListener('click', () => {
          if (!action.disabled) this.onAction?.(action.kind, this.index);
        });
        acts.append(button);
      }
      el.append(acts);
    }
    return el;
  }

  override get estimatedHeight(): number {
    return 28;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class NoNewline extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  override eq(other: NoNewline): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'yaggui-no-newline';
    el.textContent = '⏎̸';
    el.title = this.label;
    el.setAttribute('aria-label', this.label);
    return el;
  }
}

class NumberMarker extends GutterMarker {
  constructor(
    readonly text: string,
    override readonly elementClass: string,
  ) {
    super();
  }

  override eq(other: NumberMarker): boolean {
    return other.text === this.text && other.elementClass === this.elementClass;
  }

  override toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

/** Token classes styled by CodeDiff.module.css with the theme's syntax tokens. */
export const highlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
    class: 'tok-keyword',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character],
    class: 'tok-string',
  },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], class: 'tok-type' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.number,
      tags.bool,
      tags.atom,
    ],
    class: 'tok-function',
  },
  { tag: [tags.comment, tags.meta], class: 'tok-comment' },
  { tag: [tags.heading, tags.strong], class: 'tok-strong' },
  { tag: tags.invalid, class: 'tok-invalid' },
]);

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: '', empty: '' };

const LINE_DECORATION = {
  add: Decoration.line({ class: 'yaggui-add' }),
  del: Decoration.line({ class: 'yaggui-del' }),
  empty: Decoration.line({ class: 'yaggui-empty' }),
};
const WORD_MARK = Decoration.mark({ class: 'yaggui-word' });

/**
 * Line backgrounds and word highlights of the visible lines only: built on each viewport
 * change instead of for the whole file, so opening a long diff stays fast (P-06).
 */
function lineDecorations(config: DiffEditorConfig): Extension {
  const build = (view: EditorView): DecorationSet => {
    const ranges = [];
    const { doc } = view.state;
    for (const { from, to } of view.visibleRanges) {
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(to).number;
      for (let number = first; number <= last; number++) {
        const line = config.lines[number - 1];
        if (!line) continue;
        const docLine = doc.line(number);
        if (line.kind !== 'context') ranges.push(LINE_DECORATION[line.kind].range(docLine.from));
        for (const m of line.marks) {
          if (m.to > m.from)
            ranges.push(WORD_MARK.range(docLine.from + m.from, docLine.from + m.to));
        }
        if (line.noNewline) {
          ranges.push(
            Decoration.widget({ widget: new NoNewline(config.labels.noNewline), side: 1 }).range(
              docLine.to,
            ),
          );
        }
      }
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.define(
    (view) => ({
      decorations: build(view),
      update(update: ViewUpdate) {
        if (update.viewportChanged || update.docChanged) this.decorations = build(update.view);
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  );
}

/** Hunk headers change line heights: they must come from the state, not a view plugin. */
function hunkHeaders(config: DiffEditorConfig, doc: EditorState['doc']): DecorationSet {
  return Decoration.set(
    config.hunks.map((hunk, index) =>
      Decoration.widget({
        widget: new HunkHeader(hunk.title, index, config.labels.hunkActions, config.onHunkAction),
        block: true,
        side: -1,
      }).range(doc.line(hunk.firstLine + 1).from),
    ),
    true,
  );
}

/** Line index of the change the user navigated to, outlined in the gutter. */
export const setCurrentLine = StateEffect.define<number | null>();

const currentLine = StateField.define<number | null>({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setCurrentLine)) return effect.value;
    return value;
  },
});

const currentDecoration = EditorView.decorations.compute([currentLine], (state) => {
  const index = state.field(currentLine);
  if (index === null || index >= state.doc.lines) return Decoration.none;
  return Decoration.set([
    Decoration.line({ class: 'yaggui-current' }).range(state.doc.line(index + 1).from),
  ]);
});

/** Rows (line indexes) selected for a stage / unstage / discard of lines. */
export const setSelectedRows = StateEffect.define<ReadonlySet<number>>();

const selectedRows = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setSelectedRows)) return effect.value;
    return value;
  },
});

const selectedDecoration = EditorView.decorations.compute([selectedRows], (state) => {
  const rows = state.field(selectedRows);
  if (rows.size === 0) return Decoration.none;
  const ranges = [...rows]
    .filter((row) => row < state.doc.lines)
    .sort((a, b) => a - b)
    .map((row) =>
      Decoration.line({ class: 'yaggui-selected' }).range(state.doc.line(row + 1).from),
    );
  return Decoration.set(ranges);
});

/** Row under the keyboard cursor (changed rows only), outlined apart from the selection. */
export const setCursorRow = StateEffect.define<number | null>();

const cursorRow = StateField.define<number | null>({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setCursorRow)) return effect.value;
    return value;
  },
});

const cursorDecoration = EditorView.decorations.compute([cursorRow], (state) => {
  const row = state.field(cursorRow);
  if (row === null || row >= state.doc.lines) return Decoration.none;
  return Decoration.set([
    Decoration.line({ class: 'yaggui-cursor' }).range(state.doc.line(row + 1).from),
  ]);
});

/** Press in a gutter: starts a selection and follows the pointer until the button is released. */
type GutterHandlers = Record<string, (view: EditorView, block: BlockInfo, event: Event) => boolean>;

function selectionHandlers(config: DiffEditorConfig): GutterHandlers {
  const { selectable, onRowPress, onRowDrag } = config;
  if (!selectable || !onRowPress) return {};
  return {
    mousedown(view, block, event) {
      if (!(event instanceof MouseEvent) || event.button !== 0) return false;
      const rowAt = (y: number) => {
        const top = view.lineBlockAtHeight(y - view.documentTop);
        return view.state.doc.lineAt(top.from).number - 1;
      };
      const row = view.state.doc.lineAt(block.from).number - 1;
      if (!selectable.has(row)) return false;
      onRowPress(row, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
      // The press is prevented (no text selection): focus is moved by hand, for the keys.
      view.contentDOM.focus({ preventScroll: true });
      const move = (e: MouseEvent) => {
        onRowDrag?.(rowAt(e.clientY));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      event.preventDefault();
      return true;
    },
  };
}

function gutterClass(
  state: EditorState,
  line: DiffLine,
  row: number,
  selectable: ReadonlySet<number> | undefined,
): string {
  const classes = [`yaggui-gutter-${line.kind}`];
  if (selectable?.has(row)) classes.push('yaggui-selectable');
  if (state.field(selectedRows).has(row)) classes.push('yaggui-gutter-selected');
  if (state.field(cursorRow) === row) classes.push('yaggui-gutter-cursor');
  return classes.join(' ');
}

function numberGutter(
  config: DiffEditorConfig,
  which: 'old' | 'new',
  className: string,
): Extension {
  const { lines } = config;
  const width = String(
    lines.reduce((max, l) => Math.max(max, (which === 'old' ? l.oldNo : l.newNo) ?? 0), 0),
  ).replace(/./g, '0');
  return gutter({
    class: className,
    lineMarker(view, block) {
      const row = view.state.doc.lineAt(block.from).number - 1;
      const line = lines[row];
      if (!line) return null;
      const no = which === 'old' ? line.oldNo : line.newNo;
      return new NumberMarker(
        no === null ? '' : String(no),
        gutterClass(view.state, line, row, config.selectable),
      );
    },
    lineMarkerChange: (update) =>
      update.startState.field(selectedRows) !== update.state.field(selectedRows) ||
      update.startState.field(cursorRow) !== update.state.field(cursorRow),
    initialSpacer: () => new NumberMarker(width, ''),
    domEventHandlers: selectionHandlers(config),
  });
}

function signGutter(config: DiffEditorConfig): Extension {
  const { lines } = config;
  return gutter({
    class: 'yaggui-signs',
    lineMarker(view, block) {
      const row = view.state.doc.lineAt(block.from).number - 1;
      const line = lines[row];
      if (!line) return null;
      return new NumberMarker(
        SIGN[line.kind],
        gutterClass(view.state, line, row, config.selectable),
      );
    },
    lineMarkerChange: (update) =>
      update.startState.field(selectedRows) !== update.state.field(selectedRows) ||
      update.startState.field(cursorRow) !== update.state.field(cursorRow),
    initialSpacer: () => new NumberMarker('+', ''),
    domEventHandlers: selectionHandlers(config),
  });
}

export interface DiffEditor {
  view: EditorView;
  /** Loads the language of `path` (lazily, cached by CodeMirror) and highlights with it. */
  highlight: (path: string) => Promise<void>;
  setWrap: (wrap: boolean) => void;
  destroy: () => void;
}

let languageData: Promise<readonly LanguageDescription[]> | null = null;

/** The language list itself is loaded on first use, each language on demand. */
export function languages(): Promise<readonly LanguageDescription[]> {
  languageData ??= import('@codemirror/language-data').then((m) => m.languages);
  return languageData;
}

/**
 * Outside `tauri dev`, Tauri adds nonces to the CSP, which makes the webview ignore
 * 'unsafe-inline': the <style> tags CodeMirror injects need the page's style nonce.
 */
export function styleNonce(): string | null {
  return document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce || null;
}

export function createDiffEditor(config: DiffEditorConfig): DiffEditor {
  const text = config.lines.map((line) => line.text).join('\n');
  const language = new Compartment();
  const wrapping = new Compartment();
  const gutters =
    config.side === 'unified'
      ? [
          numberGutter(config, 'old', 'yaggui-numbers'),
          numberGutter(config, 'new', 'yaggui-numbers'),
        ]
      : [numberGutter(config, config.side, 'yaggui-numbers')];
  const nonce = styleNonce();
  const state = EditorState.create({
    doc: text,
    extensions: [
      nonce === null ? [] : EditorView.cspNonce.of(nonce),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': config.label, tabindex: '0' }),
      ...gutters,
      selectedRows,
      selectedDecoration,
      cursorRow,
      cursorDecoration,
      wrapping.of(config.wrap ? EditorView.lineWrapping : []),
      spacerExtension(config.lines),
      EditorView.domEventHandlers({
        keydown: (event) => config.onKeyDown?.(event) ?? false,
      }),
      config.onGeometry
        ? EditorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged || update.docChanged)
              config.onGeometry?.();
          })
        : [],
      signGutter(config),
      StateField.define<DecorationSet>({
        create: (s) => hunkHeaders(config, s.doc),
        update: (value) => value,
        provide: (field) => EditorView.decorations.from(field),
      }),
      lineDecorations(config),
      currentLine,
      currentDecoration,
      language.of([]),
      syntaxHighlighting(highlighter),
    ],
  });
  const view = new EditorView({ state, parent: config.parent });
  const lifecycle = { destroyed: false };
  // A function, so the checks after each `await` are not narrowed away.
  const destroyed = () => lifecycle.destroyed;
  return {
    view,
    async highlight(path) {
      const description = LanguageDescription.matchFilename(await languages(), path);
      if (!description || destroyed()) return;
      const support = await description.load();
      if (destroyed()) return;
      view.dispatch({ effects: language.reconfigure(support) });
    },
    setWrap(wrap) {
      // A minimum width set to line up unwrapped columns would hide the end of wrapped lines.
      if (wrap) view.contentDOM.style.minWidth = '';
      view.dispatch({
        effects: [
          wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
          setSpacers.of(NO_SPACERS.a),
        ],
      });
    },
    destroy() {
      lifecycle.destroyed = true;
      view.destroy();
    },
  };
}

/** Scrolls so that line `index` is near the top, and outlines it. */
export function revealLine(editor: DiffEditor, index: number): void {
  const { view } = editor;
  if (index >= view.state.doc.lines) return;
  const pos = view.state.doc.line(index + 1).from;
  view.dispatch({
    effects: [
      setCurrentLine.of(index),
      EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }),
    ],
  });
}

/** Line index at the top of the viewport. */
export function topLine(editor: DiffEditor): number {
  const { view } = editor;
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return view.state.doc.lineAt(block.from).number - 1;
}

/** Moves the keyboard cursor to `row` and keeps it in view. */
export function showCursorRow(editor: DiffEditor, row: number | null): void {
  const { view } = editor;
  if (row === null || row >= view.state.doc.lines) {
    view.dispatch({ effects: setCursorRow.of(null) });
    return;
  }
  view.dispatch({
    effects: [
      setCursorRow.of(row),
      EditorView.scrollIntoView(view.state.doc.line(row + 1).from, { y: 'nearest', yMargin: 40 }),
    ],
  });
}
