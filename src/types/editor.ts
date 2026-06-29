/**
 * Types for the built-in file editor (Phase 5 of kern architecture).
 *
 * These types mirror the Rust FileEntry struct (camelCase on the wire) and
 * define the client-side model for open files, editor tabs, and file tree
 * state within the server detail view.
 */

/** A single entry returned by list_server_directory. */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** Unix-epoch milliseconds of last modification. */
  modified: number;
}

/** An open file tracked in the editor session. */
export interface OpenFile {
  /** Relative path from the instance root, e.g. "src/app.tsx". */
  relPath: string;
  /** Current in-memory content. */
  content: string;
  /** Monaco language id inferred from extension. */
  language: string;
  /** True when content differs from the last-saved version. */
  isDirty: boolean;
  /** Timestamp (epoch ms) of the last successful save. */
  savedAt: number;
}

/** A tab entry derived from OpenFile for the tab bar. */
export interface EditorTab {
  relPath: string;
  name: string;
  language: string;
  isDirty: boolean;
}

/** A node in the file tree used for recursive rendering. */
export interface FileTreeNode {
  name: string;
  isDir: boolean;
  relPath: string;
  children?: FileTreeNode[];
  expanded: boolean;
  loading: boolean;
}

/**
 * Maps file extensions to Monaco language identifiers.
 * Unknown extensions fall back to "plaintext".
 */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "plaintext",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  makefile: "plaintext",
  txt: "plaintext",
  log: "plaintext",
  env: "plaintext",
  gitignore: "plaintext",
  prettierrc: "json",
  eslintrc: "json",
};

/**
 * Determines the Monaco language id from a file path.
 * Checks the extension (including compound like `.test.tsx`) then falls
 * back to checking well-known filenames, then plaintext.
 */
export function languageFromPath(path: string): string {
  const name = path.split("/").pop()?.split("\\").pop() ?? "";
  const lower = name.toLowerCase();

  // Check well-known filenames first.
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "plaintext";
  if (lower === ".env") return "plaintext";
  if (lower === ".gitignore") return "plaintext";

  // Find the last extension (including multi-part like .test.ts).
  let ext = "";
  const dot = name.lastIndexOf(".");
  if (dot > 0) ext = name.slice(dot + 1).toLowerCase();
  // Also check .jsx, .tsx as compound extensions.
  const compound = name.lastIndexOf(".", dot - 1);
  if (compound > 0) {
    const compoundExt = name.slice(compound + 1).toLowerCase();
    if (EXTENSION_LANGUAGE_MAP[compoundExt]) return EXTENSION_LANGUAGE_MAP[compoundExt];
  }
  return EXTENSION_LANGUAGE_MAP[ext] ?? "plaintext";
}
