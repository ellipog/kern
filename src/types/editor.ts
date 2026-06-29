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
 *
 * This map covers virtually every common file type a developer might encounter
 * in a server project — from systems languages to config formats, from
 * build files to docs. When Monaco ships a native language it's used
 * directly; for formats Monaco doesn't support natively (`.env`,
 * `.properties`, `.log`, etc.), custom Monarch tokenizers are registered
 * separately in monarchLanguages.ts.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  // ── TypeScript / JavaScript ──────────────────────────────────────────────
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  // ── JSON / JSONC ────────────────────────────────────────────────────────
  json: "json",
  jsonc: "json",
  jsonl: "json",
  ndjson: "json",

  // ── Web: HTML / CSS ────────────────────────────────────────────────────
  html: "html",
  htm: "html",
  htmx: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",

  // ── Web: Templates / Frameworks ─────────────────────────────────────────
  pug: "pug",
  jade: "pug",
  ejs: "html",
  hbs: "handlebars",
  handlebars: "handlebars",
  mustache: "handlebars",
  njk: "html",
  nunjucks: "html",
  svg: "xml",

  // ── Markdown / Docs ─────────────────────────────────────────────────────
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rmd: "markdown",
  tex: "latex",
  latex: "latex",
  bib: "latex",
  adoc: "plaintext",
  asciidoc: "plaintext",

  // ── Data / Config ───────────────────────────────────────────────────────
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "properties", // custom Monarch
  env: "env",               // custom Monarch
  reg: " plaintext",

  // ── Protocols / Schemas ─────────────────────────────────────────────────
  proto: "proto",
  prisma: "plaintext",
  graphql: "graphql",
  gql: "graphql",
  graphqls: "graphql",

  // ── Systems: C-family ──────────────────────────────────────────────────
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  csx: "csharp",

  // ── Systems: Rust / Go / Zig / Nim ──────────────────────────────────────
  rs: "rust",
  go: "go",
  zig: "plaintext",
  nim: "plaintext",
  nims: "plaintext",

  // ── Systems: Swift / Kotlin / Scala / Dart ──────────────────────────────
  swift: "swift",
  kt: "kotlin",
  ktm: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  dart: "dart",

  // ── Systems: Haskell / OCaml / F# / Erlang / Elixir ─────────────────────
  hs: "haskell",
  lhs: "haskell",
  ml: "plaintext",
  mli: "plaintext",
  fs: "fsharp",
  fsx: "fsharp",
  fsi: "fsharp",
  erl: "plaintext",
  hrl: "plaintext",
  ex: "elixir",
  exs: "elixir",

  // ── Scripting: Python / Ruby / Perl / Lua ──────────────────────────────
  py: "python",
  pyi: "python",
  pyw: "python",
  rb: "ruby",
  rake: "ruby",
  pl: "perl",
  pm: "perl",
  t: "perl",
  lua: "lua",
  luau: "lua",

  // ── Scripting: Shell ───────────────────────────────────────────────────
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "batch",

  // ── JVM: Java / Groovy / Clojure ───────────────────────────────────────
  java: "java",
  groovy: "groovy",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  cljd: "clojure",

  // ── Functional / Other compiled ─────────────────────────────────────────
  elm: "elm",
  coffee: "coffeescript",
  litcoffee: "coffeescript",

  // ── SQL / DB ────────────────────────────────────────────────────────────
  sql: "sql",
  mysql: "sql",
  psql: "sql",
  plsql: "sql",

  // ── R / Julia / Mathematica ─────────────────────────────────────────────
  r: "r",
  R: "r",
  jl: "plaintext",
  wl: "plaintext",
  wls: "plaintext",

  // ── VB / Classic ────────────────────────────────────────────────────────
  vb: "vb",
  vbs: "vb",

  // ── Misc plaintext-ish ──────────────────────────────────────────────────
  txt: "plaintext",
  log: "log",             // custom Monarch
  csv: "plaintext",
  tsv: "plaintext",
  tcl: "plaintext",
  pde: "c",               // processing
  ino: "c",               // arduino
};

/**
 * Maps well-known filenames (case-insensitive basename) to Monaco language
 * identifiers. Handles files that carry meaning by name rather than
 * extension — Docker, Make, config, lockfiles, docs, etc.
 */
const FILENAME_LANGUAGE_MAP: Record<string, string> = {
  // ── Docker ───────────────────────────────────────────────────────────────
  dockerfile: "dockerfile",
  "docker-compose.yml": "yaml",
  "docker-compose.yaml": "yaml",
  "docker-compose.override.yml": "yaml",
  "docker-compose.override.yaml": "yaml",
  ".dockerignore": "plaintext",

  // ── Build systems ──────────────────────────────────────────────────────────
  "cmakelists.txt": "plaintext",
  makefile: "plaintext",
  "gnu makefile": "plaintext",
  justfile: "plaintext",
  procfile: "plaintext",
  vagrantfile: "plaintext",
  brewfile: "plaintext",
  rakefile: "plaintext",
  gemfile: "plaintext",
  "gemfile.lock": "plaintext",

  // ── Config / rc files ───────────────────────────────────────────────────────
  ".editorconfig": "plaintext",
  ".babelrc": "json",
  ".npmrc": "plaintext",
  ".yarnrc": "plaintext",
  ".nvmrc": "shell",
  ".prettierrc": "json",
  ".prettierrc.js": "javascript",
  ".prettierrc.yaml": "yaml",
  ".prettierrc.yml": "yaml",
  ".prettierrc.toml": "toml",
  ".prettierrc.json": "json",
  ".eslintrc": "json",
  ".eslintrc.js": "javascript",
  ".eslintrc.yaml": "yaml",
  ".eslintrc.yml": "yaml",
  ".eslintrc.json": "json",
  ".stylelintrc": "json",
  ".stylelintrc.json": "json",
  ".stylelintrc.yaml": "yaml",
  ".stylelintrc.yml": "yaml",
  ".browserslistrc": "plaintext",
  ".htaccess": "plaintext",
  ".htpasswd": "plaintext",

  // ── Env files ───────────────────────────────────────────────────────────────
  ".env": "plaintext",
  ".env.local": "plaintext",
  ".env.development": "plaintext",
  ".env.production": "plaintext",
  ".env.test": "plaintext",
  ".env.staging": "plaintext",
  ".env.example": "plaintext",

  // ── Package lockfiles ──────────────────────────────────────────────────────
  "package-lock.json": "json",
  "yarn.lock": "plaintext",
  "pnpm-lock.yaml": "yaml",
  "cargo.lock": "toml",
  "composer.lock": "json",
  "poetry.lock": "toml",
  "mix.lock": "plaintext",

  // ── Git ────────────────────────────────────────────────────────────────────
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".gitmodules": "plaintext",
  ".gitkeep": "plaintext",
  ".mailmap": "plaintext",

  // ── Docs ────────────────────────────────────────────────────────────────────
  license: "plaintext",
  "license.md": "plaintext",
  "license.txt": "plaintext",
  readme: "markdown",
  "readme.md": "markdown",
  changelog: "markdown",
  "changelog.md": "markdown",
  contributing: "plaintext",
  "contributing.md": "plaintext",
  security: "plaintext",
  "security.md": "plaintext",
  authors: "plaintext",
  "authors.md": "plaintext",
  codeowners: "plaintext",
  "code-of-conduct.md": "markdown",
};

/**
 * Determines the Monaco language id from a file path.
 *
 * Resolution order:
 * 1. Well-known filename match (case-insensitive basename) — handles
 *    Docker, Make, config, lockfiles, docs, etc.
 * 2. Extension match (including compound extensions like `.test.tsx`)
 * 3. Fallback to "plaintext"
 */
export function languageFromPath(path: string): string {
  const name = path.split("/").pop()?.split("\\").pop() ?? "";
  const lower = name.toLowerCase();

  // 1. Well-known filename match.
  if (FILENAME_LANGUAGE_MAP[lower]) return FILENAME_LANGUAGE_MAP[lower];

  // 2. Extension match — check compound extensions first (e.g. `.test.tsx`).
  //    We scan from the leftmost dot to find the longest matching compound.
  const firstDot = name.indexOf(".");
  if (firstDot > 0) {
    // Try compound: everything from the first dot onward, minus the leading dot.
    const compoundExt = name.slice(firstDot + 1).toLowerCase();
    if (EXTENSION_LANGUAGE_MAP[compoundExt]) return EXTENSION_LANGUAGE_MAP[compoundExt];

    // Try the last extension (e.g. `.yaml` from `.ci.yaml`).
    const lastDot = name.lastIndexOf(".");
    if (lastDot > 0) {
      const ext = name.slice(lastDot + 1).toLowerCase();
      if (EXTENSION_LANGUAGE_MAP[ext]) return EXTENSION_LANGUAGE_MAP[ext];
    }
  }

  // 3. Fallback.
  return "plaintext";
}
