/**
 * File Editor Panel — the full VS Code-like editing experience within the
 * server detail view.
 *
 * Assembles:
 *   - File tree sidebar (left, 220px)
 *   - Editor area (right): tab bar + Monaco editor + status bar
 *   - Error/save-state banners
 *
 * Each `FileEditorPanel` owns an independent editor session via `useFileEditor`.
 */

import { useState, useCallback, useEffect } from "react";
import { FileTree } from "./FileTree";
import { EditorTabBar } from "./EditorTabBar";
import { CodeEditor, configureMonaco } from "./CodeEditor";
import { useFileEditor } from "../../hooks/useFileEditor";

interface FileEditorPanelProps {
  /** Server instance id — scopes all file operations. */
  serverId: string;
}

// Ensure Monaco theme is registered at least once at module level.
configureMonaco();

export function FileEditorPanel({ serverId }: FileEditorPanelProps) {
  const {
    // State
    openFiles,
    activeFile,
    busy,
    error,
    dirtyCount,
    tabs,
    activeFileData,
    // Actions
    openFile,
    closeFile,
    setActiveFile,
    saveFile,
    saveAllFiles,
    setFileContent,
    clearError,
    listDirectory,
  } = useFileEditor(serverId);

  // Expanded directory paths in the file tree.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [refreshTree, setRefreshTree] = useState(0);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);

  // Wrapped actions
  const handleOpenFile = useCallback(
    async (relPath: string) => {
      await openFile(relPath);
    },
    [openFile],
  );

  const handleCloseFile = useCallback(
    (relPath: string) => {
      const file = openFiles.get(relPath);
      if (file?.isDirty) {
        // Auto-save on close when dirty (TODO: add confirmation dialog).
        saveFile(relPath).then(() => closeFile(relPath));
        return;
      }
      closeFile(relPath);
    },
    [openFiles, saveFile, closeFile],
  );

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    await saveFile(activeFile);
  }, [activeFile, saveFile]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!activeFile || value === undefined) return;
      setFileContent(activeFile, value);
    },
    [activeFile, setFileContent],
  );

  const handleCursorPosition = useCallback((line: number, column: number) => {
    setCursorLine(line);
    setCursorCol(column);
  }, []);

  const handleToggleExpand = useCallback(
    async (relPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(relPath)) {
          next.delete(relPath);
        } else {
          next.add(relPath);
        }
        return next;
      });
    },
    [],
  );

  // Trigger a tree refresh when openFiles size changes (file was created/deleted).
  useEffect(() => {
    setRefreshTree((t) => t + 1);
  }, [openFiles.size]);

  const activeLanguage = activeFileData?.language ?? "plaintext";
  const activeContent = activeFileData?.content ?? "";

  return (
    <div className="flex flex-1 min-h-0">
      {/* File tree sidebar */}
      <div className="w-[220px] shrink-0 flex flex-col border-r border-grid-bounds matrix-border">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-grid-bounds">
          <span className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
            explorer
          </span>
          <span className="text-[10px] text-zinc-600 tabular-nums">
            {tabs.length}
          </span>
        </div>
        <FileTree
          serverId={serverId}
          activeFile={activeFile}
          onOpenFile={handleOpenFile}
          onListDirectory={listDirectory}
          expandedPaths={expandedPaths}
          onToggleExpand={handleToggleExpand}
          refreshKey={refreshTree}
        />
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {tabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center bg-bg-core">
            <div className="text-center">
              <p className="text-[11px] text-zinc-600 mb-1">
                no files open
              </p>
              <p className="text-[10px] text-zinc-700">
                select a file in the explorer to start editing
              </p>
            </div>
          </div>
        ) : (
          <>
            <EditorTabBar
              tabs={tabs}
              activeFile={activeFile}
              onSelect={setActiveFile}
              onClose={handleCloseFile}
              onSave={handleSave}
            />
            <div className="flex-1 min-h-0">
              {activeFileData && (
                <CodeEditor
                  key={activeFile}
                  language={activeLanguage}
                  value={activeContent}
                  onChange={handleEditorChange}
                  onSave={handleSave}
                  onCursorPosition={handleCursorPosition}
                  path={activeFile ?? undefined}
                />
              )}
            </div>
            {/* Status bar */}
            <div className="flex items-center justify-between h-6 px-3 border-t border-grid-bounds bg-bg-surface shrink-0">
              <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                <span className="tabular-nums">
                  Ln {cursorLine}, Col {cursorCol}
                </span>
                <span>
                  {activeLanguage}
                </span>
                <span>
                  UTF-8
                </span>
                {dirtyCount > 0 && (
                  <span className="text-warn-vector">
                    {dirtyCount} unsaved
                  </span>
                )}
                {busy && (
                  <span className="text-signal-high">saving…</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSave}
                  disabled={!activeFileData?.isDirty || busy}
                  className="text-[10px] text-signal-high hover:text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Save (Ctrl+S)"
                >
                  save
                </button>
                {dirtyCount > 0 && (
                  <button
                    onClick={() => saveAllFiles()}
                    className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors"
                    title="Save All"
                  >
                    save all
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-fault-vector/40 bg-fault-vector/5">
            <span className="text-[10px] text-fault-vector flex-1">{error}</span>
            <button
              onClick={clearError}
              className="text-[10px] text-zinc-500 hover:text-zinc-200"
            >
              dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
