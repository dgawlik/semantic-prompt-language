import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { compileFile } from "./compiler.js";
import {
  ANSI,
  JsonTextBuffer,
  TRACE_VIEW_FORMATS,
  TraceDocument,
  badgeForKind,
  decodeKeyInput,
  formatEntryPrettyJson,
  getEntryKind,
  highlightJsonLine,
  padAnsi,
  renderEntryInspectorLines,
  renderTracePrettyStatic,
  summarizeEntry,
  truncateAnsi,
  withBg,
  wrapAnsiLine,
  type KeyEvent,
  type TraceEditorStdin,
  type TraceEditorStdout,
  type TraceEntry,
  type TraceViewFormat,
} from "./trace-editor.js";

const CSI = "\x1b[";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ============================================================================
// SPL Runtime Value Conversion & Live Edit Reconstruction
// ============================================================================

const SPL_NONE = Object.freeze({ $tag: "None" });

function splSome<T>(v: T): { $tag: "Some"; _0: T } {
  return { $tag: "Some", _0: v };
}

function splOk<T>(v: T): { $tag: "Ok"; _0: T } {
  return { $tag: "Ok", _0: v };
}

function splErr(msg: string): { $tag: "Err"; _0: string } {
  return { $tag: "Err", _0: msg };
}

function isSplOption(v: unknown): boolean {
  return Boolean(v && typeof v === "object" && ((v as any).$tag === "Some" || (v as any).$tag === "None"));
}

function unwrapSplOpt<T = unknown>(v: unknown): T | undefined {
  if (v && typeof v === "object") {
    const tag = (v as any).$tag;
    if (tag === "Some") return (v as any)._0 as T;
    if (tag === "None") return undefined;
  }
  return v as T | undefined;
}

function wrapOptLike(origField: unknown, value: unknown): unknown {
  if (isSplOption(origField)) {
    return value === null || value === undefined ? SPL_NONE : splSome(value);
  }
  return value === null || value === undefined ? SPL_NONE : splSome(value);
}

/** Convert an SPL runtime value (Options, Results, enums, Maps, Sets) to plain JSON-safe data. */
export function splToPlainJson(val: unknown, ancestors = new WeakSet<object>()): unknown {
  if (val === null || val === undefined) return null;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;
  if (t === "bigint") return Number(val);
  if (t === "function") return undefined;
  if (t !== "object") return String(val);

  const obj = val as Record<string, unknown>;
  // Handle singleton None before cycle tracking so repeated None fields never look circular
  if (obj.$tag === "None") return null;

  if (ancestors.has(obj)) return "[Circular]";
  ancestors.add(obj);

  try {
    if (obj.$tag === "Some") return splToPlainJson(obj._0, ancestors);
    if (obj.$tag === "Ok") return { ok: splToPlainJson(obj._0, ancestors) };
    if (obj.$tag === "Err") return { err: splToPlainJson(obj._0, ancestors) };

    if (Array.isArray(obj)) {
      return obj.map((item) => {
        const converted = splToPlainJson(item, ancestors);
        return converted === undefined ? null : converted;
      });
    }

    if (obj instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of obj.entries()) {
        const converted = splToPlainJson(v, ancestors);
        if (converted !== undefined) out[String(k)] = converted;
      }
      return out;
    }

    if (obj instanceof Set) {
      return Array.from(obj.values()).map((v) => splToPlainJson(v, ancestors));
    }

    if (typeof obj.$tag === "string") {
      const out: Record<string, unknown> = { $tag: obj.$tag };
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$tag") continue;
        const converted = splToPlainJson(v, ancestors);
        if (converted !== undefined) out[k] = converted;
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const converted = splToPlainJson(v, ancestors);
      if (converted !== undefined) out[k] = converted;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/** Serialize an SPL `TurnRequest` into a clean, secret-free trace record. */
export function serializeLlmRequest(req: Record<string, unknown>, callNum: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: "llm_request",
    call: callNum,
    provider: typeof req.provider === "string" ? req.provider : String(req.provider ?? ""),
    model: typeof req.model === "string" ? req.model : String(req.model ?? ""),
  };

  const baseUrl = unwrapSplOpt<string>(req.base_url);
  if (baseUrl) out.base_url = baseUrl;

  const system = unwrapSplOpt<string>(req.system);
  if (system !== undefined && system !== null) out.system = system;

  if (Array.isArray(req.messages)) {
    out.messages = splToPlainJson(req.messages);
  }

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = splToPlainJson(req.tools);
  }

  const toolChoice = unwrapSplOpt(req.tool_choice);
  if (toolChoice !== undefined && toolChoice !== null) {
    out.tool_choice = splToPlainJson(toolChoice);
  }

  const jsonSchema = unwrapSplOpt(req.json_schema);
  if (jsonSchema !== undefined && jsonSchema !== null) {
    out.json_schema = splToPlainJson(jsonSchema);
  }

  const schemaName = unwrapSplOpt<string>(req.schema_name);
  if (schemaName) out.schema_name = schemaName;

  const temp = unwrapSplOpt<number>(req.temperature);
  if (temp !== undefined && temp !== null) out.temperature = temp;

  const maxTokens = unwrapSplOpt<number>(req.max_tokens);
  if (maxTokens !== undefined && maxTokens !== null) out.max_tokens = maxTokens;

  const topP = unwrapSplOpt<number>(req.top_p);
  if (topP !== undefined && topP !== null) out.top_p = topP;

  const thinking = unwrapSplOpt(req.thinking);
  if (thinking !== undefined && thinking !== null) out.thinking = splToPlainJson(thinking);

  const thinkingEffort = unwrapSplOpt<string>(req.thinking_effort);
  if (thinkingEffort) out.thinking_effort = thinkingEffort;

  if (typeof req.stream === "boolean") out.stream = req.stream;
  if (typeof req.api_key === "string" && req.api_key.trim().length > 0) {
    out.api_key = "[redacted]";
  }

  return out;
}

/** Merge user JSON edits back into a live SPL `TurnRequest` while preserving secrets and callbacks. */
export function applyEditedLlmRequest(
  origReq: Record<string, unknown>,
  edited: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...origReq };

  if (typeof edited.provider === "string") next.provider = edited.provider;
  if (typeof edited.model === "string") next.model = edited.model;
  if ("base_url" in edited) next.base_url = wrapOptLike(origReq.base_url, edited.base_url);
  if ("system" in edited) next.system = wrapOptLike(origReq.system, edited.system);
  if (Array.isArray(edited.messages)) next.messages = edited.messages;
  if (Array.isArray(edited.tools)) next.tools = edited.tools;
  if ("json_schema" in edited) next.json_schema = wrapOptLike(origReq.json_schema, edited.json_schema);
  if ("schema_name" in edited) next.schema_name = wrapOptLike(origReq.schema_name, edited.schema_name);
  if ("temperature" in edited) next.temperature = wrapOptLike(origReq.temperature, edited.temperature);
  if ("max_tokens" in edited) next.max_tokens = wrapOptLike(origReq.max_tokens, edited.max_tokens);
  if ("top_p" in edited) next.top_p = wrapOptLike(origReq.top_p, edited.top_p);
  if ("thinking_effort" in edited) {
    next.thinking_effort = wrapOptLike(origReq.thinking_effort, edited.thinking_effort);
  }
  if (typeof edited.stream === "boolean") next.stream = edited.stream;

  // Never clobber real api_key with placeholder text
  if (typeof edited.api_key === "string" && edited.api_key !== "[redacted]") {
    next.api_key = edited.api_key;
  }

  return next;
}

function buildResponseBlocks(
  text: string,
  thinking: string | undefined,
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>
): Array<{ kind: string; text: string; tool_call: unknown }> {
  const blocks: Array<{ kind: string; text: string; tool_call: unknown }> = [];
  if (thinking) {
    blocks.push({ kind: "thinking", text: thinking, tool_call: SPL_NONE });
  }
  if (text) {
    blocks.push({ kind: "text", text, tool_call: SPL_NONE });
  }
  for (const tc of toolCalls) {
    blocks.push({ kind: "tool_call", text: "", tool_call: splSome(tc) });
  }
  return blocks;
}

/** Build a valid SPL `LlmResponse` object from a plain JSON mock template. */
export function buildMockLlmResponse(edited: Record<string, unknown>): Record<string, unknown> {
  const text = typeof edited.text === "string" ? edited.text : edited.text === undefined ? "" : JSON.stringify(edited.text);
  const thinking = typeof edited.thinking === "string" && edited.thinking.length > 0 ? edited.thinking : undefined;
  const rawToolCalls = Array.isArray(edited.tool_calls) ? edited.tool_calls : [];
  const toolCalls = rawToolCalls.map((tc: any, idx: number) => ({
    id: typeof tc?.id === "string" ? tc.id : `mock_call_${idx + 1}`,
    name: typeof tc?.name === "string" ? tc.name : "tool",
    arguments: tc?.arguments ?? {},
  }));
  const usageIn = (edited.usage && typeof edited.usage === "object" ? edited.usage : {}) as Record<string, unknown>;
  const inputTokens = typeof usageIn.input_tokens === "number" ? usageIn.input_tokens : 0;
  const outputTokens = typeof usageIn.output_tokens === "number" ? usageIn.output_tokens : 0;
  const totalTokens = typeof usageIn.total_tokens === "number" ? usageIn.total_tokens : inputTokens + outputTokens;
  const warnings = Array.isArray(edited.warnings) ? edited.warnings.map((w) => String(w)) : [];
  const finishReason =
    typeof edited.finish_reason === "string"
      ? edited.finish_reason
      : toolCalls.length > 0
        ? "tool_calls"
        : "stop";

  return {
    text,
    thinking: thinking ? splSome(thinking) : SPL_NONE,
    tool_calls: toolCalls,
    blocks: buildResponseBlocks(text, thinking, toolCalls),
    finish_reason: finishReason,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
    warnings,
    raw: null,
  };
}

/** Serialize an SPL `Result<LlmResponse, Str>` into a pretty-printable trace record. */
export function serializeLlmResponse(
  req: Record<string, unknown>,
  result: unknown,
  durationMs: number,
  callNum: number,
  mocked = false
): Record<string, unknown> {
  const provider = typeof req.provider === "string" ? req.provider : String(req.provider ?? "");
  const model = typeof req.model === "string" ? req.model : String(req.model ?? "");

  if (result && typeof result === "object" && (result as any).$tag === "Ok") {
    const resp = ((result as any)._0 ?? {}) as Record<string, unknown>;
    const thinking = unwrapSplOpt<string>(resp.thinking);
    const out: Record<string, unknown> = {
      kind: "llm_response",
      call: callNum,
      provider,
      model,
      duration_ms: durationMs,
    };
    if (mocked) out.mocked = true;
    out.finish_reason = typeof resp.finish_reason === "string" ? resp.finish_reason : "stop";
    if (resp.usage && typeof resp.usage === "object") {
      out.usage = splToPlainJson(resp.usage);
    }
    out.text = typeof resp.text === "string" ? resp.text : "";
    if (thinking) out.thinking = thinking;
    if (Array.isArray(resp.tool_calls) && resp.tool_calls.length > 0) {
      out.tool_calls = splToPlainJson(resp.tool_calls);
    }
    if (Array.isArray(resp.warnings) && resp.warnings.length > 0) {
      out.warnings = splToPlainJson(resp.warnings);
    }
    return out;
  }

  const errMsg =
    result && typeof result === "object" && (result as any).$tag === "Err"
      ? String((result as any)._0 ?? "Unknown LLM error")
      : String(result ?? "Unknown LLM error");

  return {
    kind: "llm_error",
    call: callNum,
    provider,
    model,
    duration_ms: durationMs,
    error: errMsg,
  };
}

/** Apply user JSON edits back to a live `Result<LlmResponse, Str>` before returning to SPL code. */
export function applyEditedLlmResponse(
  origResult: unknown,
  edited: Record<string, unknown>
): { $tag: "Ok"; _0: unknown } | { $tag: "Err"; _0: string } {
  if (
    edited.kind === "llm_error" ||
    (typeof edited.error === "string" && edited.error.length > 0 && edited.kind !== "llm_response")
  ) {
    return splErr(String(edited.error ?? "Edited error"));
  }

  const origResp =
    origResult && typeof origResult === "object" && (origResult as any).$tag === "Ok"
      ? (((origResult as any)._0 ?? {}) as Record<string, unknown>)
      : {};

  const built = buildMockLlmResponse({
    text: "text" in edited ? edited.text : origResp.text,
    thinking: "thinking" in edited ? edited.thinking : unwrapSplOpt<string>(origResp.thinking),
    tool_calls: "tool_calls" in edited ? edited.tool_calls : origResp.tool_calls,
    finish_reason: "finish_reason" in edited ? edited.finish_reason : origResp.finish_reason,
    usage: "usage" in edited ? edited.usage : origResp.usage,
    warnings: "warnings" in edited ? edited.warnings : origResp.warnings,
  });
  built.raw = origResp.raw ?? null;
  return splOk(built);
}

/** Serialize an SPL `DecideRequest` into a clean, secret-free trace record. */
export function serializeDecideRequest(req: Record<string, unknown>, callNum: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: "llm_decide_request",
    call: callNum,
    provider: typeof req.provider === "string" ? req.provider : String(req.provider ?? ""),
    model: typeof req.model === "string" ? req.model : String(req.model ?? ""),
  };
  const baseUrl = unwrapSplOpt<string>(req.base_url);
  if (baseUrl) out.base_url = baseUrl;
  const system = unwrapSplOpt<string>(req.system);
  if (system !== undefined && system !== null) out.system = system;
  if (typeof req.context === "string") out.context = req.context;
  if (Array.isArray(req.questions)) out.questions = splToPlainJson(req.questions);
  const temp = unwrapSplOpt<number>(req.temperature);
  if (temp !== undefined && temp !== null) out.temperature = temp;
  const maxTokens = unwrapSplOpt<number>(req.max_tokens);
  if (maxTokens !== undefined && maxTokens !== null) out.max_tokens = maxTokens;
  const thinkingEffort = unwrapSplOpt<string>(req.thinking_effort);
  if (thinkingEffort) out.thinking_effort = thinkingEffort;
  if (typeof req.api_key === "string" && req.api_key.trim().length > 0) {
    out.api_key = "[redacted]";
  }
  return out;
}

export function applyEditedDecideRequest(
  origReq: Record<string, unknown>,
  edited: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...origReq };
  if (typeof edited.provider === "string") next.provider = edited.provider;
  if (typeof edited.model === "string") next.model = edited.model;
  if ("base_url" in edited) next.base_url = wrapOptLike(origReq.base_url, edited.base_url);
  if ("system" in edited) next.system = wrapOptLike(origReq.system, edited.system);
  if (typeof edited.context === "string") next.context = edited.context;
  if (Array.isArray(edited.questions)) next.questions = edited.questions;
  if ("temperature" in edited) next.temperature = wrapOptLike(origReq.temperature, edited.temperature);
  if ("max_tokens" in edited) next.max_tokens = wrapOptLike(origReq.max_tokens, edited.max_tokens);
  if ("thinking_effort" in edited) next.thinking_effort = wrapOptLike(origReq.thinking_effort, edited.thinking_effort);
  if (typeof edited.api_key === "string" && edited.api_key !== "[redacted]") {
    next.api_key = edited.api_key;
  }
  return next;
}

/** Serialize an SPL `Result<DecisionsResponse, Str>` into a trace record. */
export function serializeDecideResponse(
  req: Record<string, unknown>,
  result: unknown,
  durationMs: number,
  callNum: number,
  mocked = false
): Record<string, unknown> {
  const provider = typeof req.provider === "string" ? req.provider : String(req.provider ?? "");
  const model = typeof req.model === "string" ? req.model : String(req.model ?? "");

  if (result && typeof result === "object" && (result as any).$tag === "Ok") {
    const resp = ((result as any)._0 ?? {}) as Record<string, unknown>;
    const answersArr: unknown[] = [];
    if (resp.answers instanceof Map) {
      for (const [id, ans] of resp.answers.entries()) {
        answersArr.push({ id, ...(splToPlainJson(ans) as Record<string, unknown>) });
      }
    } else if (Array.isArray(resp.answers)) {
      answersArr.push(...(splToPlainJson(resp.answers) as unknown[]));
    }
    const out: Record<string, unknown> = {
      kind: "llm_decide_response",
      call: callNum,
      provider,
      model,
      duration_ms: durationMs,
    };
    if (mocked) out.mocked = true;
    if (resp.usage && typeof resp.usage === "object") {
      out.usage = splToPlainJson(resp.usage);
    }
    out.answers = answersArr;
    return out;
  }

  const errMsg =
    result && typeof result === "object" && (result as any).$tag === "Err"
      ? String((result as any)._0 ?? "Unknown Decisions error")
      : String(result ?? "Unknown Decisions error");

  return {
    kind: "llm_error",
    call: callNum,
    provider,
    model,
    duration_ms: durationMs,
    error: errMsg,
  };
}

// ============================================================================
// Debugger Options, Types & Runtime Hook Installation
// ============================================================================

export type BreakpointMode = "both" | "after" | "before" | "none";

export interface LlmDebugOptions {
  /** Initial inspector format (`pretty` | `json` | `js` | `spl`). Defaults to `"pretty"`. */
  format?: TraceViewFormat;
  /** Run without pausing and pretty-print all captured LLM calls & results. */
  noPause?: boolean;
  /** Pause before sending each LLM request (default: `true`). */
  pauseBefore?: boolean;
  /** Pause after receiving each LLM response (default: `true`). */
  pauseAfter?: boolean;
  /** Optional `.jsonl` file path to auto-save the captured trace on completion. */
  savePath?: string;
  stdin?: TraceEditorStdin;
  stdout?: TraceEditorStdout;
  stderr?: { write(chunk: string | Uint8Array): boolean };
}

export interface LlmDebugResult {
  doc: TraceDocument;
  llmCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  error?: string;
}

type DebuggerUiMode =
  | "browse"
  | "edit"
  | "mock"
  | "search"
  | "save_as"
  | "help";

type ExecState =
  | "starting"
  | "running"
  | "paused_before"
  | "calling_llm"
  | "paused_after"
  | "done"
  | "error";

interface PauseResolution {
  action: "send" | "mock" | "abort" | "continue";
  mockResponse?: Record<string, unknown>;
  error?: string;
}

interface PendingPause {
  phase: "before_turn" | "after_turn" | "before_decide" | "after_decide";
  callNum: number;
  entryIndex: number;
  resolve: (res: PauseResolution) => void;
}

function getBreakpointMode(pauseBefore: boolean, pauseAfter: boolean): BreakpointMode {
  if (pauseBefore && pauseAfter) return "both";
  if (!pauseBefore && pauseAfter) return "after";
  if (pauseBefore && !pauseAfter) return "before";
  return "none";
}

function nextBreakpointMode(cur: BreakpointMode): BreakpointMode {
  const order: BreakpointMode[] = ["both", "after", "before", "none"];
  return order[(order.indexOf(cur) + 1) % order.length];
}

function breakpointLabel(bp: BreakpointMode): string {
  switch (bp) {
    case "both": return "BEFORE+AFTER";
    case "after": return "AFTER-ONLY";
    case "before": return "BEFORE-ONLY";
    case "none": return "NONE (RUN)";
  }
}

// ============================================================================
// Main Entry Point: `runLlmDebugger`
// ============================================================================

export async function runLlmDebugger(
  filePath: string,
  opts: LlmDebugOptions = {}
): Promise<LlmDebugResult> {
  const absFile = path.resolve(filePath);
  const baseName = path.basename(absFile);
  const defaultSavePath =
    opts.savePath
      ? path.resolve(opts.savePath)
      : path.resolve(
          path.dirname(absFile),
          `${path.basename(absFile, path.extname(absFile))}.debug.jsonl`
        );

  const initialFormat: TraceViewFormat = opts.format ?? "pretty";
  const input: TraceEditorStdin = opts.stdin ?? process.stdin;
  const output: TraceEditorStdout = opts.stdout ?? process.stdout;
  const errOut = opts.stderr ?? process.stderr;

  const interactive =
    !opts.noPause &&
    Boolean(input.isTTY) &&
    Boolean(output.isTTY) &&
    typeof input.setRawMode === "function";

  // Compile first so syntax/type errors surface cleanly before entering alternate screen
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-debug-"));
  let entryOutPath: string;
  try {
    const compiled = compileFile(absFile, tmpDir);
    entryOutPath = compiled.entryOutPath;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  let nextId = 1;
  const makeEntry = (data: Record<string, unknown>): TraceEntry => ({
    id: nextId++,
    data,
    rawLine: JSON.stringify(data),
  });

  const startTs = Date.now();
  const metaData: Record<string, unknown> = {
    kind: "meta",
    version: 1,
    mode: "debug",
    file: baseName,
    provider: "",
    model: "",
    turns: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_duration_ms: 0,
    finish_reason: "running",
    warnings: [],
  };

  const doc = new TraceDocument(defaultSavePath, [makeEntry(metaData)]);

  let llmCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLlmDurationMs = 0;
  let lastProvider = "";
  let lastModel = "";
  let programError: string | undefined;

  const updateMeta = (finishReason?: string): void => {
    const updated: Record<string, unknown> = {
      ...metaData,
      provider: lastProvider || metaData.provider,
      model: lastModel || metaData.model,
      turns: llmCalls,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_duration_ms: totalLlmDurationMs,
      finish_reason: finishReason ?? metaData.finish_reason,
    };
    Object.assign(metaData, updated);
    doc.entries[0] = {
      id: doc.entries[0].id,
      data: updated,
      rawLine: JSON.stringify(updated),
    };
  };

  const appendEntry = (data: Record<string, unknown>): number => {
    const entry = makeEntry(data);
    doc.entries.push(entry);
    doc.dirty = true;
    return doc.entries.length - 1;
  };

  const updateEntryData = (index: number, data: Record<string, unknown>): void => {
    if (index < 0 || index >= doc.entries.length) return;
    doc.entries[index] = {
      id: doc.entries[index].id,
      data,
      rawLine: JSON.stringify(data),
    };
  };

  const recordStdout = (text: string, isInline: boolean): number => {
    const lastIdx = doc.entries.length - 1;
    if (isInline && lastIdx >= 1) {
      const prev = doc.entries[lastIdx];
      if (!prev.parseError && prev.data && typeof prev.data === "object" && (prev.data as any).kind === "stdout" && (prev.data as any).inline) {
        const merged = {
          ...(prev.data as Record<string, unknown>),
          text: String((prev.data as any).text ?? "") + text,
        };
        updateEntryData(lastIdx, merged);
        return lastIdx;
      }
    }
    return appendEntry(isInline ? { kind: "stdout", text, inline: true } : { kind: "stdout", text });
  };

  const prevDebugHook = (globalThis as any).__splLlmDebugHook;
  const prevDebugOut = (globalThis as any).__splDebugOut;

  const restoreGlobals = (): void => {
    if (prevDebugHook === undefined) delete (globalThis as any).__splLlmDebugHook;
    else (globalThis as any).__splLlmDebugHook = prevDebugHook;

    if (prevDebugOut === undefined) delete (globalThis as any).__splDebugOut;
    else (globalThis as any).__splDebugOut = prevDebugOut;
  };

  // ==========================================================================
  // Non-Interactive Mode (`--no-pause` or non-TTY stdout/stdin)
  // ==========================================================================
  if (!interactive) {
    if (!opts.noPause) {
      errOut?.write(
        "Note: Interactive LLM debugger requires a TTY terminal (running with --no-pause static pretty output).\n"
      );
    }

    (globalThis as any).__splDebugOut = (text: string, isInline: boolean) => {
      recordStdout(text, Boolean(isInline));
    };

    (globalThis as any).__splLlmDebugHook = {
      async beforeTurn(req: Record<string, unknown>) {
        llmCalls++;
        const callId = llmCalls;
        if (typeof req.provider === "string") lastProvider = req.provider;
        if (typeof req.model === "string") lastModel = req.model;
        appendEntry(serializeLlmRequest(req, callId));
        updateMeta("running");
        return { callId, req, action: "send" };
      },
      async afterTurn(req: Record<string, unknown>, result: unknown, elapsedMs: number, callId: number) {
        totalLlmDurationMs += elapsedMs;
        const rec = serializeLlmResponse(req, result, elapsedMs, callId);
        const usage = rec.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
        }
        appendEntry(rec);
        updateMeta("running");
        return result;
      },
      async beforeDecide(req: Record<string, unknown>) {
        llmCalls++;
        const callId = llmCalls;
        if (typeof req.provider === "string") lastProvider = req.provider;
        if (typeof req.model === "string") lastModel = req.model;
        appendEntry(serializeDecideRequest(req, callId));
        updateMeta("running");
        return { callId, req, action: "send" };
      },
      async afterDecide(req: Record<string, unknown>, result: unknown, elapsedMs: number, callId: number) {
        totalLlmDurationMs += elapsedMs;
        const rec = serializeDecideResponse(req, result, elapsedMs, callId);
        const usage = rec.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
        }
        appendEntry(rec);
        updateMeta("running");
        return result;
      },
    };

    try {
      await import(pathToFileURL(entryOutPath).href);
      const totalElapsed = Date.now() - startTs;
      appendEntry({
        kind: "program_done",
        file: baseName,
        llm_calls: llmCalls,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        duration_ms: totalElapsed,
      });
      updateMeta("completed");
    } catch (err) {
      programError = err instanceof Error ? err.message : String(err);
      appendEntry({
        kind: "program_error",
        file: baseName,
        error: programError,
      });
      updateMeta("error");
    } finally {
      restoreGlobals();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (opts.savePath) {
      doc.save(opts.savePath);
    }

    output.write(
      renderTracePrettyStatic(doc, initialFormat, true, Math.max(40, output.columns ?? 100)) + "\n"
    );

    return {
      doc,
      llmCalls,
      totalInputTokens,
      totalOutputTokens,
      error: programError,
    };
  }

  // ==========================================================================
  // Interactive Step-Through TUI Mode (Reusing trace-editor.ts Primitives)
  // ==========================================================================
  return new Promise<LlmDebugResult>((resolveOuter, rejectOuter) => {
    let uiMode: DebuggerUiMode = "browse";
    let lastRenderedUiMode: DebuggerUiMode | null = null;
    let forceClearScreen = true;
    let closed = false;

    let execState: ExecState = "starting";
    let activeCallNum = 0;
    let pausedEntryIndex = -1;
    let pendingPause: PendingPause | null = null;
    let editedActiveEntry = false;
    let liveStreamChars = 0;
    let lastStreamRenderAt = 0;
    let activeCallIsMocked = false;

    let bpMode: BreakpointMode = getBreakpointMode(
      opts.pauseBefore ?? true,
      opts.pauseAfter ?? true
    );
    let continueAll = bpMode === "none";

    let focusPane: "list" | "inspector" = "inspector";
    let viewFormat: TraceViewFormat = initialFormat;
    let selectedFilteredIdx = 0;
    let listScroll = 0;
    let inspectorScroll = 0;
    let lastLeftWidth = 40;
    let expandEmbedded = true;
    let searchQuery = "";
    let inputLine = "";
    let jsonBuf: JsonTextBuffer | null = null;
    let editingEntryIndex = -1;

    let statusMsg = `Starting ${baseName} · Breakpoints: ${breakpointLabel(bpMode)} · Press '?' for keys.`;
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
      inspectorScroll = 0;
    };

    const enterEditMode = (docIdx: number): void => {
      if (docIdx < 0 || docIdx >= doc.entries.length) {
        setStatus("No record selected to edit.", "err");
        return;
      }
      const entry = doc.entries[docIdx];
      editingEntryIndex = docIdx;
      jsonBuf = new JsonTextBuffer(formatEntryPrettyJson(entry, false));
      uiMode = "edit";
      const liveHint =
        pendingPause && docIdx === pendingPause.entryIndex
          ? " (LIVE: edits will be applied when you step!)"
          : "";
      setStatus(
        `Editing #${docIdx}${liveHint} · F2/Ctrl+O/Ctrl+S apply · Ctrl+L format · Esc cancel`,
        "info"
      );
    };

    const enterMockMode = (): void => {
      if (!pendingPause || (pendingPause.phase !== "before_turn" && pendingPause.phase !== "before_decide")) {
        setStatus("Mock is available when paused BEFORE an LLM call.", "err");
        return;
      }
      const template =
        pendingPause.phase === "before_turn"
          ? {
              text: "Mocked response from SPL debugger",
              finish_reason: "stop",
              tool_calls: [],
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            }
          : {
              answers: [],
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            };
      jsonBuf = new JsonTextBuffer(JSON.stringify(template, null, 2));
      uiMode = "mock";
      setStatus(
        `Mocking response for call #${pendingPause.callNum} · F2/Ctrl+O/Ctrl+S inject mock · Ctrl+L format · Esc cancel`,
        "info"
      );
    };

    const applyEditBuffer = (): void => {
      if (!jsonBuf) return;
      const res = doc.updateEntryJson(editingEntryIndex, jsonBuf.getText());
      if (!res.ok) {
        setStatus(`Cannot apply invalid JSON: ${res.error}`, "err");
        return;
      }
      if (pendingPause && editingEntryIndex === pendingPause.entryIndex) {
        editedActiveEntry = true;
      }
      uiMode = "browse";
      jsonBuf = null;
      selectDocIndex(editingEntryIndex);
      setStatus(
        editedActiveEntry
          ? `Applied live edit to #${editingEntryIndex}. Press 'n' / Space to continue with modified payload.`
          : `Updated record #${editingEntryIndex}.`,
        "ok"
      );
    };

    const applyMockBuffer = (): void => {
      if (!jsonBuf || !pendingPause) return;
      const check = jsonBuf.validateJson();
      if (!check.ok || !check.value || typeof check.value !== "object") {
        setStatus(`Invalid mock JSON: ${check.ok ? "must be a JSON object" : check.error}`, "err");
        return;
      }
      const mockObj = check.value as Record<string, unknown>;
      const pause = pendingPause;
      pendingPause = null;
      pausedEntryIndex = -1;
      uiMode = "browse";
      jsonBuf = null;
      activeCallIsMocked = true;
      setStatus(`Injected mock response for call #${pause.callNum}.`, "ok");
      pause.resolve({ action: "mock", mockResponse: buildMockLlmResponse(mockObj) });
    };

    const stepForward = (): void => {
      if (!pendingPause) {
        setStatus(
          execState === "done" || execState === "error"
            ? "Program finished. Browse records, press 's' to save, or 'q' to quit."
            : "Program is currently running...",
          "info"
        );
        return;
      }
      const pause = pendingPause;
      pendingPause = null;
      pausedEntryIndex = -1;
      if (pause.phase === "before_turn" || pause.phase === "before_decide") {
        execState = "calling_llm";
        liveStreamChars = 0;
        setStatus(`Sending LLM call #${pause.callNum}...`, "info");
        pause.resolve({ action: "send" });
      } else {
        execState = "running";
        setStatus(`Resuming program after call #${pause.callNum}...`, "info");
        pause.resolve({ action: "continue" });
      }
    };

    const continueExecution = (): void => {
      continueAll = true;
      bpMode = "none";
      if (pendingPause) {
        stepForward();
        setStatus("Continuing without pausing (press 'b' to re-enable breakpoints).", "ok");
      } else {
        setStatus("Breakpoints disabled (continue mode).", "ok");
      }
    };

    const abortCurrentCall = (): void => {
      if (!pendingPause || (pendingPause.phase !== "before_turn" && pendingPause.phase !== "before_decide")) {
        setStatus("Abort call ('x') is available when paused BEFORE an LLM call.", "err");
        return;
      }
      const pause = pendingPause;
      pendingPause = null;
      pausedEntryIndex = -1;
      setStatus(`Aborted LLM call #${pause.callNum}.`, "err");
      pause.resolve({ action: "abort", error: `Aborted LLM call #${pause.callNum} by SPL debugger` });
    };

    // ---- Rendering ----
    const renderStateBadge = (): string => {
      switch (execState) {
        case "starting":
          return `${ANSI.bold}${ANSI.fg.brightCyan}STARTING${ANSI.reset}`;
        case "running":
          return `${ANSI.bold}${ANSI.fg.brightCyan}RUNNING${ANSI.reset}`;
        case "paused_before":
          return `${ANSI.bold}${ANSI.fg.black}${ANSI.bg.yellow} PAUSED BEFORE #${activeCallNum} ${ANSI.reset}`;
        case "calling_llm": {
          const streamInfo = liveStreamChars > 0 ? ` (${liveStreamChars}ch)` : "";
          return `${ANSI.bold}${ANSI.fg.black}${ANSI.bg.cyan} CALLING LLM #${activeCallNum}${streamInfo} ${ANSI.reset}`;
        }
        case "paused_after":
          return `${ANSI.bold}${ANSI.fg.black}${ANSI.bg.green} PAUSED AFTER #${activeCallNum} ${ANSI.reset}`;
        case "done":
          return `${ANSI.bold}${ANSI.fg.brightGreen}DONE${ANSI.reset}`;
        case "error":
          return `${ANSI.bold}${ANSI.fg.brightRed}ERROR${ANSI.reset}`;
      }
    };

    const render = (): void => {
      if (closed) return;
      const cols = Math.max(48, output.columns ?? 120);
      const rows = Math.max(14, output.rows ?? 32);

      const modeChanged = uiMode !== lastRenderedUiMode;
      const clearPrefix = forceClearScreen || modeChanged ? `${CSI}2J` : "";
      forceClearScreen = false;
      lastRenderedUiMode = uiMode;

      const bodyHeight = Math.max(4, rows - 3);
      const outLines: string[] = [];

      // 1. Header Bar
      const dirtyMark = doc.dirty ? `${ANSI.fg.brightYellow}*${ANSI.reset}` : "";
      const tokStr =
        totalInputTokens > 0 || totalOutputTokens > 0
          ? `  ${ANSI.fg.yellow}${totalInputTokens}→${totalOutputTokens} tok${ANSI.reset}`
          : "";
      const leftHead =
        ` ${ANSI.bold}${ANSI.fg.brightCyan}SPL Debug${ANSI.reset} ` +
        `${ANSI.fg.white}${baseName}${dirtyMark}${ANSI.reset}  ` +
        renderStateBadge();
      const rightHead =
        `${ANSI.fg.gray}calls:${ANSI.fg.white}${llmCalls}${ANSI.reset}` +
        tokStr +
        `  ${ANSI.fg.brightMagenta}BP:${breakpointLabel(bpMode)}${ANSI.reset}` +
        `  ${ANSI.fg.brightCyan}${viewFormat.toUpperCase()}${ANSI.reset} `;
      const headerContent = padAnsi(leftHead + "  " + rightHead, cols);
      outLines.push(withBg(headerContent, ANSI.bg.header) + ANSI.reset);

      // 2. Main Body
      if (uiMode === "help") {
        const helpRows = [
          `${ANSI.bold}${ANSI.fg.brightCyan}SPL Interactive LLM Debugger — Keyboard Shortcuts${ANSI.reset}`,
          "",
          `${ANSI.bold}${ANSI.fg.yellow}Stepping & Live Interception${ANSI.reset}`,
          `  ${ANSI.fg.brightWhite}n / Space / Enter${ANSI.reset}   Step forward (send paused request, or continue after response)`,
          `  ${ANSI.fg.brightWhite}c${ANSI.reset}                   Continue all remaining LLM calls without pausing`,
          `  ${ANSI.fg.brightWhite}b${ANSI.reset}                   Cycle breakpoints: BEFORE+AFTER → AFTER-ONLY → BEFORE-ONLY → NONE`,
          `  ${ANSI.fg.brightWhite}e${ANSI.reset}                   Edit selected JSON (live-modifies active paused REQ or RESP!)`,
          `  ${ANSI.fg.brightWhite}m${ANSI.reset}                   Mock LLM response when paused BEFORE a call (skips network)`,
          `  ${ANSI.fg.brightWhite}x${ANSI.reset}                   Abort the currently paused LLM call with an error`,
          "",
          `${ANSI.bold}${ANSI.fg.yellow}Inspecting & Scrolling (reusing spl trace)${ANSI.reset}`,
          `  ${ANSI.fg.brightWhite}↑/↓ j/k PgUp/Dn${ANSI.reset}     Scroll results in Inspector (or navigate List when focused)`,
          `  ${ANSI.fg.brightWhite}Mouse Wheel / Click${ANSI.reset} Scroll whichever pane the cursor is over; click to focus/select`,
          `  ${ANSI.fg.brightWhite}Ctrl+D/U  ]/[  S-↑↓${ANSI.reset} Always scroll Inspector down/up regardless of pane focus`,
          `  ${ANSI.fg.brightWhite}←/→  h/l  Tab${ANSI.reset}       Switch focus between Event List (←) and Inspector (→)`,
          `  ${ANSI.fg.brightWhite}g / G  Home / End${ANSI.reset}   Jump to top / bottom of active pane`,
          `  ${ANSI.fg.brightWhite}v  /  1 2 3 4${ANSI.reset}       Switch inspector format: 1=Pretty 2=JSON 3=JS 4=SPL`,
          `  ${ANSI.fg.brightWhite}p${ANSI.reset}                   Toggle embedded JSON / code pretty-printing`,
          `  ${ANSI.fg.brightWhite}/${ANSI.reset}                   Filter records (Esc clears filter)`,
          `  ${ANSI.fg.brightWhite}s  /  W${ANSI.reset}             Save captured session to .jsonl (compatible with \`spl trace\`)`,
          `  ${ANSI.fg.brightWhite}q  /  Ctrl+C${ANSI.reset}        Quit debugger`,
          "",
          `${ANSI.dim}Press Esc, Enter, Space, or '?' to close help.${ANSI.reset}`,
        ];
        for (let r = 0; r < bodyHeight; r++) {
          const line = helpRows[r] ?? "";
          outLines.push(padAnsi("  " + line, cols) + ANSI.reset);
        }
      } else if ((uiMode === "edit" || uiMode === "mock") && jsonBuf) {
        const validation = jsonBuf.validateJson();
        const isMock = uiMode === "mock";
        const titleColor = isMock ? ANSI.fg.brightMagenta : ANSI.fg.brightYellow;
        const editTitle = isMock
          ? ` MOCK LLM RESPONSE (Call #${pendingPause?.callNum ?? activeCallNum}) `
          : ` EDIT RECORD #${editingEntryIndex} (${getEntryKind(doc.entries[editingEntryIndex])}) `;
        const validBadge = validation.ok
          ? `${ANSI.bg.okBg}${ANSI.bold}${ANSI.fg.brightWhite} VALID JSON ${ANSI.reset}`
          : `${ANSI.bg.errorBg}${ANSI.bold}${ANSI.fg.brightWhite} INVALID: ${validation.error.slice(0, Math.max(10, cols - 48))} ${ANSI.reset}`;
        const posBadge = `${ANSI.fg.gray}Ln ${jsonBuf.row + 1}, Col ${jsonBuf.col + 1}${ANSI.reset}`;
        outLines.push(
          padAnsi(`${ANSI.bold}${titleColor}${editTitle}${ANSI.reset} ${validBadge}  ${posBadge}`, cols) +
            ANSI.reset
        );

        const editorRows = Math.max(1, bodyHeight - 1);
        const gutterWidth = Math.max(4, String(jsonBuf.lines.length).length + 1);
        const codeWidth = Math.max(8, cols - gutterWidth - 3);

        interface VisualRow {
          logicalRow: number;
          segStart: number;
          text: string;
          styled: string;
          isFirst: boolean;
        }
        const visualRows: VisualRow[] = [];
        let cursorVisualRow = 0;

        for (let r = 0; r < jsonBuf.lines.length; r++) {
          const rawLine = jsonBuf.lines[r];
          const styledLine = highlightJsonLine(rawLine);
          const wrappedStyled = wrapAnsiLine(styledLine, codeWidth, false);
          for (let seg = 0; seg < wrappedStyled.length; seg++) {
            const segStart = seg * codeWidth;
            const segRaw = rawLine.slice(segStart, segStart + codeWidth);
            if (r === jsonBuf.row) {
              const isLastSeg = seg === wrappedStyled.length - 1;
              if (
                (jsonBuf.col >= segStart && jsonBuf.col < segStart + codeWidth) ||
                (isLastSeg && jsonBuf.col >= segStart)
              ) {
                cursorVisualRow = visualRows.length;
              }
            }
            visualRows.push({
              logicalRow: r,
              segStart,
              text: segRaw,
              styled: wrappedStyled[seg],
              isFirst: seg === 0,
            });
          }
        }

        if (cursorVisualRow < jsonBuf.scrollTop) jsonBuf.scrollTop = cursorVisualRow;
        else if (cursorVisualRow >= jsonBuf.scrollTop + editorRows) {
          jsonBuf.scrollTop = cursorVisualRow - editorRows + 1;
        }
        jsonBuf.scrollTop = clamp(jsonBuf.scrollTop, 0, Math.max(0, visualRows.length - 1));

        for (let i = 0; i < editorRows; i++) {
          const vr = visualRows[jsonBuf.scrollTop + i];
          if (!vr) {
            outLines.push(padAnsi(`${ANSI.fg.gray}${"~".padStart(gutterWidth)} │${ANSI.reset}`, cols) + ANSI.reset);
            continue;
          }
          const isCurLine = vr.logicalRow === jsonBuf.row;
          const lineNoStr = vr.isFirst ? String(vr.logicalRow + 1).padStart(gutterWidth) : " ".repeat(gutterWidth);
          const gutter = `${isCurLine ? ANSI.fg.brightYellow : ANSI.fg.gray}${lineNoStr} │ ${ANSI.reset}`;

          let renderedCode: string;
          if (vr === visualRows[cursorVisualRow]) {
            const c = clamp(jsonBuf.col - vr.segStart, 0, vr.text.length);
            const before = highlightJsonLine(vr.text.slice(0, c));
            const at = vr.text[c] ?? " ";
            const after = highlightJsonLine(vr.text.slice(c + 1));
            renderedCode = `${before}${ANSI.inverse}${ANSI.bold}${at}${ANSI.reset}${after}`;
          } else {
            renderedCode = vr.styled;
          }

          const rowStr = gutter + renderedCode;
          outLines.push(
            (isCurLine ? withBg(padAnsi(rowStr, cols), ANSI.bg.selection) : padAnsi(rowStr, cols)) +
              ANSI.reset
          );
        }
      } else {
        // Split-Pane Browse / Step View (reusing trace-editor layout & inspector!)
        const filtered = getFilteredIndices();
        const selDocIdx = getSelectedDocIndex();
        const leftWidth = clamp(Math.floor(cols * 0.36), 28, Math.max(28, cols - 30));
        lastLeftWidth = leftWidth;
        const rightWidth = Math.max(18, cols - leftWidth - 1);
        const listBodyHeight = Math.max(1, bodyHeight - 1);

        if (selectedFilteredIdx < listScroll) listScroll = selectedFilteredIdx;
        else if (selectedFilteredIdx >= listScroll + listBodyHeight) {
          listScroll = selectedFilteredIdx - listBodyHeight + 1;
        }
        listScroll = clamp(listScroll, 0, Math.max(0, filtered.length - 1));

        const listHeaderBg = focusPane === "list" ? ANSI.bg.selectionActive : ANSI.bg.header;
        const jsonHeaderBg = focusPane === "inspector" ? ANSI.bg.selectionActive : ANSI.bg.header;
        const filterTag = searchQuery ? ` [/${searchQuery}]` : "";
        const leftTitle = `${ANSI.bold} EXECUTION TRACE (${filtered.length}/${doc.entries.length})${filterTag}${ANSI.reset}`;

        const selEntry = selDocIdx >= 0 ? doc.entries[selDocIdx] : null;
        const rightContentWidth = Math.max(12, rightWidth - 3);
        const rightLines = selEntry
          ? renderEntryInspectorLines(selEntry, viewFormat, expandEmbedded, rightContentWidth)
          : [`${ANSI.dim}(waiting for LLM activity...)${ANSI.reset}`];
        const maxRightScroll = Math.max(0, rightLines.length - listBodyHeight);
        inspectorScroll = clamp(inspectorScroll, 0, maxRightScroll);
        const hasScrollbar = rightLines.length > listBodyHeight;

        const fmtTag = `${ANSI.fg.brightCyan}${viewFormat.toUpperCase()}${ANSI.reset}`;
        const prettyTag =
          viewFormat === "pretty" || viewFormat === "json"
            ? expandEmbedded
              ? `${ANSI.fg.brightGreen}EXPAND${ANSI.reset}`
              : `${ANSI.fg.gray}RAW${ANSI.reset}`
            : `${ANSI.fg.gray}CODE${ANSI.reset}`;
        const pausedTag =
          selDocIdx >= 0 && selDocIdx === pausedEntryIndex
            ? ` ${ANSI.bold}${ANSI.fg.brightYellow}◀ PAUSED${ANSI.reset}`
            : "";
        const scrollTag = hasScrollbar
          ? `  ${ANSI.fg.brightYellow}Ln ${inspectorScroll + 1}-${Math.min(rightLines.length, inspectorScroll + listBodyHeight)}/${rightLines.length}${ANSI.reset}`
          : "";
        const rightTitle = selEntry
          ? `${ANSI.bold} #${selDocIdx} ${getEntryKind(selEntry).toUpperCase()}${ANSI.reset}${pausedTag}  [${fmtTag} · ${prettyTag}]${scrollTag}`
          : `${ANSI.bold} INSPECTOR${ANSI.reset}`;

        outLines.push(
          withBg(padAnsi(leftTitle, leftWidth), listHeaderBg) +
            ANSI.reset +
            `${ANSI.fg.gray}│${ANSI.reset}` +
            withBg(padAnsi(rightTitle, rightWidth), jsonHeaderBg) +
            ANSI.reset
        );

        // Compute scrollbar thumb geometry when inspector content overflows
        const thumbSize = hasScrollbar
          ? Math.max(1, Math.round((listBodyHeight / rightLines.length) * listBodyHeight))
          : 0;
        const thumbTop = hasScrollbar && maxRightScroll > 0
          ? Math.round((inspectorScroll / maxRightScroll) * (listBodyHeight - thumbSize))
          : 0;

        for (let r = 0; r < listBodyHeight; r++) {
          const fIdx = listScroll + r;
          let leftCell: string;
          if (fIdx < filtered.length) {
            const docIdx = filtered[fIdx];
            const entry = doc.entries[docIdx];
            const kind = getEntryKind(entry);
            const badge = badgeForKind(kind, entry);
            const summary = summarizeEntry(entry);
            const isSel = fIdx === selectedFilteredIdx;
            const isPausedHere = docIdx === pausedEntryIndex;
            const marker = isPausedHere
              ? `${ANSI.bold}${ANSI.fg.brightYellow}▶${ANSI.reset}`
              : isSel
                ? `${ANSI.fg.brightCyan}▸${ANSI.reset}`
                : " ";
            const idxStr = `${ANSI.fg.gray}${String(docIdx).padStart(2, " ")}${ANSI.reset}`;
            const rawCell = `${marker}${idxStr} ${badge.color}${badge.label}${ANSI.reset} ${summary}`;
            const padded = padAnsi(rawCell, leftWidth);
            leftCell = isSel
              ? withBg(padded, focusPane === "list" ? ANSI.bg.selectionActive : ANSI.bg.selection) + ANSI.reset
              : padded + ANSI.reset;
          } else {
            leftCell = " ".repeat(leftWidth);
          }

          const rightLine = rightLines[inspectorScroll + r] ?? "";
          if (hasScrollbar) {
            const isThumb = r >= thumbTop && r < thumbTop + thumbSize;
            const barChar = isThumb
              ? `${ANSI.fg.brightCyan}█${ANSI.reset}`
              : `${ANSI.fg.gray}│${ANSI.reset}`;
            const rightCell = padAnsi(" " + rightLine, Math.max(1, rightWidth - 1)) + ANSI.reset + barChar;
            outLines.push(leftCell + `${ANSI.fg.gray}│${ANSI.reset}` + rightCell);
          } else {
            const rightCell = padAnsi(" " + rightLine, rightWidth) + ANSI.reset;
            outLines.push(leftCell + `${ANSI.fg.gray}│${ANSI.reset}` + rightCell);
          }
        }
      }

      // 3. Status Bar
      let statusLine: string;
      if (uiMode === "search") {
        statusLine = `${ANSI.bold}${ANSI.fg.brightCyan} Filter: ${ANSI.reset}${inputLine}${ANSI.inverse} ${ANSI.reset}  ${ANSI.dim}(Enter apply · Esc cancel)${ANSI.reset}`;
      } else if (uiMode === "save_as") {
        statusLine = `${ANSI.bold}${ANSI.fg.brightCyan} Save Trace As: ${ANSI.reset}${inputLine}${ANSI.inverse} ${ANSI.reset}  ${ANSI.dim}(Enter save · Esc cancel)${ANSI.reset}`;
      } else {
        const sc =
          statusKind === "err"
            ? `${ANSI.bold}${ANSI.fg.brightRed}`
            : statusKind === "ok"
              ? `${ANSI.bold}${ANSI.fg.brightGreen}`
              : ANSI.fg.white;
        statusLine = ` ${sc}${statusMsg}${ANSI.reset}`;
      }
      outLines.push(withBg(padAnsi(statusLine, cols), ANSI.bg.status) + ANSI.reset);

      // 4. Key Hints Footer
      let hints: string;
      if (uiMode === "edit") {
        hints =
          " F2/Ctrl+O/Ctrl+S Apply  Ctrl+L Format  Ctrl+K DelLine  Esc Cancel";
      } else if (uiMode === "mock") {
        hints =
          " F2/Ctrl+O/Ctrl+S Inject Mock Response  Ctrl+L Format  Esc Cancel";
      } else if (pendingPause && (pendingPause.phase === "before_turn" || pendingPause.phase === "before_decide")) {
        hints =
          " ↑↓/PgDn Scroll  ←→/Tab Pane  n/Space Send  e EditReq  m Mock  x Abort  c Cont  v/1-4 View  s Save  ? Help  q Quit";
      } else if (pendingPause) {
        hints =
          " ↑↓/PgDn Scroll  ←→/Tab Pane  n/Space Next  e EditResp  c Cont  b BP  v/1-4 View  p Expand  s Save  ? Help  q Quit";
      } else {
        hints =
          " ↑↓/PgDn Scroll  ←→/Tab Pane  v/1-4 View  p Expand  e Edit  b BP  / Filter  s Save  W SaveAs  ? Help  q Quit";
      }
      outLines.push(
        withBg(padAnsi(`${ANSI.fg.brightCyan}${truncateAnsi(hints, cols)}${ANSI.reset}`, cols), ANSI.bg.header) +
          ANSI.reset
      );

      // Move home + paint lines (erase-to-EOL per line)
      let frame = `${clearPrefix}${CSI}H`;
      for (let i = 0; i < outLines.length; i++) {
        frame += outLines[i] + `${CSI}K` + (i < outLines.length - 1 ? "\r\n" : "");
      }
      output.write(frame);
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (pendingPause) {
        const p = pendingPause;
        pendingPause = null;
        p.resolve({ action: "abort", error: "Debugger session closed by user" });
      }
      restoreGlobals();
      input.removeListener("data", onData);
      output.removeListener?.("resize", onResize);
      process.removeListener?.("SIGINT", onSignal);
      process.removeListener?.("SIGTERM", onSignal);
      try {
        input.setRawMode?.(false);
        input.pause();
      } catch {
        // ignore mock streams
      }
      // Disable mouse tracking, restore cursor, auto-wrap, leave alternate screen buffer
      output.write(`${CSI}?1006l${CSI}?1000l${CSI}?25h${CSI}?7h${CSI}?1049l`);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    const finish = (): void => {
      cleanup();
      resolveOuter({
        doc,
        llmCalls,
        totalInputTokens,
        totalOutputTokens,
        error: programError,
      });
    };

    const onResize = () => {
      forceClearScreen = true;
      render();
    };

    const onSignal = () => {
      finish();
    };

    const waitForStep = (
      phase: PendingPause["phase"],
      callNum: number,
      entryIndex: number
    ): Promise<PauseResolution> => {
      return new Promise<PauseResolution>((resolve) => {
        if (closed) {
          resolve({ action: "abort", error: "Debugger session closed" });
          return;
        }
        editedActiveEntry = false;
        activeCallNum = callNum;
        pausedEntryIndex = entryIndex;
        execState = phase.startsWith("before") ? "paused_before" : "paused_after";
        pendingPause = { phase, callNum, entryIndex, resolve };
        searchQuery = "";
        selectDocIndex(entryIndex);
        setStatus(
          phase.startsWith("before")
            ? `Paused BEFORE LLM call #${callNum}. Press 'n'/Space to send, 'e' edit, 'm' mock, 'x' abort, 'c' continue.`
            : `Paused AFTER LLM call #${callNum}. Press 'n'/Space to continue, 'e' edit result, 'v' change view, 's' save.`,
          "ok"
        );
        render();
      });
    };

    // ---- Install Live Runtime Hooks ----
    (globalThis as any).__splDebugOut = (text: string, isInline: boolean) => {
      const idx = recordStdout(text, Boolean(isInline));
      if (!closed && !pendingPause && uiMode === "browse") {
        selectDocIndex(idx);
        render();
      }
    };

    (globalThis as any).__splLlmDebugHook = {
      async beforeTurn(req: Record<string, unknown>) {
        llmCalls++;
        const callId = llmCalls;
        activeCallNum = callId;
        activeCallIsMocked = false;
        if (typeof req.provider === "string") lastProvider = req.provider;
        if (typeof req.model === "string") lastModel = req.model;
        const entryIdx = appendEntry(serializeLlmRequest(req, callId));
        updateMeta("running");

        const shouldPause = !continueAll && (bpMode === "both" || bpMode === "before");
        if (shouldPause && !closed) {
          const dec = await waitForStep("before_turn", callId, entryIdx);
          if (dec.action === "abort") {
            return { callId, req, action: "abort", error: dec.error };
          }
          if (dec.action === "mock") {
            return { callId, req, action: "mock", response: dec.mockResponse };
          }
          const finalReq =
            editedActiveEntry && doc.entries[entryIdx]?.data && typeof doc.entries[entryIdx].data === "object"
              ? applyEditedLlmRequest(req, doc.entries[entryIdx].data as Record<string, unknown>)
              : req;
          return { callId, req: finalReq, action: "send" };
        }

        execState = "calling_llm";
        liveStreamChars = 0;
        if (!closed && uiMode === "browse") {
          selectDocIndex(entryIdx);
          render();
        }
        return { callId, req, action: "send" };
      },

      onDelta(_callId: number, delta: Record<string, unknown>) {
        if (closed) return;
        const chunk = typeof delta?.text === "string" ? delta.text : "";
        liveStreamChars += chunk.length;
        const now = Date.now();
        if (now - lastStreamRenderAt > 60 && uiMode === "browse") {
          lastStreamRenderAt = now;
          render();
        }
      },

      async afterTurn(req: Record<string, unknown>, result: unknown, elapsedMs: number, callId: number) {
        totalLlmDurationMs += elapsedMs;
        const rec = serializeLlmResponse(req, result, elapsedMs, callId, activeCallIsMocked);
        activeCallIsMocked = false;
        const usage = rec.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
        }
        const entryIdx = appendEntry(rec);
        updateMeta("running");

        const shouldPause = !continueAll && (bpMode === "both" || bpMode === "after");
        if (shouldPause && !closed) {
          await waitForStep("after_turn", callId, entryIdx);
          if (editedActiveEntry && doc.entries[entryIdx]?.data && typeof doc.entries[entryIdx].data === "object") {
            return applyEditedLlmResponse(result, doc.entries[entryIdx].data as Record<string, unknown>);
          }
          return result;
        }

        execState = "running";
        if (!closed && uiMode === "browse") {
          selectDocIndex(entryIdx);
          render();
        }
        return result;
      },

      async beforeDecide(req: Record<string, unknown>) {
        llmCalls++;
        const callId = llmCalls;
        activeCallNum = callId;
        activeCallIsMocked = false;
        if (typeof req.provider === "string") lastProvider = req.provider;
        if (typeof req.model === "string") lastModel = req.model;
        const entryIdx = appendEntry(serializeDecideRequest(req, callId));
        updateMeta("running");

        const shouldPause = !continueAll && (bpMode === "both" || bpMode === "before");
        if (shouldPause && !closed) {
          const dec = await waitForStep("before_decide", callId, entryIdx);
          if (dec.action === "abort") {
            return { callId, req, action: "abort", error: dec.error };
          }
          if (dec.action === "mock") {
            return { callId, req, action: "mock", response: dec.mockResponse };
          }
          const finalReq =
            editedActiveEntry && doc.entries[entryIdx]?.data && typeof doc.entries[entryIdx].data === "object"
              ? applyEditedDecideRequest(req, doc.entries[entryIdx].data as Record<string, unknown>)
              : req;
          return { callId, req: finalReq, action: "send" };
        }

        execState = "calling_llm";
        if (!closed && uiMode === "browse") {
          selectDocIndex(entryIdx);
          render();
        }
        return { callId, req, action: "send" };
      },

      async afterDecide(req: Record<string, unknown>, result: unknown, elapsedMs: number, callId: number) {
        totalLlmDurationMs += elapsedMs;
        const rec = serializeDecideResponse(req, result, elapsedMs, callId, activeCallIsMocked);
        activeCallIsMocked = false;
        const usage = rec.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
        }
        const entryIdx = appendEntry(rec);
        updateMeta("running");

        const shouldPause = !continueAll && (bpMode === "both" || bpMode === "after");
        if (shouldPause && !closed) {
          await waitForStep("after_decide", callId, entryIdx);
          return result;
        }

        execState = "running";
        if (!closed && uiMode === "browse") {
          selectDocIndex(entryIdx);
          render();
        }
        return result;
      },
    };

    // ---- Keyboard Handler ----
    const handleKey = (ev: KeyEvent): void => {
      if (uiMode === "help") {
        if (ev.name === "escape" || ev.name === "enter" || ev.char === "?" || ev.char === "q" || ev.char === " ") {
          uiMode = "browse";
        }
        return;
      }

      if (uiMode === "search") {
        if (ev.name === "escape") {
          uiMode = "browse";
          return;
        }
        if (ev.name === "enter") {
          searchQuery = inputLine;
          selectedFilteredIdx = 0;
          inspectorScroll = 0;
          uiMode = "browse";
          setStatus(searchQuery ? `Filtered by "${searchQuery}".` : "Cleared filter.", "info");
          return;
        }
        if (ev.name === "backspace") {
          inputLine = inputLine.slice(0, -1);
          return;
        }
        if (ev.char) inputLine += ev.char;
        return;
      }

      if (uiMode === "save_as") {
        if (ev.name === "escape") {
          uiMode = "browse";
          return;
        }
        if (ev.name === "enter") {
          const target = inputLine.trim();
          uiMode = "browse";
          if (!target) {
            setStatus("Save cancelled (empty path).", "info");
            return;
          }
          try {
            const saved = doc.save(target);
            setStatus(`Saved ${doc.entries.length} record(s) -> ${saved}`, "ok");
          } catch (err) {
            setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
          }
          return;
        }
        if (ev.name === "backspace") {
          inputLine = inputLine.slice(0, -1);
          return;
        }
        if (ev.char) inputLine += ev.char;
        return;
      }

      if ((uiMode === "edit" || uiMode === "mock") && jsonBuf) {
        if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) {
          uiMode = "browse";
          jsonBuf = null;
          setStatus(uiMode === "browse" ? "Cancelled edit." : "Cancelled.", "info");
          return;
        }
        if (ev.name === "f2" || (ev.ctrl && (ev.name === "o" || ev.name === "s"))) {
          if (uiMode === "mock") applyMockBuffer();
          else applyEditBuffer();
          return;
        }
        if (ev.ctrl && ev.name === "l") {
          const fmt = jsonBuf.formatJson();
          setStatus(fmt.ok ? "Formatted JSON." : `Format error: ${fmt.error}`, fmt.ok ? "ok" : "err");
          return;
        }
        if (ev.ctrl && ev.name === "k") {
          jsonBuf.killLine();
          return;
        }
        if (ev.name === "wheel_up") { jsonBuf.moveUp(3); return; }
        if (ev.name === "wheel_down") { jsonBuf.moveDown(3); return; }
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

      // ---- Browse / Step Mode ----
      if (ev.char === "q" || (ev.ctrl && ev.name === "c")) {
        finish();
        return;
      }
      if (ev.char === "?" || ev.name === "f1") {
        uiMode = "help";
        return;
      }
      if (ev.name === "tab") {
        focusPane = focusPane === "list" ? "inspector" : "list";
        return;
      }
      if (ev.name === "left" || ev.char === "h") {
        focusPane = "list";
        return;
      }
      if (ev.name === "right" || ev.char === "l") {
        focusPane = "inspector";
        return;
      }
      if (ev.name === "escape" && searchQuery) {
        searchQuery = "";
        selectedFilteredIdx = 0;
        setStatus("Cleared filter.", "info");
        return;
      }

      // Stepping controls
      if (ev.char === "n" || ev.char === " " || (ev.name === "enter" && pendingPause)) {
        stepForward();
        return;
      }
      if (ev.char === "c") {
        continueExecution();
        return;
      }
      if (ev.char === "m") {
        enterMockMode();
        return;
      }
      if (ev.char === "x") {
        abortCurrentCall();
        return;
      }
      if (ev.char === "b") {
        bpMode = nextBreakpointMode(bpMode);
        continueAll = bpMode === "none";
        setStatus(`Breakpoints: ${breakpointLabel(bpMode)}`, "info");
        return;
      }

      const filtered = getFilteredIndices();
      const selDocIdx = getSelectedDocIndex();

      // Mouse wheel & click scrolling
      if (ev.name === "wheel_up") {
        if (ev.mouseX !== undefined && ev.mouseX <= lastLeftWidth) {
          selectedFilteredIdx = clamp(selectedFilteredIdx - 1, 0, Math.max(0, filtered.length - 1));
          inspectorScroll = 0;
        } else {
          inspectorScroll = Math.max(0, inspectorScroll - 3);
        }
        return;
      }
      if (ev.name === "wheel_down") {
        if (ev.mouseX !== undefined && ev.mouseX <= lastLeftWidth) {
          selectedFilteredIdx = clamp(selectedFilteredIdx + 1, 0, Math.max(0, filtered.length - 1));
          inspectorScroll = 0;
        } else {
          inspectorScroll += 3;
        }
        return;
      }
      if (ev.name === "mouse_click" && ev.mouseX !== undefined && ev.mouseY !== undefined) {
        if (ev.mouseX > lastLeftWidth + 1) {
          focusPane = "inspector";
        } else {
          focusPane = "list";
          if (ev.mouseY >= 3) {
            const clickedIdx = listScroll + (ev.mouseY - 3);
            if (clickedIdx >= 0 && clickedIdx < filtered.length) {
              selectedFilteredIdx = clickedIdx;
              inspectorScroll = 0;
            }
          }
        }
        return;
      }

      // Direct Inspector scrolling shortcuts (work regardless of focused pane)
      if ((ev.ctrl && ev.name === "d") || ev.char === "]") {
        const halfPage = Math.max(3, Math.floor(((output.rows ?? 30) - 5) / 2));
        inspectorScroll += ev.char === "]" ? 3 : halfPage;
        return;
      }
      if ((ev.ctrl && ev.name === "u") || ev.char === "[") {
        const halfPage = Math.max(3, Math.floor(((output.rows ?? 30) - 5) / 2));
        inspectorScroll = Math.max(0, inspectorScroll - (ev.char === "[" ? 3 : halfPage));
        return;
      }

      if (ev.name === "up" || ev.char === "k") {
        if (ev.shift) {
          inspectorScroll = Math.max(0, inspectorScroll - 3);
        } else if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx - 1, 0, Math.max(0, filtered.length - 1));
          inspectorScroll = 0;
        } else {
          inspectorScroll = Math.max(0, inspectorScroll - 1);
        }
        return;
      }
      if (ev.name === "down" || ev.char === "j") {
        if (ev.shift) {
          inspectorScroll += 3;
        } else if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx + 1, 0, Math.max(0, filtered.length - 1));
          inspectorScroll = 0;
        } else {
          inspectorScroll++;
        }
        return;
      }
      if (ev.name === "pageup") {
        const step = Math.max(1, (output.rows ?? 30) - 6);
        if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx - step, 0, Math.max(0, filtered.length - 1));
          inspectorScroll = 0;
        } else {
          inspectorScroll = Math.max(0, inspectorScroll - step);
        }
        return;
      }
      if (ev.name === "pagedown") {
        const step = Math.max(1, (output.rows ?? 30) - 6);
        if (focusPane === "list") {
          selectedFilteredIdx = clamp(selectedFilteredIdx + step, 0, Math.max(0, filtered.length - 1));
          inspectorScroll = 0;
        } else {
          inspectorScroll += step;
        }
        return;
      }
      if (ev.char === "g" || ev.name === "home") {
        if (focusPane === "list") { selectedFilteredIdx = 0; inspectorScroll = 0; }
        else { inspectorScroll = 0; }
        return;
      }
      if (ev.char === "G" || ev.name === "end") {
        if (focusPane === "list") { selectedFilteredIdx = Math.max(0, filtered.length - 1); inspectorScroll = 0; }
        else { inspectorScroll = 999999; }
        return;
      }

      if (ev.char === "e" || (ev.name === "enter" && !pendingPause)) {
        enterEditMode(selDocIdx);
        return;
      }
      if (ev.char === "v") {
        const nextIdx = (TRACE_VIEW_FORMATS.indexOf(viewFormat) + 1) % TRACE_VIEW_FORMATS.length;
        viewFormat = TRACE_VIEW_FORMATS[nextIdx];
        inspectorScroll = 0;
        setStatus(`Inspector view: ${viewFormat.toUpperCase()}`, "info");
        return;
      }
      if (ev.char === "1" || ev.char === "2" || ev.char === "3" || ev.char === "4") {
        viewFormat = TRACE_VIEW_FORMATS[Number(ev.char) - 1];
        inspectorScroll = 0;
        setStatus(`Inspector view: ${viewFormat.toUpperCase()}`, "info");
        return;
      }
      if (ev.char === "p") {
        expandEmbedded = !expandEmbedded;
        inspectorScroll = 0;
        setStatus(
          expandEmbedded
            ? "Pretty-printing embedded JSON & code blocks."
            : "Showing raw JSON strings.",
          "info"
        );
        return;
      }
      if (ev.char === "/") {
        inputLine = searchQuery;
        uiMode = "search";
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
        uiMode = "save_as";
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
        rejectOuter(err);
      }
    };

    // Enter alternate screen buffer, disable auto-wrap, hide cursor, enable SGR mouse wheel/click, enable raw mode
    try {
      output.write(`${CSI}?1049h${CSI}?7l${CSI}?25l${CSI}?1000h${CSI}?1006h`);
      input.setRawMode?.(true);
      input.resume();
      input.setEncoding?.("utf8");
      input.on("data", onData);
      output.on?.("resize", onResize);
      process.on?.("SIGINT", onSignal);
      process.on?.("SIGTERM", onSignal);
      execState = "running";
      render();
    } catch (err) {
      cleanup();
      rejectOuter(err);
      return;
    }

    // Launch the compiled SPL program asynchronously while TUI handles user stepping
    void (async () => {
      try {
        await import(pathToFileURL(entryOutPath).href);
        if (closed) return;
        const totalElapsed = Date.now() - startTs;
        const doneIdx = appendEntry({
          kind: "program_done",
          file: baseName,
          llm_calls: llmCalls,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          duration_ms: totalElapsed,
        });
        updateMeta("completed");
        execState = "done";
        pausedEntryIndex = -1;
        if (opts.savePath) {
          try {
            const saved = doc.save(opts.savePath);
            setStatus(`Program completed (${llmCalls} LLM call(s)) · Saved -> ${saved} · Press 'q' to quit.`, "ok");
          } catch (saveErr) {
            setStatus(`Program completed · Save failed: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`, "err");
          }
        } else {
          setStatus(
            `Program completed (${llmCalls} LLM call(s), ${totalElapsed}ms). Browse results, 's' save trace, 'q' quit.`,
            "ok"
          );
        }
        if (uiMode === "browse") selectDocIndex(doneIdx);
        render();
      } catch (err) {
        if (closed) return;
        programError = err instanceof Error ? err.message : String(err);
        const errIdx = appendEntry({
          kind: "program_error",
          file: baseName,
          error: programError,
        });
        updateMeta("error");
        execState = "error";
        pausedEntryIndex = -1;
        setStatus(`Program error: ${programError} · Press 's' to save trace or 'q' to quit.`, "err");
        if (uiMode === "browse") selectDocIndex(errIdx);
        render();
      }
    })();
  });
}
