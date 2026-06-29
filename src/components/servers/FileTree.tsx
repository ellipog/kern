/**
 * File explorer tree — a collapsible, lazy-loading directory tree for the
 * server instance's working directory, modelled after VS Code's explorer.
 *
 * Directories expand/collapse on click with lazy child loading. Files open on
 * click. Hidden files (.env, .gitignore, etc.) are shown but visually dimmed.
 * The active file is highlighted with a signal-green left-border accent.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { FileEntry } from "../../types/editor";

interface FileTreeProps {
  /** Server instance id — used for backend calls in the parent. */
  serverId: string;
  /** Active file's relative path for highlighting. */
  activeFile: string | null;
  /** Callback when a file is clicked to open. */
  onOpenFile: (relPath: string) => void;
  /** Callback to list directory contents (returns FileEntry[]). */
  onListDirectory: (relPath: string) => Promise<FileEntry[]>;
  /** Set of currently expanded directory relative paths. */
  expandedPaths: Set<string>;
  /** Toggle a directory's expansion state. */
  onToggleExpand: (relPath: string) => void;
  /** Called when the tree should refresh (e.g. after create/delete/rename). */
  refreshKey?: number;
}

interface TreeNode {
  entry: FileEntry;
  relPath: string;
  children?: TreeNode[];
  loaded: boolean;
  loading: boolean;
}

/**
 * Returns a display name for common root-level config files.
 */
function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "package.json") return "{ }";
  if (lower === "tsconfig.json") return "TS";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "T";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) return "J";
  if (lower.endsWith(".rs")) return "R";
  if (lower.endsWith(".py")) return "P";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "#";
  if (lower.endsWith(".json")) return "{ }";
  if (lower.endsWith(".md")) return "M";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "H";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "Y";
  if (lower.endsWith(".env")) return ".env";
  if (lower === "dockerfile") return "D";
  if (lower.endsWith(".gitignore")) return "!";
  if (lower === "readme.md") return "📄";
  return "";
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

export function FileTree({
  activeFile,
  onOpenFile,
  onListDirectory,
  expandedPaths,
  onToggleExpand,
  refreshKey = 0,
}: FileTreeProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    relPath: string;
    isDir: boolean;
  } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Load root directory on mount and refreshKey changes.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const entries = await onListDirectory("");
        if (!cancelled) {
          setRootEntries(entries);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setRootEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [onListDirectory, refreshKey]);

  // Close context menu on any click outside.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Keyboard: close context menu on Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, relPath: string, isDir: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, relPath, isDir });
    },
    [],
  );

  if (!loaded && loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-bg-core p-3">
        <p className="text-[11px] text-zinc-600">loading…</p>
      </div>
    );
  }

  if (loaded && rootEntries.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto bg-bg-core p-3">
        <p className="text-[11px] text-zinc-600">(empty directory)</p>
      </div>
    );
  }

  return (
    <div
      ref={treeRef}
      className="flex-1 overflow-y-auto bg-bg-core py-1 select-none"
      onContextMenu={(e) => {
        // Right-click on empty area: show root context menu.
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, relPath: "", isDir: true });
      }}
    >
      {rootEntries.map((entry) => (
        <FileTreeItem
          key={entry.name}
          entry={entry}
          relPath={entry.name}
          depth={0}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
          onListDirectory={onListDirectory}
          expandedPaths={expandedPaths}
          onToggleExpand={onToggleExpand}
          onContextMenu={handleContextMenu}
        />
      ))}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-surface border border-grid-bounds shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-bg-core transition-colors"
            onClick={() => {
              onOpenFile(contextMenu.relPath);
              setContextMenu(null);
            }}
          >
            Open{contextMenu.isDir ? "" : ""}
          </button>
          {contextMenu.isDir && (
            <button
              className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-bg-core transition-colors"
              onClick={() => {
                onToggleExpand(contextMenu.relPath);
                setContextMenu(null);
              }}
            >
              Toggle expand
            </button>
          )}
          <div className="border-t border-grid-bounds my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-bg-core transition-colors"
            onClick={() => {
              // Future: rename
              setContextMenu(null);
            }}
          >
            Rename…
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-[11px] text-fault-vector hover:bg-bg-core transition-colors"
            onClick={() => {
              // Future: delete (with confirmation)
              setContextMenu(null);
            }}
          >
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Recursive Tree Item ──────────────────────────────────────────────── */

interface FileTreeItemProps {
  entry: FileEntry;
  relPath: string;
  depth: number;
  activeFile: string | null;
  onOpenFile: (relPath: string) => void;
  onListDirectory: (relPath: string) => Promise<FileEntry[]>;
  expandedPaths: Set<string>;
  onToggleExpand: (relPath: string) => void;
  onContextMenu: (e: React.MouseEvent, relPath: string, isDir: boolean) => void;
}

function FileTreeItem({
  entry,
  relPath,
  depth,
  activeFile,
  onOpenFile,
  onListDirectory,
  expandedPaths,
  onToggleExpand,
  onContextMenu,
}: FileTreeItemProps) {
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const isExpanded = expandedPaths.has(relPath);
  const isActive = activeFile === relPath;
  const hidden = isHidden(entry.name);
  const icon = fileIcon(entry.name);

  // Load children when expanded for the first time.
  useEffect(() => {
    if (!entry.isDir || !isExpanded || children !== null) return;
    let cancelled = false;
    setLoadingChildren(true);
    onListDirectory(relPath)
      .then((entries) => {
        if (!cancelled) {
          setChildren(
            entries.map((e) => ({
              entry: e,
              relPath: `${relPath}/${e.name}`,
              loaded: false,
              loading: false,
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setChildren([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingChildren(false);
      });
    return () => { cancelled = true; };
  }, [entry.isDir, isExpanded, children, onListDirectory, relPath]);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onToggleExpand(relPath);
    } else {
      onOpenFile(relPath);
    }
  }, [entry.isDir, relPath, onToggleExpand, onOpenFile]);

  const handleContext = useCallback(
    (e: React.MouseEvent) => {
      onContextMenu(e, relPath, entry.isDir);
    },
    [onContextMenu, relPath, entry.isDir],
  );

  return (
    <div>
      <button
        onClick={handleClick}
        onContextMenu={handleContext}
        className={`flex w-full items-center gap-1.5 text-left transition-colors border-l-2
          ${isActive ? "border-signal-high bg-bg-surface" : "border-transparent hover:bg-bg-surface"}
        `}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={relPath}
      >
        {/* Chevron/expand icon */}
        <span className="w-3.5 text-[10px] text-zinc-600 shrink-0 text-center">
          {entry.isDir ? (isExpanded ? "▾" : "▸") : ""}
        </span>

        {/* Loading spinner for lazy-loaded dirs */}
        {entry.isDir && loadingChildren && (
          <span className="w-3.5 text-[10px] text-signal-high shrink-0">•</span>
        )}

        {/* File type icon */}
        {!entry.isDir && icon && (
          <span className="text-[9px] text-zinc-500 w-4 text-center shrink-0">{icon}</span>
        )}

        {/* Name */}
        <span
          className={`text-[11px] truncate ${
            isActive
              ? "text-zinc-100"
              : hidden
                ? "text-zinc-600"
                : "text-zinc-400"
          }`}
        >
          {entry.name}
        </span>
      </button>

      {/* Children (directory contents) */}
      {entry.isDir && isExpanded && (
        <div>
          {loadingChildren && children === null && (
            <p className="text-[10px] text-zinc-600 pl-[28px] py-0.5">loading…</p>
          )}
          {children !== null && children.length === 0 && (
            <p className="text-[10px] text-zinc-700 pl-[28px] py-0.5">(empty)</p>
          )}
          {children !== null &&
            children.map((child) => (
              <FileTreeItem
                key={child.relPath}
                entry={child.entry}
                relPath={child.relPath}
                depth={depth + 1}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
                onListDirectory={onListDirectory}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                onContextMenu={onContextMenu}
              />
            ))}
        </div>
      )}
    </div>
  );
}
