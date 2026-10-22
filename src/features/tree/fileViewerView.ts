import { defaultKeymap } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { highlighter, languages, styleNonce } from '../diff/editor';

export interface FileViewer {
  view: EditorView;
  /** Shows `text`, highlighted for the language of `path`. */
  show: (text: string, path: string) => void;
  setWrap: (wrap: boolean) => void;
  destroy: () => void;
}

/**
 * A read-only code view (M7-8): line numbers and syntax highlighting, no editing. One view
 * serves every file of the tree: showing another file replaces the document.
 */
export function createFileViewer(config: {
  parent: HTMLElement;
  label: string;
  wrap: boolean;
}): FileViewer {
  const language = new Compartment();
  const wrapping = new Compartment();
  const nonce = styleNonce();
  let destroyed = false;
  let shown = 0;
  const view = new EditorView({
    parent: config.parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        nonce === null ? [] : EditorView.cspNonce.of(nonce),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ 'aria-label': config.label, tabindex: '0' }),
        lineNumbers(),
        keymap.of(defaultKeymap),
        language.of([]),
        syntaxHighlighting(highlighter),
        wrapping.of(config.wrap ? EditorView.lineWrapping : []),
      ],
    }),
  });

  return {
    view,
    show(text, path) {
      const token = ++shown;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        effects: [language.reconfigure([]), EditorView.scrollIntoView(0)],
      });
      void (async () => {
        const description = LanguageDescription.matchFilename(await languages(), path);
        if (!description) return;
        const support = await description.load();
        // Another file may have been shown while the language loaded.
        if (destroyed || token !== shown) return;
        view.dispatch({ effects: language.reconfigure(support) });
      })();
    },
    setWrap(wrap) {
      view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}
