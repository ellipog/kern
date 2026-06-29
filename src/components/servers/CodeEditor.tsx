/**
 * Monaco Editor wrapper with kern's custom dark theme, custom Monarch
 * language definitions, format-on-save, and bracket-pair colorization.
 *
 * The custom languages (env, properties, ignore, ini, log) are registered
 * with Monaco at module level — before any Editor component mounts. This is
 * required because Monaco only tokenizes a language after its Monarch
 * provider is registered.
 */

import { useRef, useCallback, useEffect } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
import type { editor } from "monaco-editor";
import { KERN_THEME } from "./editorTheme";
import { registerCustomLanguages } from "./monarchLanguages";

// Configure Monaco to bundle inline (avoids web worker CORS issues in Tauri).
// The `loader.config({ monaco })` call tells the React wrapper to use
// the local bundle instead of fetching from CDN.
loader.config({ monaco: monacoEditor });

// Register the kern theme and all custom Monarch languages at module level.
// This must happen before any Editor component mounts.
function initializeMonaco() {
  monacoEditor.editor.defineTheme("kern-dark", KERN_THEME);
  registerCustomLanguages(monacoEditor);
}
initializeMonaco();

interface CodeEditorProps {
  language: string;
  value: string;
  onChange: (value: string | undefined) => void;
  onSave: () => void;
  onCursorPosition?: (line: number, column: number) => void;
  path?: string;
  readOnly?: boolean;
}

/**
 * Formats a Monaco cursor position event into line/column numbers.
 */
function extractPosition(e: editor.ICursorPositionChangedEvent) {
  return {
    line: e.position.lineNumber,
    column: e.position.column,
  };
}

export function CodeEditor({
  language,
  value,
  onChange,
  onSave,
  onCursorPosition,
  path,
  readOnly = false,
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);

  const handleMount: OnMount = useCallback(
    (ed, monaco) => {
      editorRef.current = ed;

      // Re-register theme and languages (idempotent — safe to call again).
      monaco.editor.defineTheme("kern-dark", KERN_THEME);
      registerCustomLanguages(monaco);
      monaco.editor.setTheme("kern-dark");

      // Store model ref for proper disposal on unmount.
      modelRef.current = ed.getModel() ?? null;

      // Register Ctrl/Cmd+S save action.
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSave();
      });

      // Report cursor position changes to the parent.
      if (onCursorPosition) {
        ed.onDidChangeCursorPosition((e) => {
          const { line, column } = extractPosition(e);
          onCursorPosition(line, column);
        });
      }

      // Focus the editor on mount so the user can start typing immediately.
      if (!readOnly) {
        ed.focus();
      }
    },
    [onSave, onCursorPosition, readOnly],
  );

  // Cleanup: dispose the editor model when the component unmounts.
  useEffect(() => {
    return () => {
      // Dispose the model to prevent memory leaks.
      if (modelRef.current) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
      editorRef.current = null;
    };
  }, []);

  return (
    <Editor
      key={path ?? language}
      language={language}
      value={value}
      onChange={onChange}
      onMount={handleMount}
      path={path}
      theme="kern-dark"
      options={{
        // Kern monospace aesthetic.
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
        fontSize: 13,
        fontLigatures: true,
        lineHeight: 1.6,
        readOnly,

        // Layout
        minimap: { enabled: true, maxColumn: 60, scale: 1 },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        renderWhitespace: "selection",
        renderLineHighlight: "line",
        lineNumbersMinChars: 3,
        folding: true,
        foldingHighlight: true,
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: true,
        stickyScroll: { enabled: true },

        // Formatting — format on paste and type.
        // (formatOnSave is a VS Code concept; Monaco handles this via the
        // save keybinding which calls our onSave handler.)
        formatOnPaste: true,
        formatOnType: true,

        // Bracket pair colorization
        bracketPairColorization: { enabled: true },
        guides: { indentation: true, bracketPairs: true },

        // Scrolling
        smoothScrolling: true,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
          alwaysConsumeMouseWheel: false,
        },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,

        // Selection/cursor
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        cursorStyle: "line",
        selectionHighlight: true,
        matchBrackets: "always",
        autoClosingBrackets: "always",
        autoClosingQuotes: "always",
        autoIndent: "full",

        // Widgets/completion
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
        parameterHints: { enabled: true },
        codeLens: false,
        accessibilitySupport: "on",

        // Misc
        renderValidationDecorations: "on",
        padding: { top: 8, bottom: 8 },
        autoDetectHighContrast: true,
      }}
    />
  );
}

/**
 * Ensures the kern Monaco theme is registered. Safe to call multiple times
 * since defineTheme is idempotent.
 */
export function configureMonaco() {
  monacoEditor.editor.defineTheme("kern-dark", KERN_THEME);
  registerCustomLanguages(monacoEditor);
}
