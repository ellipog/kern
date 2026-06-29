/**
 * Central state management for the file editor within the server detail view.
 *
 * Owns the working set of open files, the active tab, file tree expansion
 * state, and all save/load/delete/rename actions. Each server detail view
 * creates its own instance (one editor session per server).
 *
 * Returns both the current state and action functions so callers can render
 * from the same source of truth.
 */

import { useState, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry, OpenFile } from "../types/editor";
import { languageFromPath } from "../types/editor";

export interface FileEditorState {
  /** Open files keyed by relPath. */
  openFiles: Map<string, OpenFile>;
  /** Currently active file path, or null if none selected. */
  activeFile: string | null;
  /** Whether a file operation is in flight (save, load, list, delete). */
  busy: boolean;
  /** Last operation error message, cleared on next action. */
  error: string | null;
  /** Number of files with unsaved changes. */
  dirtyCount: number;
  /** Derived array of editor tabs for the tab bar. */
  tabs: { relPath: string; name: string; language: string; isDirty: boolean }[];
  /** The active OpenFile object, or null. */
  activeFileData: OpenFile | null;
}

export interface FileEditorActions {
  /** Open a file by its relative path, loading content from disk. */
  openFile: (relPath: string) => Promise<void>;
  /** Close a file tab. If dirty, the caller should confirm first. */
  closeFile: (relPath: string) => void;
  /** Switch the active editor tab. */
  setActiveFile: (relPath: string | null) => void;
  /** Save a single file to disk. */
  saveFile: (relPath: string) => Promise<void>;
  /** Save all dirty files. */
  saveAllFiles: () => Promise<void>;
  /** Update the in-memory content of a file (marks it dirty). */
  setFileContent: (relPath: string, content: string) => void;
  /** Check whether a specific file has unsaved changes. */
  isDirty: (relPath: string) => boolean;
  /** List directory contents (lazy-load). */
  listDirectory: (relPath: string) => Promise<FileEntry[]>;
  /** Delete a file or empty directory. */
  deletePath: (relPath: string) => Promise<void>;
  /** Create a directory (and parents). */
  createDirectory: (relPath: string) => Promise<void>;
  /** Rename or move a file/directory. */
  renamePath: (oldRelPath: string, newRelPath: string) => Promise<void>;
  /** Clear the current error. */
  clearError: () => void;
}

/**
 * Extension of file types we consider "large" (>= this many bytes) and warn on.
 * Backend can still serve them; the frontend surfaces the warning.
 */
const LARGE_FILE_THRESHOLD = 1_048_576; // 1 MiB

/**
 * Binary-like extensions we won't attempt to open in the text editor.
 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp",
  "woff", "woff2", "ttf", "eot", "otf",
  "zip", "tar", "gz", "bz2", "7z", "rar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac",
  "exe", "dll", "so", "dylib", "wasm",
  "o", "a", "lib", "obj",
]);

function isBinaryFile(path: string): boolean {
  const name = path.split("/").pop()?.split("\\").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Creates a FileEditorState + actions for one server instance.
 * Each call returns independent state (no shared mutable store).
 */
export function useFileEditor(serverId: string): FileEditorState & FileEditorActions {
  const [openFiles, setOpenFiles] = useState<Map<string, OpenFile>>(new Map());
  const [activeFile, setActiveFileState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Refs to avoid stale closures in callbacks.
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;

  const safeCall = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const openFile = useCallback(
    async (relPath: string) => {
      // Already open? Just switch to it.
      setOpenFiles((prev) => {
        if (prev.has(relPath)) {
          return prev; // no change needed
        }
        return prev;
      });
      if (openFilesRef.current.has(relPath)) {
        setActiveFileState(relPath);
        return;
      }

      // Binary check.
      if (isBinaryFile(relPath)) {
        setError(`"${relPath}" appears to be a binary file and cannot be opened in the text editor.`);
        return;
      }

      await safeCall(async () => {
        // We need to check the file size first via a directory listing of the parent.
        // Simpler: just try to read and handle errors gracefully.
        let content: string;
        try {
          content = await invoke<string>("read_server_file", {
            id: serverId,
            relPath,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("is not a file") || msg.includes("does not exist")) {
            setError(`file not found: "${relPath}"`);
          } else {
            throw e;
          }
          return;
        }

        // Check if file is too large (rough heuristic).
        if (content.length > LARGE_FILE_THRESHOLD) {
          setError(`"${relPath}" is very large (${(content.length / 1024 / 1024).toFixed(1)} MiB). The editor may be slow.`);
        }

        const language = languageFromPath(relPath);
        const openFile: OpenFile = {
          relPath,
          content,
          language,
          isDirty: false,
          savedAt: Date.now(),
        };

        setOpenFiles((prev) => {
          const next = new Map(prev);
          next.set(relPath, openFile);
          return next;
        });
        setActiveFileState(relPath);
      });
    },
    [serverId, safeCall],
  );

  const closeFile = useCallback((relPath: string) => {
    setOpenFiles((prev) => {
      const next = new Map(prev);
      next.delete(relPath);
      return next;
    });
    setActiveFileState((prev) => {
      if (prev === relPath) {
        // Switch to next available tab or null.
        const remaining = Array.from(openFilesRef.current.keys()).filter((k) => k !== relPath);
        return remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
      return prev;
    });
  }, []);

  const setActiveFile = useCallback((relPath: string | null) => {
    setActiveFileState(relPath);
  }, []);

  const saveFile = useCallback(
    async (relPath: string) => {
      const file = openFilesRef.current.get(relPath);
      if (!file) return;
      if (!file.isDirty) return;

      await safeCall(async () => {
        await invoke("write_server_file", {
          id: serverId,
          relPath,
          content: file.content,
        });
        setOpenFiles((prev) => {
          const next = new Map(prev);
          const existing = next.get(relPath);
          if (existing) {
            next.set(relPath, { ...existing, isDirty: false, savedAt: Date.now() });
          }
          return next;
        });
      });
    },
    [serverId, safeCall],
  );

  const saveAllFiles = useCallback(async () => {
    const dirty = Array.from(openFilesRef.current.values()).filter((f) => f.isDirty);
    await Promise.all(dirty.map((f) => saveFile(f.relPath)));
  }, [saveFile]);

  const setFileContent = useCallback((relPath: string, content: string) => {
    setOpenFiles((prev) => {
      const file = prev.get(relPath);
      if (!file) return prev;
      if (file.content === content) return prev; // no change
      const next = new Map(prev);
      next.set(relPath, { ...file, content, isDirty: true });
      return next;
    });
  }, []);

  const isDirty = useCallback(
    (relPath: string) => {
      return openFilesRef.current.get(relPath)?.isDirty ?? false;
    },
    [],
  );

  const dirtyCount = Array.from(openFiles.values()).filter((f) => f.isDirty).length;

  const listDirectory = useCallback(
    async (relPath: string): Promise<FileEntry[]> => {
      const result = await safeCall(async () => {
        return await invoke<FileEntry[]>("list_server_directory", {
          id: serverId,
          relPath,
        });
      });
      return result ?? [];
    },
    [serverId, safeCall],
  );

  const deletePath = useCallback(
    async (relPath: string) => {
      await safeCall(async () => {
        await invoke("delete_server_path", { id: serverId, relPath });
        // Remove from open files if open.
        setOpenFiles((prev) => {
          if (!prev.has(relPath)) return prev;
          const next = new Map(prev);
          next.delete(relPath);
          return next;
        });
        setActiveFileState((prev) => {
          if (prev === relPath) {
            const remaining = Array.from(openFilesRef.current.keys()).filter((k) => k !== relPath);
            return remaining.length > 0 ? remaining[remaining.length - 1] : null;
          }
          return prev;
        });
      });
    },
    [serverId, safeCall],
  );

  const createDirectory = useCallback(
    async (relPath: string) => {
      await safeCall(async () => {
        await invoke("create_server_directory", { id: serverId, relPath });
      });
    },
    [serverId, safeCall],
  );

  const renamePath = useCallback(
    async (oldRelPath: string, newRelPath: string) => {
      await safeCall(async () => {
        await invoke("rename_server_path", {
          id: serverId,
          oldRelPath,
          newRelPath,
        });
        // Update open files map key if the renamed file was open.
        setOpenFiles((prev) => {
          const file = prev.get(oldRelPath);
          if (!file) return prev;
          const next = new Map(prev);
          next.delete(oldRelPath);
          const language = languageFromPath(newRelPath);
          next.set(newRelPath, { ...file, relPath: newRelPath, language });
          return next;
        });
        setActiveFileState((prev) => (prev === oldRelPath ? newRelPath : prev));
      });
    },
    [serverId, safeCall],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Derived state.
  const tabs = useMemo(
    () =>
      Array.from(openFiles.values()).map((f) => ({
        relPath: f.relPath,
        name: f.relPath.split("/").pop() ?? f.relPath,
        language: f.language,
        isDirty: f.isDirty,
      })),
    [openFiles],
  );

  const activeFileData = activeFile ? openFiles.get(activeFile) ?? null : null;

  return {
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
    isDirty,
    listDirectory,
    deletePath,
    createDirectory,
    renamePath,
    clearError,
  };
}
