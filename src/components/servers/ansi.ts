/**
 * Minimal ANSI SGR (color) parser — converts a log line containing CSI color
 * sequences into styled React spans.
 *
 * Servers commonly emit ANSI codes (e.g. `node`, `next`, `pytest` with color).
 * Rather than pull a dependency, this handles the common 8-color foreground
 * set (30-37) + bright (90-97), plus bold/dim, mapping them onto hex values
 * tuned for the kern dark palette.
 */

type StyleState = {
  color?: string;
  bold?: boolean;
  dim?: boolean;
};

interface Segment {
  text: string;
  style: StyleState;
}

const FG: Record<number, string> = {
  30: "#4c525e", // black → grid gray (signal-low)
  31: "#f54c4c", // red → fault-vector
  32: "#4cf5a0", // green → signal-high
  33: "#f5a04c", // yellow → warn-vector
  34: "#5c8cff", // blue
  35: "#c77dff", // magenta
  36: "#4cd8f5", // cyan
  37: "#c8ccd4", // white → soft zinc
};

const RESET = "#c8ccd4";

/**
 * Parses a single line into colored segments. Unknown SGR codes are ignored
 * gracefully — text always renders.
 */
export function parseAnsi(line: string): Segment[] {
  const segments: Segment[] = [];
  let current: StyleState = {};
  let buf = "";

  const flush = () => {
    if (buf) {
      segments.push({ text: buf, style: { ...current } });
      buf = "";
    }
  };

  // Match CSI sequences: \x1b[ ... m
  const regex = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    // Text before this escape.
    buf += line.slice(lastIndex, match.index);
    flush();

    const params = match[1] === "" ? ["0"] : match[1].split(";");
    for (const p of params) {
      applySgr(Number(p), current);
    }

    lastIndex = regex.lastIndex;
  }

  // Trailing text after the last escape.
  buf += line.slice(lastIndex);
  flush();

  return segments.length ? segments : [{ text: line, style: {} }];
}

function applySgr(code: number, state: StyleState) {
  switch (code) {
    case 0:
      state.color = undefined;
      state.bold = undefined;
      state.dim = undefined;
      break;
    case 1:
      state.bold = true;
      break;
    case 2:
      state.dim = true;
      break;
    case 22:
      state.bold = undefined;
      state.dim = undefined;
      break;
    default:
      // 30-37 standard, 90-97 bright (treated the same here)
      if (FG[code]) state.color = FG[code];
      else if (FG[code - 60]) state.color = FG[code - 60];
      else if (code === 39) state.color = undefined; // default fg
      break;
  }
}

/** Default foreground for a segment with no explicit color. */
export const DEFAULT_FG = RESET;

/**
 * Dim zinc used solely for timestamp prefixes (`[HH:MM:SS]`). Kept distinct so
 * the body of a line reads at full contrast while the time recedes visually.
 */
export const TS_COLOR = "#6b7280";

/**
 * Matches a leading wall-clock timestamp, liberal on purpose so we never double-
 * stamp a line that already carries one.
 *
 * Accepts: `[HH:MM:SS]`, `[H:MM:SS]`, `[14:32:07]`, `[2:32:07 PM]`,
 * `14:32:07`, and sub-second variants `[14:32:07.123]`. Case-insensitive.
 */
const TIMESTAMP_RE = /^\s*\[?\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(?:[AP]M?)?\]?\s*/i;

/**
 * Splits a log line into its leading timestamp prefix (if any) and the rest of
 * the line. When no leading timestamp is found, `prefix` is empty and `rest`
 * is the original line untouched — callers can use either field.
 */
export function parseTimestamp(line: string): {
  prefix: string;
  rest: string;
} {
  const match = TIMESTAMP_RE.exec(line);
  if (!match) return { prefix: "", rest: line };
  return { prefix: match[0], rest: line.slice(match[0].length) };
}

/**
 * Inspects the start of `line` to guess its log level, then returns a tint
 * color for the whole line. ANSI codes inside the line still override this
 * per-segment, so the level tint is just a base layer, never destructive.
 *
 * Keywords are matched case-insensitively. "error" wins over "warn" — if a line
 * says both, the louder level paints it.
 */
const LEVEL_RULES: Array<{
  level: string;
  color: string;
  keywords: string[];
}> = [
  { level: "error", color: "#f54c4c", keywords: ["error", "exception", "fatal", "failed", "panic", "severe"] },
  { level: "warn", color: "#f5a04c", keywords: ["warn", "caution", "deprecated"] },
  { level: "success", color: "#4cf5a0", keywords: ["done", "started", "ready", "listening", "loaded", "joined"] },
];

const TINT_NONE = "inherit";

export function classifyLevelColor(line: string): string {
  // Search the body (past any leading timestamp) so phrases prefixed by a
  // timestamp don't skew detection.
  const body = parseTimestamp(line).rest;
  const haystack = body.toLowerCase();
  for (const rule of LEVEL_RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw)) return rule.color;
    }
  }
  return TINT_NONE;
}
