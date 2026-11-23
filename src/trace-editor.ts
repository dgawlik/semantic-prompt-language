import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// ANSI Color & Terminal Primitives (Zero External Dependencies)
// ============================================================================

const ESC = "\x1b";
const CSI = `${ESC}[`;

const ANSI = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  inverse: `${CSI}7m`,
  fg: {
    black: `${CSI}30m`,
    red: `${CSI}31m`,
    green: `${CSI}32m`,
    yellow: `${CSI}33m`,
    blue: `${CSI}34m`,
    magenta: `${CSI}35m`,
    cyan: `${CSI}36m`,
    white: `${CSI}37m`,
    gray: `${CSI}90m`,
    brightRed: `${CSI}91m`,
    brightGreen: `${CSI}92m`,
    brightYellow: `${CSI}93m`,
    brightBlue: `${CSI}94m`,
    brightMagenta: `${CSI}95m`,
    brightCyan: `${CSI}96m`,
    brightWhite: `${CSI}97m`,
  },
  bg: {
    black: `${CSI}40m`,
    red: `${CSI}41m`,
    green: `${CSI}42m`,
    yellow: `${CSI}43m`,
    blue: `${CSI}44m`,
    magenta: `${CSI}45m`,
    cyan: `${CSI}46m`,
    white: `${CSI}47m`,
    gray: `${CSI}100m`,
    selection: `${CSI}48;5;238m`,
    selectionActive: `${CSI}48;5;24m`,
    header: `${CSI}48;5;235m`,
    status: `${CSI}48;5;234m`,
    errorBg: `${CSI}48;5;52m`,
    okBg: `${CSI}48;5;22m`,
  },
};

const ANSI_STRIP_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_STRIP_RE, "");
}

export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate an ANSI-colored string to `maxCols` visible characters, always resetting styling. */
export function truncateAnsi(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  let vis = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC && s[i + 1] === "[") {
      let j = i + 2;
      while (j < s.length && !/[A-Za-z]/.test(s[j])) j++;
      if (j < s.length) j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (vis >= maxCols) break;
    out += s[i];
    vis++;
    i++;
  }
  return out + ANSI.reset;
}

export function padAnsi(s: string, width: number): string {
  const len = visibleLength(s);
  if (len >= width) return truncateAnsi(s, width);
  return s + " ".repeat(width - len);
}

/** Apply a persistent background color across a string that may contain inner `ANSI.reset` sequences. */
function withBg(s: string, bg: string): string {
  if (!bg) return s;
  return bg + s.replace(/\x1b\[0m/g, `${ANSI.reset}${bg}`);
}

/**
 * Wrap an ANSI-styled single line strictly within `maxCols` visible characters,
 * preserving active ANSI SGR colors across wrapped lines.
 * - `preferWordBreak = true` (inspector / static view): prefers breaking at spaces near the edge.
 * - `preferWordBreak = false` (editor): exact fixed-width wrap so logical `(row, col)` maps 1:1 to visual `(vRow, vCol)`.
 */
export function wrapAnsiLine(s: string, maxCols: number, preferWordBreak = false): string[] {
  const width = Math.max(1, maxCols);
  if (visibleLength(s) <= width) return [s];

  // Tokenize into visible characters paired with any leading ANSI escape codes
  const tokens: { esc: string; ch: string }[] = [];
  let pendingEsc = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC && s[i + 1] === "[") {
      let j = i + 2;
      while (j < s.length && !/[A-Za-z]/.test(s[j])) j++;
      if (j < s.length) j++;
      pendingEsc += s.slice(i, j);
      i = j;
      continue;
    }
    tokens.push({ esc: pendingEsc, ch: s[i] });
    pendingEsc = "";
    i++;
  }

  if (tokens.length === 0) return [s];

  const updateSgr = (active: string, esc: string): string => {
    if (!esc) return active;
    let cur = active;
    let k = 0;
    while (k < esc.length) {
      if (esc[k] === ESC && esc[k + 1] === "[") {
        let m = k + 2;
        while (m < esc.length && !/[A-Za-z]/.test(esc[m])) m++;
        if (m < esc.length) m++;
        const seq = esc.slice(k, m);
        if (seq === ANSI.reset || seq === `${CSI}m`) {
          cur = "";
        } else if (seq.endsWith("m")) {
          cur += seq;
        }
        k = m;
      } else {
        k++;
      }
    }
    return cur;
  };

  const out: string[] = [];
  let activeSgr = "";
  let pos = 0;

  while (pos < tokens.length) {
    let take = Math.min(width, tokens.length - pos);
    if (preferWordBreak && pos + take < tokens.length && width >= 12) {
      // Look backwards for a space within the trailing third of the line
      const minBreak = Math.max(1, Math.floor(width * 0.6));
      for (let b = take - 1; b >= minBreak; b--) {
        if (tokens[pos + b].ch === " ") {
          take = b + 1;
          break;
        }
      }
    }

    let lineStr = activeSgr;
    for (let k = 0; k < take; k++) {
      const tok = tokens[pos + k];
      if (tok.esc) {
        lineStr += tok.esc;
        activeSgr = updateSgr(activeSgr, tok.esc);
      }
      lineStr += tok.ch;
    }
    lineStr += ANSI.reset;
    out.push(lineStr);
    pos += take;
  }

  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ============================================================================
// Trace JSONL Data Model
// ============================================================================

export interface TraceEntry {
  id: number;
  data: unknown;
  rawLine: string;
  parseError?: string;
}

export type TraceEventTemplateKind =
  | "user_prompt"
  | "thinking"
  | "assistant_text"
  | "tool_call"
  | "tool_decision"
  | "tool_result"
  | "turn_completed"
  | "warning"
  | "meta";

export const TRACE_TEMPLATE_KINDS: readonly TraceEventTemplateKind[] = [
  "user_prompt",
  "thinking",
  "assistant_text",
  "tool_call",
  "tool_decision",
  "tool_result",
  "turn_completed",
  "warning",
  "meta",
];

export function createTemplateForKind(kind: TraceEventTemplateKind, nextTurn = 1): Record<string, unknown> {
  switch (kind) {
    case "meta":
      return {
        kind: "meta",
        version: 1,
        provider: "openai_responses",
        model: "gpt-6-luna",
        turns: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_duration_ms: 0,
        finish_reason: "completed",
        warnings: [],
      };
    case "user_prompt":
      return { kind: "user_prompt", content: "" };
    case "thinking":
      return { kind: "thinking", turn: nextTurn, text: "" };
    case "assistant_text":
      return { kind: "assistant_text", turn: nextTurn, text: "" };
    case "tool_call":
      return { kind: "tool_call", turn: nextTurn, id: `call_${Date.now()}`, name: "", arguments: {} };
    case "tool_decision":
      return {
        kind: "tool_decision",
        turn: nextTurn,
        id: `call_${Date.now()}`,
        name: "",
        decision: "approved",
        arguments: {},
      };
    case "tool_result":
      return {
        kind: "tool_result",
        turn: nextTurn,
        id: `call_${Date.now()}`,
        name: "",
        output: "{}",
        succeeded: true,
      };
    case "turn_completed":
      return {
        kind: "turn_completed",
        turn: nextTurn,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        finish_reason: "completed",
      };
    case "warning":
      return { kind: "warning", turn: nextTurn, message: "" };
  }
}

let nextEntryId = 1;

export function parseTraceJsonl(text: string): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed);
      entries.push({ id: nextEntryId++, data, rawLine: trimmed });
    } catch (err) {
      entries.push({
        id: nextEntryId++,
        data: null,
        rawLine: trimmed,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return entries;
}

export function serializeTraceJsonl(entries: readonly TraceEntry[]): string {
  if (entries.length === 0) return "";
  return (
    entries
      .map((e) => (e.parseError ? e.rawLine : JSON.stringify(e.data)))
      .join("\n") + "\n"
  );
}

export function getEntryKind(entry: TraceEntry): string {
  if (entry.parseError) return "invalid";
  if (entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
    const k = (entry.data as Record<string, unknown>).kind;
    if (typeof k === "string" && k.trim() !== "") return k;
  }
  return "json";
}

function oneLinePreview(s: string, maxLen = 80): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 1)) + "…";
}

export function summarizeEntry(entry: TraceEntry): string {
  if (entry.parseError) {
    return `Parse error: ${oneLinePreview(entry.parseError, 60)}`;
  }
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) {
    return oneLinePreview(JSON.stringify(entry.data), 80);
  }
  const obj = entry.data as Record<string, unknown>;
  const kind = getEntryKind(entry);
  const turnPrefix = typeof obj.turn === "number" ? `T${obj.turn} ` : "";

  switch (kind) {
    case "meta": {
      const prov = typeof obj.provider === "string" ? obj.provider : "?";
      const model = typeof obj.model === "string" ? obj.model : "?";
      const turns = typeof obj.turns === "number" ? `${obj.turns}t` : "";
      const tok =
        typeof obj.total_input_tokens === "number" || typeof obj.total_output_tokens === "number"
          ? `${obj.total_input_tokens ?? 0}→${obj.total_output_tokens ?? 0}tok`
          : "";
      return oneLinePreview([`${prov}/${model}`, turns, tok].filter(Boolean).join(" · "), 80);
    }
    case "user_prompt":
      return oneLinePreview(String(obj.content ?? ""), 80);
    case "thinking":
      return `${turnPrefix}${oneLinePreview(String(obj.text ?? ""), 72)}`;
    case "assistant_text":
      return `${turnPrefix}${oneLinePreview(String(obj.text ?? ""), 72)}`;
    case "tool_call": {
      const name = String(obj.name ?? "?");
      const args = obj.arguments !== undefined ? JSON.stringify(obj.arguments) : "";
      return `${turnPrefix}${name}(${oneLinePreview(args, 55)})`;
    }
    case "tool_decision": {
      const name = String(obj.name ?? "?");
      const dec = String(obj.decision ?? "?");
      return `${turnPrefix}${name} -> ${dec}`;
    }
    case "tool_result": {
      const name = String(obj.name ?? "?");
      const ok = obj.succeeded === false ? "ERR" : "OK";
      return `${turnPrefix}[${ok}] ${name}: ${oneLinePreview(String(obj.output ?? ""), 55)}`;
    }
    case "turn_completed": {
      const inp = obj.input_tokens ?? 0;
      const out = obj.output_tokens ?? 0;
      const dur = obj.duration_ms ?? 0;
      const fin = String(obj.finish_reason ?? "");
      return `${turnPrefix}${inp}→${out} tok · ${dur}ms · ${fin}`;
    }
    case "warning":
      return `${turnPrefix}${oneLinePreview(String(obj.message ?? ""), 72)}`;
    default:
      return oneLinePreview(JSON.stringify(obj), 80);
  }
}

export function badgeForKind(kind: string, entry?: TraceEntry): { label: string; color: string } {
  switch (kind) {
    case "meta":
      return { label: "META  ", color: ANSI.bold + ANSI.fg.magenta };
    case "user_prompt":
      return { label: "PROMPT", color: ANSI.bold + ANSI.fg.brightCyan };
    case "thinking":
      return { label: "THINK ", color: ANSI.fg.brightMagenta };
    case "assistant_text":
      return { label: "TEXT  ", color: ANSI.bold + ANSI.fg.brightGreen };
    case "tool_call":
      return { label: "CALL  ", color: ANSI.bold + ANSI.fg.brightYellow };
    case "tool_decision": {
      const dec =
        entry?.data && typeof entry.data === "object"
          ? String((entry.data as Record<string, unknown>).decision ?? "")
          : "";
      const col = dec.startsWith("rejected")
        ? ANSI.bold + ANSI.fg.brightRed
        : dec === "modified"
          ? ANSI.bold + ANSI.fg.yellow
          : ANSI.fg.brightBlue;
      return { label: "DECIDE", color: col };
    }
    case "tool_result": {
      const ok =
        entry?.data && typeof entry.data === "object"
          ? (entry.data as Record<string, unknown>).succeeded !== false
          : true;
      return {
        label: "RESULT",
        color: ok ? ANSI.fg.green : ANSI.bold + ANSI.fg.brightRed,
      };
    }
    case "turn_completed":
      return { label: "TURN  ", color: ANSI.fg.cyan };
    case "warning":
      return { label: "WARN  ", color: ANSI.bold + ANSI.fg.yellow };
    case "invalid":
      return { label: "ERROR ", color: ANSI.bold + ANSI.fg.brightRed };
    default:
      return { label: kind.slice(0, 6).toUpperCase().padEnd(6), color: ANSI.fg.white };
  }
}

/** Expand embedded JSON strings (like `tool_result.output: "{\"product\":391}"`) for pretty viewing. */
export function expandEmbeddedJson(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEmbeddedJson(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEmbeddedJson(v);
    }
    return out;
  }
  return value;
}

export function formatEntryPrettyJson(entry: TraceEntry, expandEmbedded = false): string {
  if (entry.parseError) return entry.rawLine;
  const val = expandEmbedded ? expandEmbeddedJson(entry.data) : entry.data;
  return JSON.stringify(val, null, 2);
}

/** Syntax-highlight one line of pretty-printed JSON with ANSI colors. */
export function highlightJsonLine(line: string): string {
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    if (ch === " " || ch === "\t") {
      out += ch;
      i++;
      continue;
    }

    // JSON String (check if followed by ':' to color object keys differently)
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      const token = line.slice(i, j);
      let k = j;
      while (k < n && (line[k] === " " || line[k] === "\t")) k++;
      const isKey = line[k] === ":";
      out += (isKey ? ANSI.fg.brightCyan : ANSI.fg.green) + token + ANSI.reset;
      i = j;
      continue;
    }

    // Numbers
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const m = line.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (m) {
        out += ANSI.fg.brightYellow + m[0] + ANSI.reset;
        i += m[0].length;
        continue;
      }
    }

    // Booleans / null
    if (line.startsWith("true", i) && !/[A-Za-z0-9_]/.test(line[i + 4] ?? "")) {
      out += ANSI.fg.brightMagenta + "true" + ANSI.reset;
      i += 4;
      continue;
    }
    if (line.startsWith("false", i) && !/[A-Za-z0-9_]/.test(line[i + 5] ?? "")) {
      out += ANSI.fg.brightMagenta + "false" + ANSI.reset;
      i += 5;
      continue;
    }
    if (line.startsWith("null", i) && !/[A-Za-z0-9_]/.test(line[i + 4] ?? "")) {
      out += ANSI.dim + ANSI.fg.red + "null" + ANSI.reset;
      i += 4;
      continue;
    }

    // Punctuation
    if ("{}[]:,".includes(ch)) {
      out += ANSI.fg.gray + ch + ANSI.reset;
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

// ============================================================================
// JS & SPL Pretty Printers & Syntax Highlighters (Zero Dependencies)
// ============================================================================

export type TraceViewFormat = "pretty" | "json" | "js" | "spl";

export const TRACE_VIEW_FORMATS: readonly TraceViewFormat[] = ["pretty", "json", "js", "spl"];

const JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "finally", "for", "from",
  "function", "if", "import", "in", "instanceof", "let", "new", "of", "return",
  "static", "super", "switch", "this", "throw", "try", "typeof", "var", "void",
  "while", "with", "yield",
]);

const JS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const JS_BUILTINS = new Set([
  "Array", "Boolean", "Date", "Error", "JSON", "Map", "Math", "Number",
  "Object", "Promise", "RegExp", "Set", "String", "Symbol", "console",
]);

const SPL_KEYWORDS = new Set([
  "as", "else", "enum", "extern", "fn", "for", "from", "if", "impl", "import",
  "in", "let", "match", "mut", "pub", "reified", "return", "struct", "trait",
  "type", "while",
]);

const SPL_LITERALS = new Set(["true", "false", "None"]);

const VALID_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Lightweight zero-dep code formatter for single-line or messy JS/SPL snippets. */
export function formatCodeSnippet(code: string, lang: "js" | "spl"): string {
  const trimmed = code.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "";
  // If already multi-line, normalize indentation cleanly
  const rawLines = trimmed.includes("\n")
    ? trimmed.split("\n")
    : splitSingleLineCode(trimmed, lang);

  const out: string[] = [];
  let depth = 0;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const leadingCloses = countLeadingCloses(line);
    depth = Math.max(0, depth - leadingCloses);
    out.push("  ".repeat(depth) + line);
    const delta = braceBalanceDelta(line) + leadingCloses;
    depth = Math.max(0, depth + delta);
  }
  return out.join("\n");
}

function splitSingleLineCode(code: string, lang: "js" | "spl"): string[] {
  const lines: string[] = [];
  let cur = "";
  let inStr: string | null = null;
  let parenDepth = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      cur += ch;
      if (ch === "\\" && i + 1 < code.length) {
        cur += code[++i];
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || (lang === "js" && ch === "`")) {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);

    if (ch === ";" && parenDepth === 0) {
      cur += ch;
      lines.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "{" && parenDepth === 0) {
      cur += ch;
      lines.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "}" && parenDepth === 0) {
      if (cur.trim()) {
        lines.push(cur.trim());
        cur = "";
      }
      if (code[i + 1] === ";") {
        lines.push("};");
        i++;
      } else {
        lines.push("}");
      }
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

function countLeadingCloses(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "}" || line[i] === "]") count++;
    else break;
  }
  return count;
}

function braceBalanceDelta(line: string): number {
  let delta = 0;
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "'" && line[i + 1] === "'") break;
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{" || ch === "[") delta++;
    else if (ch === "}" || ch === "]") delta--;
  }
  return delta;
}

/** Syntax-highlight one line of JavaScript with ANSI colors. */
export function highlightJsLine(line: string): string {
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    // Line comment
    if (ch === "/" && line[i + 1] === "/") {
      out += ANSI.dim + ANSI.fg.gray + line.slice(i) + ANSI.reset;
      break;
    }
    // Block comment (single-line portion)
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const slice = end === -1 ? line.slice(i) : line.slice(i, end + 2);
      out += ANSI.dim + ANSI.fg.gray + slice + ANSI.reset;
      i += slice.length;
      continue;
    }
    // String or template literal
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      out += ANSI.fg.green + line.slice(i, j) + ANSI.reset;
      i = j;
      continue;
    }
    // Number
    if ((ch >= "0" && ch <= "9") || (ch === "-" && line[i + 1] >= "0" && line[i + 1] <= "9" && (i === 0 || /[\s([:,=+\-*/<>!&|?]/.test(line[i - 1])))) {
      const m = line.slice(i).match(/^-?(?:0x[0-9a-fA-F_]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (m) {
        out += ANSI.fg.brightYellow + m[0] + ANSI.reset;
        i += m[0].length;
        continue;
      }
    }
    // Identifier / keyword / object property key
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && line[k] === " ") k++;
      const isObjKey = line[k] === ":" && line[k + 1] !== ":";
      const isCall = line[k] === "(";

      if (JS_KEYWORDS.has(word)) {
        out += ANSI.bold + ANSI.fg.brightMagenta + word + ANSI.reset;
      } else if (JS_LITERALS.has(word)) {
        out += ANSI.fg.brightMagenta + word + ANSI.reset;
      } else if (JS_BUILTINS.has(word)) {
        out += ANSI.fg.brightCyan + word + ANSI.reset;
      } else if (isObjKey) {
        out += ANSI.fg.cyan + word + ANSI.reset;
      } else if (isCall) {
        out += ANSI.fg.brightBlue + word + ANSI.reset;
      } else {
        out += word;
      }
      i = j;
      continue;
    }
    // Arrows & punctuation
    if (ch === "=" && line[i + 1] === ">") {
      out += ANSI.bold + ANSI.fg.brightCyan + "=>" + ANSI.reset;
      i += 2;
      continue;
    }
    if ("{}[]():,;".includes(ch)) {
      out += ANSI.fg.gray + ch + ANSI.reset;
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Syntax-highlight one line of SPL (`.splx`) with ANSI colors. */
export function highlightSplLine(line: string): string {
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    // `///` doc comment or `//` regular comment
    if (ch === "/" && line[i + 1] === "/") {
      const isDoc = line[i + 2] === "/";
      out += (isDoc ? ANSI.fg.cyan : ANSI.dim + ANSI.fg.gray) + line.slice(i) + ANSI.reset;
      break;
    }
    // `''` LLM schema hint comment
    if (ch === "'" && line[i + 1] === "'") {
      out += ANSI.italic + ANSI.fg.brightYellow + line.slice(i) + ANSI.reset;
      break;
    }
    // Prompt delimiter `@{`
    if (ch === "@" && line[i + 1] === "{") {
      out += ANSI.bold + ANSI.fg.brightCyan + "@{" + ANSI.reset;
      i += 2;
      continue;
    }
    // String literal (highlighting `${...}` interpolations)
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      const rawStr = line.slice(i, j);
      const coloredStr = rawStr.replace(
        /\$\{([^}]*)\}/g,
        `${ANSI.bold}${ANSI.fg.brightCyan}\${${ANSI.fg.white}$1${ANSI.fg.brightCyan}}${ANSI.reset}${ANSI.fg.green}`
      );
      out += ANSI.fg.green + coloredStr + ANSI.reset;
      i = j;
      continue;
    }
    // Char literal
    if (ch === "'") {
      let j = i + 1;
      if (line[j] === "\\") j += 2;
      else j++;
      if (line[j] === "'") j++;
      out += ANSI.fg.green + line.slice(i, j) + ANSI.reset;
      i = j;
      continue;
    }
    // Numbers
    if ((ch >= "0" && ch <= "9") || (ch === "-" && line[i + 1] >= "0" && line[i + 1] <= "9" && (i === 0 || /[\s([:,=+\-*/<>!&|?]/.test(line[i - 1])))) {
      const m = line.slice(i).match(/^-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/);
      if (m) {
        out += ANSI.fg.brightYellow + m[0] + ANSI.reset;
        i += m[0].length;
        continue;
      }
    }
    // Operators `->`, `=>`, `??`, `?.`, `..=`, `..`
    if ((ch === "-" && line[i + 1] === ">") || (ch === "=" && line[i + 1] === ">")) {
      out += ANSI.bold + ANSI.fg.brightCyan + line.slice(i, i + 2) + ANSI.reset;
      i += 2;
      continue;
    }
    if ((ch === "?" && (line[i + 1] === "?" || line[i + 1] === ".")) || (ch === "." && line[i + 1] === ".")) {
      const len = ch === "." && line[i + 2] === "=" ? 3 : 2;
      out += ANSI.fg.brightCyan + line.slice(i, i + len) + ANSI.reset;
      i += len;
      continue;
    }
    // Identifiers, keywords, PascalCase types/variants, named arg / record field labels
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && line[k] === " ") k++;
      const isField = line[k] === ":" && line[k + 1] !== ":";
      const isCall = line[k] === "(" || line[k] === "<";

      if (SPL_KEYWORDS.has(word)) {
        out += ANSI.bold + ANSI.fg.brightMagenta + word + ANSI.reset;
      } else if (SPL_LITERALS.has(word)) {
        out += ANSI.fg.brightMagenta + word + ANSI.reset;
      } else if (/^[A-Z]/.test(word)) {
        out += ANSI.bold + ANSI.fg.brightCyan + word + ANSI.reset;
      } else if (isField) {
        out += ANSI.fg.cyan + word + ANSI.reset;
      } else if (isCall) {
        out += ANSI.fg.brightBlue + word + ANSI.reset;
      } else {
        out += word;
      }
      i = j;
      continue;
    }
    if ("{}[]():,?".includes(ch)) {
      out += ANSI.fg.gray + ch + ANSI.reset;
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function formatJsValue(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const escaped = value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      return "`" + escaped + "`";
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${innerPad}${formatJsValue(v, indent + 1)}`);
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      const key = VALID_IDENT_RE.test(k) && !JS_KEYWORDS.has(k) ? k : JSON.stringify(k);
      return `${innerPad}${key}: ${formatJsValue(v, indent + 1)}`;
    });
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  return String(value);
}

/** Pretty-print a trace entry as idiomatic JavaScript. */
export function formatEntryAsJs(entry: TraceEntry, expandEmbedded = true): string {
  if (entry.parseError) {
    return `// Invalid JSON: ${entry.parseError}\n${entry.rawLine}`;
  }
  const val = expandEmbedded ? expandEmbeddedJson(entry.data) : entry.data;
  const kind = getEntryKind(entry);
  const varName = kind === "meta" ? "traceMeta" : `step_${kind}`;
  return `// Trace record (${kind})\nexport const ${varName} = ${formatJsValue(val, 0)};`;
}

function formatSplStringOrPrompt(s: string, indent = 0): string {
  if (!s.includes("\n")) return JSON.stringify(s);
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  const body = s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((ln) => `${inner}${ln}`)
    .join("\n");
  return `@{\n${body}\n${pad}}`;
}

function formatSplValue(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return formatSplStringOrPrompt(value, indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${innerPad}${formatSplValue(v, indent + 1)}`);
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      const key = VALID_IDENT_RE.test(k) ? k : JSON.stringify(k);
      return `${innerPad}${key}: ${formatSplValue(v, indent + 1)}`;
    });
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  return String(value);
}

/** Pretty-print a trace entry as idiomatic SPL (`.splx`) `traces.TraceEvent` / `ExecutionTrace` syntax. */
export function formatEntryAsSpl(entry: TraceEntry, expandEmbedded = true): string {
  if (entry.parseError) {
    return `// Invalid JSON: ${entry.parseError}\n${entry.rawLine}`;
  }
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) {
    return `let value = ${formatSplValue(entry.data, 0)}`;
  }
  const raw = entry.data as Record<string, unknown>;
  const obj = (expandEmbedded ? expandEmbeddedJson(raw) : raw) as Record<string, unknown>;
  const kind = getEntryKind(entry);

  switch (kind) {
    case "meta": {
      const fields: [string, unknown][] = [
        ["provider", obj.provider ?? "openai_responses"],
        ["model", obj.model ?? "gpt-6-luna"],
        ["turns", obj.turns ?? 0],
        ["total_input_tokens", obj.total_input_tokens ?? 0],
        ["total_output_tokens", obj.total_output_tokens ?? 0],
        ["total_duration_ms", obj.total_duration_ms ?? 0],
        ["finish_reason", obj.finish_reason ?? "completed"],
        ["warnings", obj.warnings ?? []],
      ];
      const body = fields.map(([k, v]) => `  ${k}: ${formatSplValue(v, 1)}`).join(",\n");
      return `// ExecutionTrace metadata (std/traces)\nlet meta = {\n${body}\n}`;
    }
    case "user_prompt":
      return `// TraceEvent.UserPrompt\nUserPrompt(\n  ${formatSplStringOrPrompt(String(raw.content ?? ""), 1)}\n)`;
    case "thinking":
      return `// TraceEvent.ThinkingStep\nThinkingStep(\n  ${Number(obj.turn ?? 1)},\n  ${formatSplStringOrPrompt(String(raw.text ?? ""), 1)}\n)`;
    case "assistant_text":
      return `// TraceEvent.AssistantText\nAssistantText(\n  ${Number(obj.turn ?? 1)},\n  ${formatSplStringOrPrompt(String(raw.text ?? ""), 1)}\n)`;
    case "tool_call":
      return `// TraceEvent.ToolCallStep\nToolCallStep(\n  ${Number(obj.turn ?? 1)},\n  ${JSON.stringify(String(obj.id ?? ""))},\n  ${JSON.stringify(String(obj.name ?? ""))},\n  ${formatSplValue(obj.arguments ?? {}, 1)}\n)`;
    case "tool_decision":
      return `// TraceEvent.ToolDecisionStep\nToolDecisionStep(\n  ${Number(obj.turn ?? 1)},\n  ${JSON.stringify(String(obj.id ?? ""))},\n  ${JSON.stringify(String(obj.name ?? ""))},\n  ${JSON.stringify(String(obj.decision ?? ""))},\n  ${formatSplValue(obj.arguments ?? {}, 1)}\n)`;
    case "tool_result":
      return `// TraceEvent.ToolResultStep\nToolResultStep(\n  ${Number(obj.turn ?? 1)},\n  ${JSON.stringify(String(obj.id ?? ""))},\n  ${JSON.stringify(String(obj.name ?? ""))},\n  ${formatSplValue(expandEmbedded ? obj.output : String(raw.output ?? ""), 1)},\n  ${obj.succeeded === false ? "false" : "true"}\n)`;
    case "turn_completed":
      return `// TraceEvent.TurnCompleted\nTurnCompleted(\n  ${Number(obj.turn ?? 1)},\n  ${Number(obj.input_tokens ?? 0)},\n  ${Number(obj.output_tokens ?? 0)},\n  ${Number(obj.total_tokens ?? 0)},\n  ${Number(obj.duration_ms ?? 0)},\n  ${JSON.stringify(String(obj.finish_reason ?? ""))}\n)`;
    case "warning":
      return `// TraceEvent.WarningStep\nWarningStep(\n  ${Number(obj.turn ?? 1)},\n  ${formatSplStringOrPrompt(String(raw.message ?? ""), 1)}\n)`;
    default:
      return `let record = ${formatSplValue(obj, 0)}`;
  }
}

export interface EmbeddedCodeBlock {
  path: string;
  lang: "js" | "spl";
  code: string;
}

function detectCodeLanguage(fieldName: string, text: string): "js" | "spl" | null {
  const key = fieldName.toLowerCase();
  const t = text.trim();
  if (!t || t.length < 8) return null;

  if (key === "spl" || key === "splx" || key === "spl_source") return "spl";
  if (key === "js" || key === "javascript" || key === "js_body") return "js";

  // Fenced code blocks handled separately; check raw code heuristics
  const hasSplCue =
    /\bpub\s+(?:reified\s+)?fn\b/.test(t) ||
    /\bfn\s+[a-zA-Z_]\w*\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?:->|\{)/.test(t) ||
    /\btype\s+[A-Z]\w*\s*=\s*(?:struct\s*\{|\{)/.test(t) ||
    /@\{[\s\S]*\}/.test(t);
  if (hasSplCue) return "spl";

  const hasJsCue =
    /\b(?:const|let|var|function|return)\b/.test(t) &&
    (/[;{}]/.test(t) || /=>/.test(t));
  if (hasJsCue && (key === "body" || key === "code" || key === "source" || key === "script" || t.includes("\n") || t.includes(";"))) {
    return "js";
  }
  return null;
}

/** Extract any embedded JS or SPL code snippets (fenced or raw code fields) from a trace record. */
export function extractEmbeddedCodeBlocks(value: unknown, prefix = ""): EmbeddedCodeBlock[] {
  const blocks: EmbeddedCodeBlock[] = [];
  if (typeof value === "string") {
    // 1. Markdown fenced code blocks (```js, ```ts, ```spl, ```splx)
    const fenceRe = /```(js|javascript|mjs|ts|spl|splx)\s*\r?\n([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    let foundFence = false;
    while ((m = fenceRe.exec(value)) !== null) {
      foundFence = true;
      const rawLang = m[1].toLowerCase();
      const lang: "js" | "spl" = rawLang === "spl" || rawLang === "splx" ? "spl" : "js";
      blocks.push({ path: prefix || "text", lang, code: formatCodeSnippet(m[2], lang) });
    }
    if (!foundFence) {
      const fieldName = prefix.split(".").pop() ?? "";
      const detected = detectCodeLanguage(fieldName, value);
      if (detected) {
        blocks.push({ path: prefix || "value", lang: detected, code: formatCodeSnippet(value, detected) });
      }
    }
    return blocks;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      blocks.push(...extractEmbeddedCodeBlocks(value[i], `${prefix}[${i}]`));
    }
    return blocks;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      blocks.push(...extractEmbeddedCodeBlocks(v, prefix ? `${prefix}.${k}` : k));
    }
  }
  return blocks;
}

/** Render highlighted lines for a single trace entry in any view format (`pretty`, `json`, `js`, `spl`), soft-wrapped to `maxWidth`. */
export function renderEntryInspectorLines(
  entry: TraceEntry,
  format: TraceViewFormat,
  expandEmbedded = true,
  maxWidth = 80
): string[] {
  const safeWidth = Math.max(16, maxWidth);
  if (entry.parseError) {
    const errHeader = wrapAnsiLine(
      `${ANSI.bg.errorBg}${ANSI.fg.brightRed} Invalid JSON: ${entry.parseError} ${ANSI.reset}`,
      safeWidth,
      true
    );
    const errBody = wrapAnsiLine(ANSI.fg.red + entry.rawLine + ANSI.reset, safeWidth, false);
    return [...errHeader, "", ...errBody];
  }

  const numbered = (rawLines: string[], highlighter: (ln: string) => string): string[] => {
    const numW = Math.max(2, String(rawLines.length).length);
    const prefixCols = 1 + numW + 1; // " " + lineNo + " "
    const contentWidth = Math.max(8, safeWidth - prefixCols);
    const contPrefix = ` ${ANSI.fg.gray}${" ".repeat(Math.max(0, numW - 1))}· ${ANSI.reset}`;
    const result: string[] = [];

    for (let idx = 0; idx < rawLines.length; idx++) {
      const highlighted = highlighter(rawLines[idx]);
      const wrapped = wrapAnsiLine(highlighted, contentWidth, true);
      const firstPrefix = ` ${ANSI.fg.gray}${String(idx + 1).padStart(numW)} ${ANSI.reset}`;
      for (let wi = 0; wi < wrapped.length; wi++) {
        result.push((wi === 0 ? firstPrefix : contPrefix) + wrapped[wi]);
      }
    }
    return result;
  };

  if (format === "js") {
    return numbered(formatEntryAsJs(entry, expandEmbedded).split("\n"), highlightJsLine);
  }
  if (format === "spl") {
    return numbered(formatEntryAsSpl(entry, expandEmbedded).split("\n"), highlightSplLine);
  }
  if (format === "json") {
    return numbered(formatEntryPrettyJson(entry, false).split("\n"), highlightJsonLine);
  }

  // Default `"pretty"` mode: pretty JSON (with optional nested JSON expansion) + embedded JS/SPL code previews
  const lines = numbered(formatEntryPrettyJson(entry, expandEmbedded).split("\n"), highlightJsonLine);
  const codeBlocks = extractEmbeddedCodeBlocks(expandEmbedded ? expandEmbeddedJson(entry.data) : entry.data);
  for (const blk of codeBlocks) {
    const langTag = blk.lang === "spl" ? "SPL" : "JS";
    const hdrLabel = ` ── ${langTag} Preview (${blk.path}) `;
    const dashes = "─".repeat(Math.max(2, safeWidth - hdrLabel.length - 1));
    lines.push("");
    lines.push(truncateAnsi(`${ANSI.bold}${ANSI.fg.brightCyan}${hdrLabel}${dashes}${ANSI.reset}`, safeWidth));
    const hl = blk.lang === "spl" ? highlightSplLine : highlightJsLine;
    lines.push(...numbered(blk.code.split("\n"), hl));
  }
  return lines;
}

// ============================================================================
// Trace Document with Undo / Redo & Meta Recalculation
// ============================================================================

interface TraceSnapshot {
  entries: TraceEntry[];
  selectedIndex: number;
}

function cloneEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.map((e) => ({
    id: e.id,
    data: e.parseError ? null : JSON.parse(JSON.stringify(e.data)),
    rawLine: e.rawLine,
    parseError: e.parseError,
  }));
}

export class TraceDocument {
  public filePath: string;
  public entries: TraceEntry[];
  public dirty = false;
  private undoStack: TraceSnapshot[] = [];
  private redoStack: TraceSnapshot[] = [];

  constructor(filePath: string, entries: TraceEntry[]) {
    this.filePath = filePath;
    this.entries = entries;
  }

  static loadFromFile(filePath: string): TraceDocument {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      return new TraceDocument(abs, []);
    }
    const raw = fs.readFileSync(abs, "utf8");
    return new TraceDocument(abs, parseTraceJsonl(raw));
  }

  private pushUndo(selectedIndex: number): void {
    this.undoStack.push({ entries: cloneEntries(this.entries), selectedIndex });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  updateEntryJson(index: number, jsonText: string): { ok: true } | { ok: false; error: string } {
    if (index < 0 || index >= this.entries.length) {
      return { ok: false, error: "Entry index out of range" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.pushUndo(index);
    const prev = this.entries[index];
    this.entries[index] = {
      id: prev.id,
      data: parsed,
      rawLine: JSON.stringify(parsed),
    };
    return { ok: true };
  }

  insertEntryAfter(index: number, data: unknown): number {
    this.pushUndo(index);
    const insertAt = this.entries.length === 0 ? 0 : clamp(index + 1, 0, this.entries.length);
    const entry: TraceEntry = {
      id: nextEntryId++,
      data: JSON.parse(JSON.stringify(data)),
      rawLine: JSON.stringify(data),
    };
    this.entries.splice(insertAt, 0, entry);
    return insertAt;
  }

  duplicateEntry(index: number): number {
    if (index < 0 || index >= this.entries.length) return index;
    const src = this.entries[index];
    this.pushUndo(index);
    const copy: TraceEntry = {
      id: nextEntryId++,
      data: src.parseError ? null : JSON.parse(JSON.stringify(src.data)),
      rawLine: src.rawLine,
      parseError: src.parseError,
    };
    this.entries.splice(index + 1, 0, copy);
    return index + 1;
  }

  deleteEntry(index: number): number {
    if (index < 0 || index >= this.entries.length) return index;
    this.pushUndo(index);
    this.entries.splice(index, 1);
    return clamp(index, 0, Math.max(0, this.entries.length - 1));
  }

  moveEntry(index: number, delta: -1 | 1): number {
    const target = index + delta;
    if (index < 0 || index >= this.entries.length || target < 0 || target >= this.entries.length) {
      return index;
    }
    this.pushUndo(index);
    const tmp = this.entries[index];
    this.entries[index] = this.entries[target];
    this.entries[target] = tmp;
    return target;
  }

  recalculateMeta(selectedIndex: number): boolean {
    let turns = 0;
    let totalIn = 0;
    let totalOut = 0;
    let totalDur = 0;
    let finishReason = "completed";
    const warnings: string[] = [];

    for (const e of this.entries) {
      if (e.parseError || !e.data || typeof e.data !== "object") continue;
      const obj = e.data as Record<string, unknown>;
      if (obj.kind === "turn_completed") {
        if (typeof obj.turn === "number" && obj.turn > turns) turns = obj.turn;
        if (typeof obj.input_tokens === "number") totalIn += obj.input_tokens;
        if (typeof obj.output_tokens === "number") totalOut += obj.output_tokens;
        if (typeof obj.duration_ms === "number") totalDur += obj.duration_ms;
        if (typeof obj.finish_reason === "string") finishReason = obj.finish_reason;
      } else if (obj.kind === "warning" && typeof obj.message === "string") {
        warnings.push(obj.message);
      } else if (typeof obj.turn === "number" && obj.turn > turns) {
        turns = obj.turn;
      }
    }

    const metaIdx = this.entries.findIndex((e) => getEntryKind(e) === "meta");
    this.pushUndo(selectedIndex);
    if (metaIdx >= 0) {
      const prev = (this.entries[metaIdx].data as Record<string, unknown>) ?? {};
      const updated = {
        ...prev,
        kind: "meta",
        version: prev.version ?? 1,
        provider: prev.provider ?? "openai_responses",
        model: prev.model ?? "gpt-6-luna",
        turns,
        total_input_tokens: totalIn,
        total_output_tokens: totalOut,
        total_duration_ms: totalDur,
        finish_reason: finishReason,
        warnings,
      };
      this.entries[metaIdx] = {
        id: this.entries[metaIdx].id,
        data: updated,
        rawLine: JSON.stringify(updated),
      };
      return true;
    }

    const created = {
      kind: "meta",
      version: 1,
      provider: "openai_responses",
      model: "gpt-6-luna",
      turns,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      total_duration_ms: totalDur,
      finish_reason: finishReason,
      warnings,
    };
    this.entries.unshift({
      id: nextEntryId++,
      data: created,
      rawLine: JSON.stringify(created),
    });
    return true;
  }

  undo(currentSelected: number): number | null {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    this.redoStack.push({ entries: cloneEntries(this.entries), selectedIndex: currentSelected });
    this.entries = snap.entries;
    this.dirty = true;
    return clamp(snap.selectedIndex, 0, Math.max(0, this.entries.length - 1));
  }

  redo(currentSelected: number): number | null {
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push({ entries: cloneEntries(this.entries), selectedIndex: currentSelected });
    this.entries = snap.entries;
    this.dirty = true;
    return clamp(snap.selectedIndex, 0, Math.max(0, this.entries.length - 1));
  }

  getMetaSummary(): { provider?: string; model?: string; turns?: number; inputTokens?: number; outputTokens?: number; durationMs?: number } {
    const meta = this.entries.find((e) => getEntryKind(e) === "meta");
    if (!meta || meta.parseError || !meta.data || typeof meta.data !== "object") return {};
    const obj = meta.data as Record<string, unknown>;
    return {
      provider: typeof obj.provider === "string" ? obj.provider : undefined,
      model: typeof obj.model === "string" ? obj.model : undefined,
      turns: typeof obj.turns === "number" ? obj.turns : undefined,
      inputTokens: typeof obj.total_input_tokens === "number" ? obj.total_input_tokens : undefined,
      outputTokens: typeof obj.total_output_tokens === "number" ? obj.total_output_tokens : undefined,
      durationMs: typeof obj.total_duration_ms === "number" ? obj.total_duration_ms : undefined,
    };
  }

  save(targetPath = this.filePath): string {
    const abs = path.resolve(targetPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, serializeTraceJsonl(this.entries), "utf8");
    this.filePath = abs;
    this.dirty = false;
    return abs;
  }
}

// ============================================================================
// Multi-Line JSON Text Buffer (Zero-Dep Editor Core)
// ============================================================================

export class JsonTextBuffer {
  public lines: string[];
  public row = 0;
  public col = 0;
  public scrollTop = 0;

  constructor(initialText: string) {
    const split = initialText.replace(/\r\n/g, "\n").replace(/\t/g, "  ").split("\n");
    this.lines = split.length > 0 ? split : [""];
  }

  getText(): string {
    return this.lines.join("\n");
  }

  validateJson(): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      return { ok: true, value: JSON.parse(this.getText()) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  formatJson(): { ok: true } | { ok: false; error: string } {
    const check = this.validateJson();
    if (!check.ok) return check;
    const pretty = JSON.stringify(check.value, null, 2);
    this.lines = pretty.split("\n");
    this.row = clamp(this.row, 0, this.lines.length - 1);
    this.col = clamp(this.col, 0, this.lines[this.row].length);
    return { ok: true };
  }

  moveUp(count = 1): void {
    this.row = clamp(this.row - count, 0, this.lines.length - 1);
    this.col = clamp(this.col, 0, this.lines[this.row].length);
  }

  moveDown(count = 1): void {
    this.row = clamp(this.row + count, 0, this.lines.length - 1);
    this.col = clamp(this.col, 0, this.lines[this.row].length);
  }

  moveLeft(): void {
    if (this.col > 0) {
      this.col--;
    } else if (this.row > 0) {
      this.row--;
      this.col = this.lines[this.row].length;
    }
  }

  moveRight(): void {
    const cur = this.lines[this.row];
    if (this.col < cur.length) {
      this.col++;
    } else if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    }
  }

  moveWordLeft(): void {
    const cur = this.lines[this.row];
    if (this.col === 0) {
      this.moveLeft();
      return;
    }
    let c = this.col - 1;
    while (c > 0 && /\s/.test(cur[c])) c--;
    while (c > 0 && !/[\s{}[\]:,"]/.test(cur[c - 1])) c--;
    this.col = c;
  }

  moveWordRight(): void {
    const cur = this.lines[this.row];
    if (this.col >= cur.length) {
      this.moveRight();
      return;
    }
    let c = this.col;
    while (c < cur.length && !/[\s{}[\]:,"]/.test(cur[c])) c++;
    while (c < cur.length && /[\s{}[\]:,"]/.test(cur[c])) c++;
    this.col = c;
  }

  moveHome(): void {
    const cur = this.lines[this.row];
    const firstNonWs = cur.search(/\S/);
    this.col = firstNonWs !== -1 && this.col !== firstNonWs ? firstNonWs : 0;
  }

  moveEnd(): void {
    this.col = this.lines[this.row].length;
  }

  insertText(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");
    const parts = normalized.split("\n");
    const cur = this.lines[this.row];
    const before = cur.slice(0, this.col);
    const after = cur.slice(this.col);

    if (parts.length === 1) {
      this.lines[this.row] = before + parts[0] + after;
      this.col += parts[0].length;
      return;
    }

    const first = before + parts[0];
    const middle = parts.slice(1, -1);
    const last = parts[parts.length - 1] + after;
    this.lines.splice(this.row, 1, first, ...middle, last);
    this.row += parts.length - 1;
    this.col = parts[parts.length - 1].length;
  }

  insertNewline(): void {
    const cur = this.lines[this.row];
    const before = cur.slice(0, this.col);
    const after = cur.slice(this.col);
    const indentMatch = before.match(/^(\s*)/);
    let indent = indentMatch ? indentMatch[1] : "";
    const trimmedBefore = before.trimEnd();
    if (trimmedBefore.endsWith("{") || trimmedBefore.endsWith("[")) {
      indent += "  ";
    }
    this.lines.splice(this.row, 1, before, indent + after.trimStart());
    this.row++;
    this.col = indent.length;
  }

  backspace(): void {
    if (this.col > 0) {
      const cur = this.lines[this.row];
      this.lines[this.row] = cur.slice(0, this.col - 1) + cur.slice(this.col);
      this.col--;
    } else if (this.row > 0) {
      const prevLen = this.lines[this.row - 1].length;
      this.lines[this.row - 1] += this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prevLen;
    }
  }

  deleteForward(): void {
    const cur = this.lines[this.row];
    if (this.col < cur.length) {
      this.lines[this.row] = cur.slice(0, this.col) + cur.slice(this.col + 1);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] += this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
  }

  killLine(): void {
    if (this.lines.length === 1) {
      this.lines[0] = "";
      this.col = 0;
      return;
    }
    this.lines.splice(this.row, 1);
    this.row = clamp(this.row, 0, this.lines.length - 1);
    this.col = clamp(this.col, 0, this.lines[this.row].length);
  }

  ensureVisible(viewHeight: number): void {
    if (viewHeight <= 0) return;
    if (this.row < this.scrollTop) {
      this.scrollTop = this.row;
    } else if (this.row >= this.scrollTop + viewHeight) {
      this.scrollTop = this.row - viewHeight + 1;
    }
  }
}

// ============================================================================
// Raw ANSI Keypress Decoder (Zero External Dependencies)
// ============================================================================

export interface KeyEvent {
  name: string;
  char?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function decodeKeyInput(raw: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);

    if (ch === ESC) {
      const rest = raw.slice(i);
      // Alt+Enter (`\x1b\r` or `\x1b\n`)
      if (rest.startsWith("\x1b\r\n")) {
        events.push({ name: "enter", alt: true }); i += 3; continue;
      }
      if (rest.startsWith("\x1b\r") || rest.startsWith("\x1b\n")) {
        events.push({ name: "enter", alt: true }); i += 2; continue;
      }
      // Bracketed paste start/end markers — ignore cleanly
      if (rest.startsWith("\x1b[200~") || rest.startsWith("\x1b[201~")) {
        i += 6; continue;
      }
      // Common CSI / SS3 sequences
      if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
        events.push({ name: "up" }); i += 3; continue;
      }
      if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
        events.push({ name: "down" }); i += 3; continue;
      }
      if (rest.startsWith("\x1b[C") || rest.startsWith("\x1bOC")) {
        events.push({ name: "right" }); i += 3; continue;
      }
      if (rest.startsWith("\x1b[D") || rest.startsWith("\x1bOD")) {
        events.push({ name: "left" }); i += 3; continue;
      }
      if (rest.startsWith("\x1b[H") || rest.startsWith("\x1bOH") || rest.startsWith("\x1b[1~") || rest.startsWith("\x1b[7~")) {
        events.push({ name: "home" }); i += rest.startsWith("\x1b[1~") || rest.startsWith("\x1b[7~") ? 4 : 3; continue;
      }
      if (rest.startsWith("\x1b[F") || rest.startsWith("\x1bOF") || rest.startsWith("\x1b[4~") || rest.startsWith("\x1b[8~")) {
        events.push({ name: "end" }); i += rest.startsWith("\x1b[4~") || rest.startsWith("\x1b[8~") ? 4 : 3; continue;
      }
      if (rest.startsWith("\x1b[3~")) {
        events.push({ name: "delete" }); i += 4; continue;
      }
      if (rest.startsWith("\x1b[5~")) {
        events.push({ name: "pageup" }); i += 4; continue;
      }
      if (rest.startsWith("\x1b[6~")) {
        events.push({ name: "pagedown" }); i += 4; continue;
      }
      // Function keys F1-F4 (SS3 & CSI forms)
      if (rest.startsWith("\x1bOP") || rest.startsWith("\x1b[11~")) {
        events.push({ name: "f1" }); i += rest.startsWith("\x1bOP") ? 3 : 5; continue;
      }
      if (rest.startsWith("\x1bOQ") || rest.startsWith("\x1b[12~")) {
        events.push({ name: "f2" }); i += rest.startsWith("\x1bOQ") ? 3 : 5; continue;
      }
      if (rest.startsWith("\x1bOR") || rest.startsWith("\x1b[13~")) {
        events.push({ name: "f3" }); i += rest.startsWith("\x1bOR") ? 3 : 5; continue;
      }
      if (rest.startsWith("\x1bOS") || rest.startsWith("\x1b[14~")) {
        events.push({ name: "f4" }); i += rest.startsWith("\x1bOS") ? 3 : 5; continue;
      }
      // Shift / Ctrl modified arrows: `\x1b[1;2A`, `\x1b[1;5C`, `\x1b[1;5D`, etc.
      const modArrow = rest.match(/^\x1b\[1;(\d+)([ABCDHF])/);
      if (modArrow) {
        const mod = Number(modArrow[1]);
        const dirMap: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
        events.push({
          name: dirMap[modArrow[2]],
          shift: mod === 2 || mod === 6,
          alt: mod === 3 || mod === 7,
          ctrl: mod === 5 || mod === 6 || mod === 7,
        });
        i += modArrow[0].length;
        continue;
      }
      // CSI-u (`\x1b[<code>;<mod>u`) and xterm modifyOtherKeys (`\x1b[27;<mod>;<code>~`)
      const csiU = rest.match(/^\x1b\[(\d+)(?:;(\d+))?u/);
      const modOther = !csiU ? rest.match(/^\x1b\[27;(\d+);(\d+)~/) : null;
      if (csiU || modOther) {
        const cp = Number(csiU ? csiU[1] : modOther![2]);
        const mod = Number(csiU ? (csiU[2] ?? "1") : modOther![1]);
        const shift = ((mod - 1) & 1) !== 0;
        const alt = ((mod - 1) & 2) !== 0;
        const ctrl = ((mod - 1) & 4) !== 0;
        if (cp === 13) {
          events.push({ name: "enter", ctrl, alt, shift });
        } else if (cp === 27) {
          events.push({ name: "escape", ctrl, alt, shift });
        } else if (cp === 9) {
          events.push({ name: "tab", ctrl, alt, shift });
        } else if (cp === 127 || cp === 8) {
          events.push({ name: "backspace", ctrl, alt, shift });
        } else if (ctrl && cp >= 65 && cp <= 122) {
          events.push({ name: String.fromCharCode(cp).toLowerCase(), ctrl: true, alt, shift });
        } else if (cp >= 32) {
          const glyph = String.fromCodePoint(cp);
          events.push({ name: "char", char: glyph, ctrl, alt, shift });
        }
        i += (csiU ? csiU[0] : modOther![0]).length;
        continue;
      }
      // Backtab (`Shift+Tab`)
      if (rest.startsWith("\x1b[Z")) {
        events.push({ name: "tab", shift: true }); i += 3; continue;
      }
      // Skip unrecognized CSI or SS3 sequence cleanly
      const unknownCsi = rest.match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
      if (unknownCsi) {
        i += unknownCsi[0].length;
        continue;
      }
      const unknownSs3 = rest.match(/^\x1bO[A-Za-z]/);
      if (unknownSs3) {
        i += unknownSs3[0].length;
        continue;
      }
      events.push({ name: "escape" });
      i++;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      events.push({ name: "enter" });
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      i++;
      continue;
    }
    if (ch === "\t") {
      events.push({ name: "tab" });
      i++;
      continue;
    }
    if (code === 127 || code === 8) {
      events.push({ name: "backspace" });
      i++;
      continue;
    }
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96);
      events.push({ name: letter, ctrl: true });
      i++;
      continue;
    }
    if (code >= 32) {
      // Handle UTF-16 surrogate pairs (e.g. emoji) as a single character event
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length) {
        const nextCode = raw.charCodeAt(i + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          events.push({ name: "char", char: raw.slice(i, i + 2) });
          i += 2;
          continue;
        }
      }
      events.push({ name: "char", char: ch });
    }
    i++;
  }
  return events;
}

// ============================================================================
// Non-Interactive Pretty Print View (`--view` / piped stdout)
// ============================================================================

export function renderTracePrettyStatic(
  doc: TraceDocument,
  format: TraceViewFormat = "pretty",
  expandEmbedded = true,
  maxWidth = Math.max(40, (process.stdout.columns ?? 100))
): string {
  const out: string[] = [];
  const meta = doc.getMetaSummary();
  const titleParts = [
    `${ANSI.bold}${ANSI.fg.brightCyan}SPL Trace${ANSI.reset} ${ANSI.fg.white}${path.basename(doc.filePath)}${ANSI.reset}`,
    `${ANSI.fg.gray}(${doc.entries.length} records · ${format.toUpperCase()})${ANSI.reset}`,
  ];
  if (meta.provider || meta.model) {
    titleParts.push(`${ANSI.fg.magenta}${meta.provider ?? ""}/${meta.model ?? ""}${ANSI.reset}`);
  }
  if (meta.turns !== undefined) {
    titleParts.push(`${ANSI.fg.cyan}${meta.turns} turns${ANSI.reset}`);
  }
  if (meta.inputTokens !== undefined || meta.outputTokens !== undefined) {
    titleParts.push(
      `${ANSI.fg.yellow}${meta.inputTokens ?? 0}→${meta.outputTokens ?? 0} tok${ANSI.reset}`
    );
  }
  out.push(...wrapAnsiLine(titleParts.join("  "), maxWidth, true));
  out.push(ANSI.fg.gray + "─".repeat(Math.max(20, maxWidth)) + ANSI.reset);

  const bodyWidth = Math.max(20, maxWidth - 2);
  for (let i = 0; i < doc.entries.length; i++) {
    const entry = doc.entries[i];
    const kind = getEntryKind(entry);
    const badge = badgeForKind(kind, entry);
    const summary = summarizeEntry(entry);
    const headerLine = `${ANSI.fg.gray}#${String(i).padStart(2, "0")}${ANSI.reset} ${badge.color}[${badge.label.trim()}]${ANSI.reset} ${ANSI.bold}${summary}${ANSI.reset}`;
    out.push(...wrapAnsiLine(headerLine, maxWidth, true));
    for (const line of renderEntryInspectorLines(entry, format, expandEmbedded, bodyWidth)) {
      out.push("  " + line);
    }
    out.push("");
  }
  return out.join("\n");
}

// ============================================================================
// Interactive Full-Screen ANSI TUI Trace Editor
// ============================================================================

type EditorMode =
  | "browse"
  | "edit"
  | "search"
  | "save_as"
  | "add_picker"
  | "confirm_quit"
  | "help";

export interface TraceEditorStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding?(encoding: string): void;
  on(event: "data", cb: (chunk: Uint8Array | string) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  resume(): void;
  pause(): void;
}

export interface TraceEditorStdout {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string | Uint8Array): boolean;
  on?(event: "resize", cb: () => void): void;
  removeListener?(event: string, cb: (...args: any[]) => void): void;
}

export interface TraceEditorOptions {
  viewOnly?: boolean;
  format?: TraceViewFormat;
  stdin?: TraceEditorStdin;
  stdout?: TraceEditorStdout;
  stderr?: { write(chunk: string | Uint8Array): boolean };
}

export async function runTraceEditor(
  filePath: string,
  opts: TraceEditorOptions = {}
): Promise<void> {
  const doc = TraceDocument.loadFromFile(filePath);
  const initialFormat: TraceViewFormat = opts.format ?? "pretty";
  const input: TraceEditorStdin = opts.stdin ?? process.stdin;
  const output: TraceEditorStdout = opts.stdout ?? process.stdout;
  const errOut = opts.stderr ?? process.stderr;

  if (opts.viewOnly || !input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    if (!opts.viewOnly) {
      errOut?.write(
        "Note: Interactive trace editor requires a TTY terminal (showing static --view output). " +
          "Run directly in PowerShell, Windows Terminal, or VS Code terminal.\n"
      );
    }
    output.write(renderTracePrettyStatic(doc, initialFormat, true, Math.max(40, output.columns ?? 100)) + "\n");
    return;
  }

  let mode: EditorMode = "browse";
  let lastRenderedMode: EditorMode | null = null;
  let forceClearScreen = true;
  let closed = false;
  let focusPane: "list" | "json" = "list";
  let viewFormat: TraceViewFormat = initialFormat;
  let selectedFilteredIdx = 0;
  let listScroll = 0;
  let jsonScroll = 0;
  let expandEmbedded = true;
  let searchQuery = "";
  let inputLine = "";
  let pickerIdx = 0;
  let jsonBuf: JsonTextBuffer | null = null;
  let editingEntryIndex = -1;
  let statusMsg = doc.entries.length === 0
    ? `New trace file (${path.basename(doc.filePath)}). Press 'a' to add an event.`
    : `Loaded ${doc.entries.length} record(s). Press 'e' edit, 'v' JSON/JS/SPL view, 's' save, '?' help.`;
  let statusKind: "info" | "ok" | "err" = "info";

  const setStatus = (msg: string, kind: "info" | "ok" | "err" = "info") => {
    statusMsg = msg;
    statusKind = kind;
  };

  const getFilteredIndices = (): number[] => {
    const q = searchQuery.trim().toLowerCase();
    const indices: number[] = [];
    for (let i = 0; i < doc.entries.length; i++) {
      if (!q) {
        indices.push(i);
        continue;
      }
      const e = doc.entries[i];
      const hay = `${getEntryKind(e)} ${summarizeEntry(e)} ${e.rawLine}`.toLowerCase();
      if (hay.includes(q)) indices.push(i);
    }
    return indices;
  };

  const getSelectedDocIndex = (): number => {
    const filtered = getFilteredIndices();
    if (filtered.length === 0) return -1;
    selectedFilteredIdx = clamp(selectedFilteredIdx, 0, filtered.length - 1);
    return filtered[selectedFilteredIdx];
  };

  const selectDocIndex = (docIdx: number): void => {
    const filtered = getFilteredIndices();
    const pos = filtered.indexOf(docIdx);
    if (pos !== -1) {
      selectedFilteredIdx = pos;
    } else if (filtered.length > 0) {
      selectedFilteredIdx = clamp(selectedFilteredIdx, 0, filtered.length - 1);
    } else {
      selectedFilteredIdx = 0;
    }
    jsonScroll = 0;
  };

  const enterEditMode = (docIdx: number): void => {
    if (docIdx < 0 || docIdx >= doc.entries.length) {
      setStatus("No entry selected. Press 'a' to add a trace event.", "err");
      return;
    }
    const entry = doc.entries[docIdx];
    const pretty = formatEntryPrettyJson(entry, false);
    editingEntryIndex = docIdx;
    jsonBuf = new JsonTextBuffer(pretty);
    mode = "edit";
    setStatus("Editing JSON · F2/Ctrl+O/Ctrl+S apply · Ctrl+W apply+save · Ctrl+L format · Esc cancel", "info");
  };

  const applyEditBuffer = (alsoSaveFile: boolean): void => {
    if (!jsonBuf) return;
    const res = doc.updateEntryJson(editingEntryIndex, jsonBuf.getText());
    if (!res.ok) {
      setStatus(`Cannot apply invalid JSON: ${res.error}`, "err");
      return;
    }
    const idx = editingEntryIndex;
    jsonBuf = null;
    editingEntryIndex = -1;
    mode = "browse";
    selectDocIndex(idx);
    if (alsoSaveFile) {
      try {
        const saved = doc.save();
        setStatus(`Updated record #${idx} and saved -> ${saved}`, "ok");
      } catch (err) {
        setStatus(`Updated record #${idx}, but save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
      }
    } else {
      setStatus(`Updated record #${idx}. Press 's' to save to file.`, "ok");
    }
  };

  const render = () => {
    if (closed) return;
    const cols = Math.max(24, output.columns ?? 100);
    const rows = Math.max(8, output.rows ?? 30);
    const out: string[] = [];

    // Hide cursor & disable terminal auto-wrap so rows never push/scroll the alternate screen
    out.push(`${CSI}?25l${CSI}?7l`);
    if (forceClearScreen || lastRenderedMode !== mode) {
      out.push(`${CSI}2J`);
      forceClearScreen = false;
      lastRenderedMode = mode;
    }

    const writeRow = (rowNum1Based: number, content: string, bg = "") => {
      // On the last terminal row, stay 1 column shy of the bottom-right cell to avoid ConPTY scroll
      const limit = rowNum1Based >= rows ? Math.max(1, cols - 1) : cols;
      const styled = bg ? withBg(content, bg) : content;
      out.push(`${CSI}${rowNum1Based};1H${bg}${CSI}2K${padAnsi(styled, limit)}${ANSI.reset}`);
    };

    // ---- Row 1: Header Bar ----
    const meta = doc.getMetaSummary();
    const dirtyTag = doc.dirty ? `${ANSI.bold}${ANSI.fg.brightYellow} ● modified${ANSI.reset}` : `${ANSI.fg.green} ✓ saved${ANSI.reset}`;
    const metaBadges: string[] = [];
    if (meta.provider || meta.model) {
      metaBadges.push(`${ANSI.fg.brightMagenta}${meta.provider ?? ""}/${meta.model ?? ""}${ANSI.reset}`);
    }
    if (meta.turns !== undefined) {
      metaBadges.push(`${ANSI.fg.brightCyan}${meta.turns}t${ANSI.reset}`);
    }
    if (meta.inputTokens !== undefined || meta.outputTokens !== undefined) {
      metaBadges.push(`${ANSI.fg.yellow}${meta.inputTokens ?? 0}→${meta.outputTokens ?? 0}tok${ANSI.reset}`);
    }
    if (meta.durationMs !== undefined) {
      metaBadges.push(`${ANSI.fg.gray}${meta.durationMs}ms${ANSI.reset}`);
    }
    const headerLeft = ` ${ANSI.bold}${ANSI.fg.brightCyan}SPL TRACE EDITOR${ANSI.reset} ${ANSI.fg.gray}│${ANSI.reset} ${ANSI.fg.white}${path.basename(doc.filePath)}${ANSI.reset}${dirtyTag}`;
    const headerRight = metaBadges.length > 0 ? metaBadges.join(" ") + " " : `${ANSI.fg.gray}${doc.entries.length} records ${ANSI.reset}`;
    const gap = Math.max(1, cols - visibleLength(headerLeft) - visibleLength(headerRight));
    writeRow(1, headerLeft + " ".repeat(gap) + headerRight, ANSI.bg.header);

    const bodyRows = Math.max(2, rows - 3); // header (1) + status (1) + footer (1)
    let cursorScreenRow = -1;
    let cursorScreenCol = -1;

    if (mode === "edit" && jsonBuf) {
      // ---- Full-Width Multi-Line Pretty JSON Editor (Soft-Wrapped Within Screen Bounds) ----
      const check = jsonBuf.validateJson();
      const entry = doc.entries[editingEntryIndex];
      const kind = entry ? getEntryKind(entry) : "json";
      const validPill = check.ok
        ? `${ANSI.bg.okBg}${ANSI.bold}${ANSI.fg.brightGreen} ✓ VALID JSON ${ANSI.reset}`
        : `${ANSI.bg.errorBg}${ANSI.bold}${ANSI.fg.brightRed} ✗ ${oneLinePreview(check.error, Math.max(12, cols - 44))} ${ANSI.reset}`;
      const subBar = ` ${ANSI.bold}${ANSI.fg.brightYellow}EDIT #${editingEntryIndex}${ANSI.reset} ${ANSI.fg.cyan}[${kind}]${ANSI.reset} ${ANSI.fg.gray}Ln ${jsonBuf.row + 1}, Col ${jsonBuf.col + 1}${ANSI.reset}  ${validPill}`;
      writeRow(2, subBar);

      const editorRows = Math.max(1, bodyRows - 1);
      const gutterWidth = Math.max(4, String(jsonBuf.lines.length).length + 2);
      const textWidth = Math.max(8, cols - gutterWidth - 1);

      // Build soft-wrapped visual rows and map logical cursor (row, col) -> visual (vRow, vCol)
      interface EditorVisualRow {
        logicalRow: number;
        chunkIdx: number;
        styledText: string;
        isCurrentLogical: boolean;
      }
      const visualRows: EditorVisualRow[] = [];
      let cursorVisualRow = 0;
      let cursorVisualCol = 0;

      for (let li = 0; li < jsonBuf.lines.length; li++) {
        const rawLine = jsonBuf.lines[li];
        const highlighted = highlightJsonLine(rawLine);
        const chunks = rawLine.length === 0 ? [""] : wrapAnsiLine(highlighted, textWidth, false);
        const isCur = li === jsonBuf.row;
        if (isCur) {
          const chunkOfCursor = Math.floor(jsonBuf.col / textWidth);
          const colInChunk = jsonBuf.col % textWidth;
          // If cursor sits right at the end of a full-width chunk and there's no next char yet, keep on wrap row
          if (chunkOfCursor >= chunks.length) {
            chunks.push("");
          }
          cursorVisualRow = visualRows.length + chunkOfCursor;
          cursorVisualCol = colInChunk;
        }
        for (let ci = 0; ci < chunks.length; ci++) {
          visualRows.push({
            logicalRow: li,
            chunkIdx: ci,
            styledText: chunks[ci],
            isCurrentLogical: isCur,
          });
        }
      }

      if (cursorVisualRow < jsonBuf.scrollTop) {
        jsonBuf.scrollTop = cursorVisualRow;
      } else if (cursorVisualRow >= jsonBuf.scrollTop + editorRows) {
        jsonBuf.scrollTop = cursorVisualRow - editorRows + 1;
      }
      jsonBuf.scrollTop = clamp(jsonBuf.scrollTop, 0, Math.max(0, visualRows.length - editorRows));

      for (let r = 0; r < editorRows; r++) {
        const vIdx = jsonBuf.scrollTop + r;
        if (vIdx < visualRows.length) {
          const vr = visualRows[vIdx];
          const label =
            vr.chunkIdx === 0
              ? String(vr.logicalRow + 1).padStart(gutterWidth - 1) + " "
              : " ".repeat(Math.max(0, gutterWidth - 2)) + "· ";
          const gutter = (vr.isCurrentLogical ? ANSI.bold + ANSI.fg.brightYellow : ANSI.fg.gray) + label + "│" + ANSI.reset;
          const lineBody = vr.isCurrentLogical
            ? withBg(padAnsi(vr.styledText, textWidth), ANSI.bg.selection) + ANSI.reset
            : padAnsi(vr.styledText, textWidth);
          writeRow(3 + r, gutter + lineBody);
          if (vIdx === cursorVisualRow) {
            cursorScreenRow = 3 + r;
            cursorScreenCol = Math.min(cols, gutterWidth + 2 + cursorVisualCol);
          }
        } else {
          const gutter = ANSI.fg.gray + " ".repeat(gutterWidth - 2) + "~ │" + ANSI.reset;
          writeRow(3 + r, gutter + " ".repeat(textWidth));
        }
      }
    } else {
      // ---- Dual-Pane Browse Layout (Soft-Wrapped Within Screen Bounds) ----
      const minLeft = cols < 60 ? Math.max(14, Math.floor(cols * 0.36)) : 28;
      const maxLeft = Math.max(minLeft, cols - Math.max(16, Math.floor(cols * 0.45)));
      const leftWidth = clamp(Math.floor(cols * 0.4), minLeft, maxLeft);
      const rightWidth = Math.max(10, cols - leftWidth - 1);
      const filtered = getFilteredIndices();
      const selDocIdx = getSelectedDocIndex();

      const listHeaderColor = focusPane === "list" ? ANSI.bold + ANSI.fg.brightCyan : ANSI.fg.gray;
      const jsonHeaderColor = focusPane === "json" ? ANSI.bold + ANSI.fg.brightCyan : ANSI.fg.gray;

      const filterTag = searchQuery
        ? ` ${ANSI.fg.brightYellow}/${searchQuery}${ANSI.reset} (${filtered.length}/${doc.entries.length})`
        : ` (${doc.entries.length})`;
      const leftTitle = `${listHeaderColor} TIMELINE${ANSI.reset}${filterTag}`;
      const fmtTabs = TRACE_VIEW_FORMATS.map((f, idx) => {
        const lbl = `${idx + 1}:${f.toUpperCase()}`;
        return f === viewFormat
          ? `${ANSI.bold}${ANSI.fg.brightGreen}[${lbl}]${ANSI.reset}`
          : `${ANSI.fg.gray}${lbl}${ANSI.reset}`;
      }).join(" ");
      const rightTitle = `${jsonHeaderColor} INSPECTOR${ANSI.reset} ${fmtTabs}`;
      const sep = ANSI.fg.gray + "│" + ANSI.reset;
      writeRow(2, padAnsi(leftTitle, leftWidth) + sep + padAnsi(rightTitle, rightWidth));

      const paneRows = Math.max(1, bodyRows - 1);

      // Keep selected item visible in left pane
      if (selectedFilteredIdx < listScroll) listScroll = selectedFilteredIdx;
      if (selectedFilteredIdx >= listScroll + paneRows) listScroll = selectedFilteredIdx - paneRows + 1;
      listScroll = clamp(listScroll, 0, Math.max(0, filtered.length - paneRows));

      // Prepare soft-wrapped pretty JSON / JS / SPL lines for right pane
      const selectedEntry = selDocIdx >= 0 ? doc.entries[selDocIdx] : undefined;
      const rightLines: string[] = selectedEntry
        ? renderEntryInspectorLines(selectedEntry, viewFormat, expandEmbedded, rightWidth)
        : wrapAnsiLine(` ${ANSI.fg.gray}(No matching trace entry. Press 'a' to add one.)${ANSI.reset}`, rightWidth, true);

      jsonScroll = clamp(jsonScroll, 0, Math.max(0, rightLines.length - paneRows));

      for (let r = 0; r < paneRows; r++) {
        // Left pane cell
        const fIdx = listScroll + r;
        let leftCell: string;
        if (fIdx < filtered.length) {
          const docIdx = filtered[fIdx];
          const entry = doc.entries[docIdx];
          const kind = getEntryKind(entry);
          const badge = badgeForKind(kind, entry);
          const isSel = fIdx === selectedFilteredIdx;
          const idxStr = String(docIdx).padStart(2, "0");
          const sum = summarizeEntry(entry);
          const marker = isSel ? "▸" : " ";
          const rowBg = isSel ? (focusPane === "list" ? ANSI.bg.selectionActive : ANSI.bg.selection) : "";
          const line = `${marker}${ANSI.fg.gray}${idxStr}${ANSI.reset} ${badge.color}${badge.label}${ANSI.reset} ${sum}`;
          leftCell = padAnsi(rowBg ? withBg(line, rowBg) : line, leftWidth) + ANSI.reset;
        } else {
          leftCell = " ".repeat(leftWidth);
        }

        // Right pane cell
        const rIdx = jsonScroll + r;
        const rightCell = rIdx < rightLines.length ? padAnsi(rightLines[rIdx], rightWidth) : " ".repeat(rightWidth);
        writeRow(3 + r, leftCell + sep + rightCell);
      }

      // ---- Modal Overlays (add_picker / help) ----
      if (mode === "add_picker") {
        const boxW = Math.min(44, cols - 4);
        const boxH = TRACE_TEMPLATE_KINDS.length + 4;
        const startR = Math.max(2, Math.floor((rows - boxH) / 2));
        const startC = Math.max(2, Math.floor((cols - boxW) / 2));
        out.push(`${CSI}${startR};${startC}H${ANSI.bg.header}${ANSI.bold}${ANSI.fg.brightCyan}` + padAnsi(" Add Trace Event (↑/↓ Enter, Esc)", boxW) + ANSI.reset);
        for (let k = 0; k < TRACE_TEMPLATE_KINDS.length; k++) {
          const kindName = TRACE_TEMPLATE_KINDS[k];
          const badge = badgeForKind(kindName);
          const sel = k === pickerIdx;
          const bg = sel ? ANSI.bg.selectionActive : ANSI.bg.status;
          const line = ` ${sel ? "▸" : " "} ${badge.color}${badge.label}${ANSI.reset} ${kindName}`;
          out.push(`${CSI}${startR + 1 + k};${startC}H` + padAnsi(withBg(line, bg), boxW) + ANSI.reset);
        }
        out.push(`${CSI}${startR + 1 + TRACE_TEMPLATE_KINDS.length};${startC}H${ANSI.bg.header}${ANSI.fg.gray}` + padAnsi(" Inserts after selected & opens editor", boxW) + ANSI.reset);
      } else if (mode === "help") {
        const helpLines = [
          " SPL Trace Editor — Keybindings",
          " ───────────────────────────────────────────────",
          "  ↑/↓ or j/k    Navigate timeline / scroll JSON",
          "  g / G         Jump to first / last record",
          "  Tab           Toggle focus (Timeline ↔ JSON)",
          "  e / Enter     Edit selected record pretty JSON",
          "  a             Add new trace event from template",
          "  c / d         Duplicate / delete record",
          "  K / J         Move record up / down",
          "  v / 1-4       Cycle Pretty / JSON / JS / SPL view",
          "  p             Toggle nested JSON & code expansion",
          "  r             Recalculate meta turns & tokens",
          "  /             Search / filter records",
          "  u / Ctrl+Y    Undo / Redo",
          "  s / Ctrl+S    Save file   ·   W  Save As",
          "  q / Ctrl+C    Quit",
          "",
          "  In JSON Editor: F2/Ctrl+O/Ctrl+S/Alt+Enter Apply",
          "                  Ctrl+W/F3 Apply & Save to file",
          "                  Ctrl+L/Ctrl+F/F4 Format · Esc Cancel",
          "  Press any key to close help...",
        ];
        const boxW = Math.min(56, cols - 4);
        const startR = Math.max(2, Math.floor((rows - helpLines.length) / 2));
        const startC = Math.max(2, Math.floor((cols - boxW) / 2));
        for (let hi = 0; hi < helpLines.length; hi++) {
          const style = hi === 0 ? `${ANSI.bg.selectionActive}${ANSI.bold}${ANSI.fg.brightWhite}` : `${ANSI.bg.header}${ANSI.fg.white}`;
          out.push(`${CSI}${startR + hi};${startC}H${style}` + padAnsi(helpLines[hi], boxW) + ANSI.reset);
        }
      }
    }

    // ---- Row rows-1: Prompt / Status Bar ----
    if (mode === "search") {
      const prompt = ` ${ANSI.bold}${ANSI.fg.brightYellow}Filter/${ANSI.reset} ${inputLine}`;
      writeRow(rows - 1, prompt, ANSI.bg.status);
      cursorScreenRow = rows - 1;
      cursorScreenCol = Math.min(cols, 10 + inputLine.length);
    } else if (mode === "save_as") {
      const prompt = ` ${ANSI.bold}${ANSI.fg.brightCyan}Save As:${ANSI.reset} ${inputLine}`;
      writeRow(rows - 1, prompt, ANSI.bg.status);
      cursorScreenRow = rows - 1;
      cursorScreenCol = Math.min(cols, 11 + inputLine.length);
    } else if (mode === "confirm_quit") {
      const prompt = ` ${ANSI.bold}${ANSI.fg.brightYellow}Unsaved changes! [y] Save & Quit  [n] Discard & Quit  [Esc] Cancel${ANSI.reset}`;
      writeRow(rows - 1, prompt, ANSI.bg.errorBg);
    } else {
      const stBg =
        statusKind === "err"
          ? ANSI.bg.errorBg
          : statusKind === "ok"
            ? ANSI.bg.okBg
            : ANSI.bg.status;
      const stFg =
        statusKind === "err"
          ? ANSI.fg.brightRed
          : statusKind === "ok"
            ? ANSI.fg.brightGreen
            : ANSI.fg.white;
      writeRow(rows - 1, `${stFg} ${statusMsg}`, stBg);
    }

    // ---- Row rows: Footer Keybindings Legend ----
    const legend =
      mode === "edit"
        ? ` ${ANSI.bold}F2/Ctrl+O/Ctrl+S${ANSI.reset} Apply  ${ANSI.bold}Ctrl+W${ANSI.reset} Apply+Save  ${ANSI.bold}Ctrl+L/F4${ANSI.reset} Format  ${ANSI.bold}Ctrl+U${ANSI.reset} Kill Line  ${ANSI.bold}Tab${ANSI.reset} Indent  ${ANSI.bold}Esc${ANSI.reset} Cancel`
        : ` ${ANSI.bold}e/Enter${ANSI.reset} Edit  ${ANSI.bold}v/1-4${ANSI.reset} JSON/JS/SPL  ${ANSI.bold}a${ANSI.reset} Add  ${ANSI.bold}d${ANSI.reset} Del  ${ANSI.bold}K/J${ANSI.reset} Move  ${ANSI.bold}p${ANSI.reset} Nested  ${ANSI.bold}r${ANSI.reset} Meta  ${ANSI.bold}/${ANSI.reset} Filter  ${ANSI.bold}u${ANSI.reset} Undo  ${ANSI.bold}s${ANSI.reset} Save  ${ANSI.bold}W${ANSI.reset} SaveAs  ${ANSI.bold}?${ANSI.reset} Help  ${ANSI.bold}q${ANSI.reset} Quit`;
    writeRow(rows, legend, ANSI.bg.header);

    if (cursorScreenRow > 0 && cursorScreenCol > 0) {
      out.push(`${CSI}${cursorScreenRow};${cursorScreenCol}H${CSI}?25h`);
    }

    output.write(out.join(""));
  };

  return new Promise<void>((resolve, reject) => {
    const wasRaw = input.isRaw;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      input.removeListener("data", onData);
      output.removeListener?.("resize", onResize);
      process.removeListener?.("SIGINT", onSignal);
      process.removeListener?.("SIGTERM", onSignal);
      try {
        input.setRawMode?.(Boolean(wasRaw));
        input.pause();
      } catch {
        // ignore
      }
      // Restore auto-wrap, show cursor, and exit alternate screen buffer
      output.write(`${CSI}?7h${CSI}?25h${CSI}?1049l`);
    };

    const finish = () => {
      cleanup();
      resolve();
    };

    const onSignal = () => {
      finish();
    };

    const onResize = () => {
      if (closed) return;
      forceClearScreen = true;
      render();
    };

    const handleKey = (ev: KeyEvent) => {
      // Help overlay: any key closes
      if (mode === "help") {
        mode = "browse";
        return;
      }

      // Confirm quit prompt
      if (mode === "confirm_quit") {
        if (ev.char === "y" || ev.char === "Y") {
          try {
            doc.save();
            finish();
          } catch (err) {
            mode = "browse";
            setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
          }
        } else if (ev.char === "n" || ev.char === "N") {
          finish();
        } else if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
          mode = "browse";
          setStatus("Quit cancelled.", "info");
        }
        return;
      }

      // Add event picker modal
      if (mode === "add_picker") {
        if (ev.name === "escape") {
          mode = "browse";
          return;
        }
        if (ev.name === "up" || ev.char === "k") {
          pickerIdx = (pickerIdx - 1 + TRACE_TEMPLATE_KINDS.length) % TRACE_TEMPLATE_KINDS.length;
          return;
        }
        if (ev.name === "down" || ev.char === "j") {
          pickerIdx = (pickerIdx + 1) % TRACE_TEMPLATE_KINDS.length;
          return;
        }
        if (ev.name === "enter") {
          const kind = TRACE_TEMPLATE_KINDS[pickerIdx];
          const curIdx = getSelectedDocIndex();
          const maxTurn = doc.entries.reduce((acc, e) => {
            const t = e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>).turn : 0;
            return typeof t === "number" && t > acc ? t : acc;
          }, 0);
          const inserted = doc.insertEntryAfter(curIdx, createTemplateForKind(kind, Math.max(1, maxTurn)));
          searchQuery = "";
          selectDocIndex(inserted);
          enterEditMode(inserted);
          return;
        }
        return;
      }

      // Search / Save As inline input modes
      if (mode === "search" || mode === "save_as") {
        if (ev.name === "escape") {
          if (mode === "search") {
            searchQuery = "";
            selectedFilteredIdx = 0;
          }
          mode = "browse";
          setStatus("Cancelled.", "info");
          return;
        }
        if (ev.name === "enter") {
          if (mode === "search") {
            searchQuery = inputLine;
            selectedFilteredIdx = 0;
            jsonScroll = 0;
            mode = "browse";
            setStatus(searchQuery ? `Filtered by '${searchQuery}'` : "Filter cleared.", "info");
          } else {
            const target = inputLine.trim();
            if (!target) {
              setStatus("Path cannot be empty.", "err");
              mode = "browse";
              return;
            }
            try {
              const saved = doc.save(target);
              mode = "browse";
              setStatus(`Saved ${doc.entries.length} record(s) -> ${saved}`, "ok");
            } catch (err) {
              mode = "browse";
              setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
            }
          }
          return;
        }
        if (ev.name === "backspace") {
          inputLine = inputLine.slice(0, -1);
          if (mode === "search") {
            searchQuery = inputLine;
            selectedFilteredIdx = 0;
          }
          return;
        }
        if (ev.char) {
          inputLine += ev.char;
          if (mode === "search") {
            searchQuery = inputLine;
            selectedFilteredIdx = 0;
          }
        }
        return;
      }

      // Multi-line JSON Edit Mode
      if (mode === "edit" && jsonBuf) {
        if (ev.name === "escape") {
          jsonBuf = null;
          editingEntryIndex = -1;
          mode = "browse";
          setStatus("Discarded JSON edits.", "info");
          return;
        }
        if (
          (ev.ctrl && (ev.name === "s" || ev.name === "o" || ev.name === "d")) ||
          ev.name === "f2" ||
          (ev.alt && ev.name === "enter")
        ) {
          applyEditBuffer(false);
          return;
        }
        if ((ev.ctrl && ev.name === "w") || ev.name === "f3") {
          applyEditBuffer(true);
          return;
        }
        if ((ev.ctrl && (ev.name === "f" || ev.name === "l")) || ev.name === "f4") {
          const fmt = jsonBuf.formatJson();
          if (fmt.ok) setStatus("Formatted JSON.", "ok");
          else setStatus(`Format failed: ${fmt.error}`, "err");
          return;
        }
        if (ev.ctrl && (ev.name === "k" || ev.name === "u")) {
          jsonBuf.killLine();
          return;
        }
        if (ev.ctrl && ev.name === "c") {
          jsonBuf = null;
          editingEntryIndex = -1;
          mode = "browse";
          setStatus("Edit cancelled.", "info");
          return;
        }
        if (ev.name === "up") { jsonBuf.moveUp(); return; }
        if (ev.name === "down") { jsonBuf.moveDown(); return; }
        if (ev.name === "left") { ev.ctrl ? jsonBuf.moveWordLeft() : jsonBuf.moveLeft(); return; }
        if (ev.name === "right") { ev.ctrl ? jsonBuf.moveWordRight() : jsonBuf.moveRight(); return; }
        if (ev.name === "home") { jsonBuf.moveHome(); return; }
        if (ev.name === "end") { jsonBuf.moveEnd(); return; }
        if (ev.name === "pageup") { jsonBuf.moveUp(Math.max(1, (output.rows ?? 30) - 6)); return; }
        if (ev.name === "pagedown") { jsonBuf.moveDown(Math.max(1, (output.rows ?? 30) - 6)); return; }
        if (ev.name === "enter") { jsonBuf.insertNewline(); return; }
        if (ev.name === "tab") { jsonBuf.insertText("  "); return; }
        if (ev.name === "backspace") { jsonBuf.backspace(); return; }
        if (ev.name === "delete") { jsonBuf.deleteForward(); return; }
        if (ev.char) { jsonBuf.insertText(ev.char); return; }
        return;
      }

      // ---- Browse Mode ----
      if (ev.char === "q" || (ev.ctrl && ev.name === "c")) {
        if (doc.dirty) {
          mode = "confirm_quit";
        } else {
          finish();
        }
        return;
      }
      if (ev.char === "?" || ev.name === "f1") {
        mode = "help";
        return;
      }
      if (ev.name === "tab") {
        focusPane = focusPane === "list" ? "json" : "list";
        return;
      }
      if (ev.name === "escape" && searchQuery) {
        searchQuery = "";
        selectedFilteredIdx = 0;
        setStatus("Cleared filter.", "info");
        return;
      }

      const filtered = getFilteredIndices();
      const selDocIdx = getSelectedDocIndex();

      if (ev.name === "up" || ev.char === "k") {
        if (ev.shift && focusPane === "list" && selDocIdx >= 0 && !searchQuery) {
          const moved = doc.moveEntry(selDocIdx, -1);
          selectDocIndex(moved);
          setStatus(`Moved record to #${moved}`, "info");
        } else if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx - 1, 0, Math.max(0, filtered.length - 1));
          jsonScroll = 0;
        } else {
          jsonScroll = Math.max(0, jsonScroll - 1);
        }
        return;
      }
      if (ev.name === "down" || ev.char === "j") {
        if (ev.shift && focusPane === "list" && selDocIdx >= 0 && !searchQuery) {
          const moved = doc.moveEntry(selDocIdx, 1);
          selectDocIndex(moved);
          setStatus(`Moved record to #${moved}`, "info");
        } else if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx + 1, 0, Math.max(0, filtered.length - 1));
          jsonScroll = 0;
        } else {
          jsonScroll++;
        }
        return;
      }
      if (ev.name === "pageup") {
        const step = Math.max(1, (output.rows ?? 30) - 6);
        if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx - step, 0, Math.max(0, filtered.length - 1));
          jsonScroll = 0;
        } else {
          jsonScroll = Math.max(0, jsonScroll - step);
        }
        return;
      }
      if (ev.name === "pagedown") {
        const step = Math.max(1, (output.rows ?? 30) - 6);
        if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx + step, 0, Math.max(0, filtered.length - 1));
          jsonScroll = 0;
        } else {
          jsonScroll += step;
        }
        return;
      }
      if (ev.char === "g" || ev.name === "home") {
        if (focusPane === "list") { selectedFilteredIdx = 0; jsonScroll = 0; }
        else { jsonScroll = 0; }
        return;
      }
      if (ev.char === "G" || ev.name === "end") {
        if (focusPane === "list") { selectedFilteredIdx = Math.max(0, filtered.length - 1); jsonScroll = 0; }
        else { jsonScroll = 999999; }
        return;
      }
      if (ev.char === "K" && selDocIdx >= 0 && !searchQuery) {
        const moved = doc.moveEntry(selDocIdx, -1);
        selectDocIndex(moved);
        setStatus(`Moved record to #${moved}`, "info");
        return;
      }
      if (ev.char === "J" && selDocIdx >= 0 && !searchQuery) {
        const moved = doc.moveEntry(selDocIdx, 1);
        selectDocIndex(moved);
        setStatus(`Moved record to #${moved}`, "info");
        return;
      }
      if (ev.char === "e" || ev.name === "enter") {
        enterEditMode(selDocIdx);
        return;
      }
      if (ev.char === "a") {
        mode = "add_picker";
        pickerIdx = 0;
        return;
      }
      if (ev.char === "c" && selDocIdx >= 0) {
        const dup = doc.duplicateEntry(selDocIdx);
        searchQuery = "";
        selectDocIndex(dup);
        setStatus(`Duplicated record #${selDocIdx} -> #${dup}`, "ok");
        return;
      }
      if (ev.char === "d" && selDocIdx >= 0) {
        const nextIdx = doc.deleteEntry(selDocIdx);
        selectDocIndex(nextIdx);
        setStatus(`Deleted record #${selDocIdx} (press 'u' to undo).`, "info");
        return;
      }
      if (ev.char === "v") {
        const nextIdx = (TRACE_VIEW_FORMATS.indexOf(viewFormat) + 1) % TRACE_VIEW_FORMATS.length;
        viewFormat = TRACE_VIEW_FORMATS[nextIdx];
        jsonScroll = 0;
        setStatus(`Inspector view: ${viewFormat.toUpperCase()}`, "info");
        return;
      }
      if (ev.char === "1" || ev.char === "2" || ev.char === "3" || ev.char === "4") {
        viewFormat = TRACE_VIEW_FORMATS[Number(ev.char) - 1];
        jsonScroll = 0;
        setStatus(`Inspector view: ${viewFormat.toUpperCase()}`, "info");
        return;
      }
      if (ev.char === "p") {
        expandEmbedded = !expandEmbedded;
        jsonScroll = 0;
        setStatus(
          expandEmbedded
            ? "Pretty-printing embedded JSON strings (e.g. tool_result.output)."
            : "Showing raw JSON strings.",
          "info"
        );
        return;
      }
      if (ev.char === "r") {
        doc.recalculateMeta(Math.max(0, selDocIdx));
        setStatus("Recalculated meta header (turns, tokens, duration, warnings).", "ok");
        return;
      }
      if (ev.char === "/") {
        inputLine = searchQuery;
        mode = "search";
        return;
      }
      if (ev.char === "u" || (ev.ctrl && ev.name === "z")) {
        const prev = doc.undo(Math.max(0, selDocIdx));
        if (prev !== null) {
          selectDocIndex(prev);
          setStatus("Undid last change.", "info");
        } else {
          setStatus("Nothing to undo.", "info");
        }
        return;
      }
      if (ev.ctrl && ev.name === "y") {
        const next = doc.redo(Math.max(0, selDocIdx));
        if (next !== null) {
          selectDocIndex(next);
          setStatus("Redid change.", "info");
        } else {
          setStatus("Nothing to redo.", "info");
        }
        return;
      }
      if (ev.char === "s" || (ev.ctrl && ev.name === "s")) {
        try {
          const saved = doc.save();
          setStatus(`Saved ${doc.entries.length} record(s) -> ${saved}`, "ok");
        } catch (err) {
          setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
        }
        return;
      }
      if (ev.char === "W") {
        inputLine = doc.filePath;
        mode = "save_as";
        return;
      }
    };

    const onData = (rawChunk: Uint8Array | string) => {
      if (closed) return;
      try {
        const str = typeof rawChunk === "string" ? rawChunk : Buffer.from(rawChunk).toString("utf8");
        const events = decodeKeyInput(str);
        for (const ev of events) {
          handleKey(ev);
          if (closed) return;
        }
        if (!closed) render();
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    // Enter alternate screen buffer, disable auto-wrap, hide cursor, enable raw mode
    try {
      output.write(`${CSI}?1049h${CSI}?7l${CSI}?25l`);
      input.setRawMode?.(true);
      input.resume();
      input.setEncoding?.("utf8");
      input.on("data", onData);
      output.on?.("resize", onResize);
      process.on?.("SIGINT", onSignal);
      process.on?.("SIGTERM", onSignal);
      render();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
