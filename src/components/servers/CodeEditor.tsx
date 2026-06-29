/**
 * Monaco Editor wrapper with kern's custom dark theme.
 *
 * Thin layer over @monaco-editor/react that injects the design-system theme,
 * registers the Ctrl+S / Cmd+S save handler, and surfaces cursor position
 * changes via onCursorPosition for the status bar.
 */

import { useRef, useCallback, useEffect } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
import type { editor } from "monaco-editor";
import { KERN_THEME } from "./editorTheme";

// Configure Monaco to bundle inline (avoids web worker CORS issues in Tauri).
// This must happen before any Editor component mounts, so we do it at module
// level. The `loader.config({ monaco })` call tells the React wrapper to use
// the local bundle instead of fetching from CDN.
loader.config({ monaco: monacoEditor });

// Register the kern theme once the Monaco engine is ready.
// This is safe to call multiple times (defineTheme is idempotent).
function registerTheme() {
  monacoEditor.editor.defineTheme("kern-dark", KERN_THEME);
}
registerTheme();

interface CodeEditorProps {
  language: string;
  value: string;
  onChange: (value: string | undefined) => void;
  onSave: () => void;
  onCursorPosition?: (line: number, column: number) => void;
  path?: string;
}

/**
 * Formats a Monaco cursor position event into line/column numbers.
 * Monaco uses 1-based line/column internally; we pass them raw.
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
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = useCallback(
    (ed, monaco) => {
      editorRef.current = ed;

      // Register the kern theme (if not already).
      monaco.editor.defineTheme("kern-dark", KERN_THEME);
      monaco.editor.setTheme("kern-dark");

      // Register Ctrl+S / Cmd+S save action.
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
      ed.focus();
    },
    [onSave, onCursorPosition],
  );

  // When the active file changes, update the editor model.
  useEffect(() => {
    return () => {
      // Cleanup: dispose editor when component unmounts.
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

        // Scrolling
        smoothScrolling: true,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
          alwaysConsumeMouseWheel: false,
        },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,

        // Selection
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        cursorStyle: "line",
        selectionHighlight: true,
        matchBrackets: "always",
        autoClosingBrackets: "always",
        autoClosingQuotes: "always",
        autoIndent: "full",
        formatOnPaste: true,

        // Widgets
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
        parameterHints: { enabled: true },
        codeLens: false,

        // Misc
        readOnly: false,
        renderValidationDecorations: "on",
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}

/**
 * Ensures the kern Monaco theme is registered. Safe to call multiple times
 * since defineTheme is idempotent. The theme is already registered at module
 * level, but this export provides an explicit hook for callers who want to
 * guarantee registration before mounting an Editor component.
 */
export function configureMonaco() {
  registerTheme();
}
