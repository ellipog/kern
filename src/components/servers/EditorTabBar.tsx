/**
 * Horizontal tab bar for open editor files — modelled after VS Code's tab strip.
 *
 * Each tab shows the filename, a dirty indicator (green dot), and a close
 * button (×) on hover. The active tab is highlighted with a signal-green
 * bottom border. Tabs are scrollable horizontally when there are many files.
 */

import { useRef, useEffect } from "react";
import type { EditorTab } from "../../types/editor";

interface EditorTabBarProps {
  /** All open editor tabs. */
  tabs: EditorTab[];
  /** Relative path of the currently active tab. */
  activeFile: string | null;
  /** Switch to a tab. */
  onSelect: (relPath: string) => void;
  /** Close a tab. */
  onClose: (relPath: string) => void;
  /** Save the active tab. */
  onSave?: () => void;
}

/**
 * Maps language ids to short display labels and colors for the tab bar.
 */
function tabMeta(language: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    typescript: { label: "TS", color: "#3178c6" },
    javascript: { label: "JS", color: "#f0db4f" },
    json: { label: "{}", color: "#4c525e" },
    html: { label: "HTML", color: "#e44d26" },
    css: { label: "CSS", color: "#264de4" },
    scss: { label: "SCSS", color: "#cc6699" },
    python: { label: "PY", color: "#3572A5" },
    rust: { label: "RS", color: "#dea584" },
    go: { label: "GO", color: "#00ADD8" },
    markdown: { label: "MD", color: "#4c525e" },
    yaml: { label: "YAML", color: "#6b6b6b" },
    shell: { label: "SH", color: "#89e051" },
    xml: { label: "XML", color: "#4c525e" },
    sql: { label: "SQL", color: "#e38c00" },
    plaintext: { label: "TXT", color: "#4c525e" },
  };
  return map[language] ?? { label: "•", color: "#4c525e" };
}

export function EditorTabBar({
  tabs,
  activeFile,
  onSelect,
  onClose,
}: EditorTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll the active tab into view.
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeFile, tabs.length]);

  if (tabs.length === 0) {
    return (
      <div className="flex items-center h-7 border-b border-grid-bounds bg-bg-surface" />
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex items-stretch h-7 overflow-x-auto overflow-y-hidden border-b border-grid-bounds bg-bg-surface scrollbar-none"
    >
      {tabs.map((tab) => {
        const isActive = tab.relPath === activeFile;
        const meta = tabMeta(tab.language);
        return (
          <button
            key={tab.relPath}
            ref={isActive ? activeRef : undefined}
            onClick={() => onSelect(tab.relPath)}
            onMouseDown={(e) => {
              // Middle-click to close.
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.relPath);
              }
            }}
            className={`
              group flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] whitespace-nowrap
              border-r border-grid-bounds transition-colors shrink-0
              ${isActive
                ? "bg-bg-core text-zinc-200 border-b border-b-signal-high"
                : "bg-transparent text-zinc-500 hover:text-zinc-300 hover:bg-bg-surface"
              }
            `}
            title={tab.relPath}
          >
            {/* Language badge */}
            <span
              className="text-[8px] font-bold uppercase tracking-wider"
              style={{ color: meta.color }}
            >
              {meta.label}
            </span>

            {/* Dirty dot */}
            {tab.isDirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-signal-high shrink-0" />
            )}

            {/* Filename */}
            <span className="truncate max-w-[120px]">{tab.name}</span>

            {/* Close button — visible on hover */}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.relPath);
              }}
              className="ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded
                text-zinc-600 opacity-0 group-hover:opacity-100 hover:bg-bg-surface
                hover:text-zinc-200 transition-opacity"
            >
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}
