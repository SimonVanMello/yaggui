import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { highlighter, languages, styleNonce } from './editor';
import { editMarks, originalLines, type EditMarks } from './editMarks';

export interface FileEditorConfig {
  parent: HTMLElement;
  text: string;
  /** Index version the edits are marked against; `null` for an untracked file. */
  original: string | null;
  /** The file's own line break, kept on save (the editor never mixes them). */
  lineSeparator: '\n' | '\r\n';
  /** Accessible name of the code area. */
  label: string;
  wrap: boolean;
  /** Version of the file on disk `text` was read from. */
  version: string;
  /** Each change of the state below. */
  onState: (state: FileEditorState) => void;
}

export interface FileEditorState {
  /** The text differs from the file on disk it started from. */
  dirty: boolean;
  /** Version on disk the edits start from: the last one loaded, saved or accepted. */
  version: string;
}

export interface FileEditor {
  view: EditorView;
  /** The edited text, with the file's line breaks. */
  text: () => string;
  state: () => FileEditorState;
  /** Replaces the text with a version read from disk: nothing left to save. */
  load: (text: string, version: string) => void;
  /** Replaces the text with unsaved edits made from `version` (a draft brought back). */
  restore: (text: string, version: string) => void;
  /** The edits now apply over `version` (another program changed the file, theirs is dropped). */
  rebase: (version: string) => void;
  /** `text` was saved as `version`. */
  saved: (text: string, version: string) => void;
  /** New index version to mark the edits against (after a stage, for instance). */
  setOriginal: (original: string | null) => void;
  setWrap: (wrap: boolean) => void;
  highlight: (path: string) => Promise<void>;
  destroy: () => void;
}

const setOriginal = StateEffect.define<string[]>();

const originalField = StateField.define<string[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setOriginal)) return effect.value;
    return value;
  },
});

const ADDED = Decoration.line({ class: 'yaggui-edit-add' });
const REMOVED_ABOVE = Decoration.line({ class: 'yaggui-edit-removed-above' });
const REMOVED_BELOW = Decoration.line({ class: 'yaggui-edit-removed-below' });

function decorate(view: EditorView, marks: EditMarks): DecorationSet {
  const ranges = [];
  const { doc } = view.state;
  for (const { from, to } of view.visibleRanges) {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const start = doc.line(n).from;
      if (marks.added[n - 1] === 1) ranges.push(ADDED.range(start));
      if (marks.removedBefore.has(n - 1)) ranges.push(REMOVED_ABOVE.range(start));
      // Removed at the end of a text without a final line break: no line below to mark.
      if (n === doc.lines && marks.removedBefore.has(n)) ranges.push(REMOVED_BELOW.range(start));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Lines changed since the index version. Recomputed on each change: the diff trims the
 * common start and end first, so a keystroke costs a pass over the lines.
 */
const editMarkers = ViewPlugin.fromClass(
  class {
    marks: EditMarks;
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.marks = compute(view.state);
      this.decorations = decorate(view, this.marks);
    }

    update(update: ViewUpdate) {
      const reset = update.startState.field(originalField) !== update.state.field(originalField);
      if (update.docChanged || reset) this.marks = compute(update.state);
      if (update.docChanged || reset || update.viewportChanged) {
        this.decorations = decorate(update.view, this.marks);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function compute(state: EditorState): EditMarks {
  return editMarks(state.field(originalField), state.doc.toJSON());
}

export function createFileEditor(config: FileEditorConfig): FileEditor {
  const language = new Compartment();
  const wrapping = new Compartment();
  const nonce = styleNonce();
  let destroyed = false;
  /** Text of the file on disk at `version`. */
  let clean: Text | null = null;
  let current: FileEditorState = { dirty: false, version: config.version };
  const publish = (next: FileEditorState) => {
    if (next.dirty === current.dirty && next.version === current.version) return;
    current = next;
    config.onState(next);
  };
  const view = new EditorView({
    parent: config.parent,
    state: EditorState.create({
      doc: config.text,
      extensions: [
        nonce === null ? [] : EditorView.cspNonce.of(nonce),
        // Only this break splits lines: a lone `\r` in an LF file stays as it is.
        EditorState.lineSeparator.of(config.lineSeparator),
        EditorView.contentAttributes.of({ 'aria-label': config.label }),
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        language.of([]),
        syntaxHighlighting(highlighter),
        wrapping.of(config.wrap ? EditorView.lineWrapping : []),
        originalField.init(() => originalLines(config.original)),
        editMarkers,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && clean) {
            publish({ ...current, dirty: !update.state.doc.eq(clean) });
          }
        }),
      ],
    }),
  });
  clean = view.state.doc;

  const replace = (text: string) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: Transaction.addToHistory.of(false),
    });
  };

  return {
    view,
    text: () => view.state.doc.toString(),
    state: () => current,
    load(text, version) {
      replace(text);
      clean = view.state.doc;
      publish({ dirty: false, version });
    },
    restore(text, version) {
      // Compared with the text of `version` when it is the one loaded, else always unsaved.
      const base = version === current.version ? clean : null;
      replace(text);
      clean = base;
      publish({ dirty: base === null || !view.state.doc.eq(base), version });
    },
    rebase(version) {
      clean = null;
      publish({ dirty: true, version });
    },
    saved(text, version) {
      if (view.state.doc.toString() === text) {
        clean = view.state.doc;
        publish({ dirty: false, version });
      } else {
        // Typed while the save ran: those keys are still unsaved.
        clean = null;
        publish({ dirty: true, version });
      }
    },
    setOriginal(original) {
      view.dispatch({ effects: setOriginal.of(originalLines(original)) });
    },
    setWrap(wrap) {
      view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    },
    async highlight(path) {
      const description = LanguageDescription.matchFilename(await languages(), path);
      if (!description || isDestroyed()) return;
      const support = await description.load();
      if (isDestroyed()) return;
      view.dispatch({ effects: language.reconfigure(support) });
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };

  function isDestroyed(): boolean {
    return destroyed;
  }
}
