import React, { useRef, useEffect } from 'react';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

interface PythonEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  errorLine?: number | null;  // 1-based line number
}

import {
  EDITOR_BG, EDITOR_TEXT, EDITOR_GUTTER_BG, EDITOR_GUTTER_TEXT,
  EDITOR_GUTTER_BORDER, EDITOR_ACTIVE_LINE, EDITOR_CURSOR, EDITOR_FONT_SIZE,
} from '../constants.js';

const theme = EditorView.theme({
  '&': {
    fontSize: EDITOR_FONT_SIZE,
    backgroundColor: EDITOR_BG,
  },
  '.cm-content': {
    fontFamily: '"Consolas", "Monaco", "Courier New", monospace',
    caretColor: EDITOR_CURSOR,
    color: EDITOR_TEXT,
  },
  '.cm-gutters': {
    backgroundColor: EDITOR_GUTTER_BG,
    color: EDITOR_GUTTER_TEXT,
    borderRight: `1px solid ${EDITOR_GUTTER_BORDER}`,
  },
  '.cm-activeLine': {
    backgroundColor: EDITOR_ACTIVE_LINE,
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: EDITOR_CURSOR,
  },
});

// Error line highlight
const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorLine)) {
        if (effect.value === null || effect.value < 1) return Decoration.none;
        try {
          const line = tr.state.doc.line(effect.value);
          return Decoration.set([
            Decoration.line({ class: 'cm-error-line' }).range(line.from),
          ]);
        } catch {
          return Decoration.none;
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function PythonEditor({ value, onChange, readOnly = false, errorLine = null }: PythonEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        history(),
        python(),
        errorLineField,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...closeBracketsKeymap,
          indentWithTab,
        ]),
        theme,
        updateListener,
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Mount only once

  // Sync external value changes (but not our own edits)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  // Sync error line highlight
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  return (
    <div
      ref={containerRef}
      className="python-editor-container nodrag nopan nowheel"
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
