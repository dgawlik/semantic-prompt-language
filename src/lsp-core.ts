import { parse } from "./parser.js";
import {
  checkProgram,
  type CheckedProgram,
  type ModuleExports,
  type ExtensionMethodInfo,
  type TraitImplInfo,
} from "./typechecker.js";
import { SplError, type Span } from "./errors.js";
import {
  type Type,
  prune,
  flattenRecord,
  formatType,
  canonicalShapeKey,
  unify,
  cloneWithSubst,
  instantiate,
  collectFreeVars,
} from "./types.js";
import type { Expr } from "./ast.js";

// ==================== LSP Wire Types ====================

export interface LspPosition {
  line: number;      // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4; // 1=Error, 2=Warning, 3=Info, 4=Hint
  source: string;
  message: string;
}

export interface LspCompletionItem {
  label: string;
  kind: number; // LSP CompletionItemKind
  detail?: string;
  documentation?: { kind: "markdown"; value: string };
  insertText?: string;
  filterText?: string;
  sortText?: string;
}

export interface LspParameterInformation {
  label: string;
  documentation?: { kind: "markdown"; value: string };
}

export interface LspSignatureInformation {
  label: string;
  documentation?: { kind: "markdown"; value: string };
  parameters: LspParameterInformation[];
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

export interface LspHover {
  contents: { kind: "markdown"; value: string };
  range?: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number; // LSP SymbolKind
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

// LSP CompletionItemKind constants
const CK = {
  Method: 2,
  Function: 3,
  Field: 5,
  Variable: 6,
  Interface: 8,
  Module: 9,
  Property: 10,
  Enum: 13,
  Keyword: 14,
  Struct: 22,
  EnumMember: 20,
} as const;

// LSP SymbolKind constants
const SK = {
  Module: 2,
  Field: 8,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  EnumMember: 22,
  Struct: 23,
} as const;

const KEYWORDS = [
  "let", "mut", "fn", "type", "struct", "enum", "trait", "impl",
  "for", "in", "match", "if", "else", "while", "return", "pub", "import",
  "from", "as", "true", "false",
];

const PRIMITIVE_TYPES = [
  "Int", "Float", "Str", "Bool", "Char", "Byte", "Bytes", "Json",
  "Prompt", "Array", "Iter", "Dict", "Option", "Result", "Unit",
];

const STD_MODULES = [
  { name: "std/http", desc: "Universal HTTP client (`fetch`, `get`, `post_json`)" },
  { name: "std/clock", desc: "Universal clock (`now_ms`, `sleep`)" },
  { name: "std/crypto", desc: "Universal crypto (`random_bytes`, `random_hex`)" },
  { name: "std/console", desc: "Universal console (`log`, `warn`, `error`)" },
  { name: "std/fs", desc: "Server filesystem (`read`, `write`, `stat`, `list_dir`, `mkdir`, `remove`)" },
  { name: "std/proc", desc: "Server process execution (`exec`, `shell`)" },
  { name: "std/os", desc: "Server OS environment (`env`, `args`, `cwd`, `platform`, `exit`)" },
  { name: "std/agent", desc: "Pure SPL Agent/LLM endpoint helper (`call_endpoint`)" },
  { name: "std/llm", desc: "Unified LLM facade (`ask<T>`, `agent<T>`, `agent_replay<T>`, `tool<Args, Out>`, `decide`) for OpenAI, Anthropic & Google" },
  { name: "std/traces", desc: "Ordered `TraceEvent` & `ExecutionTrace` types with JSONL serialization (`save_jsonl`, `load_jsonl`, `to_jsonl`, `from_jsonl`)" },
  { name: "std/codegen", desc: "Typed dynamic JS & SPL codegen (`js_fn<In, Out>`, `js_async_fn<In, Out>`, `js_eval<Out>`, `spl_fn<In, Out>`, `llm_fn<In, Out>`)" },
  { name: "std/collections", desc: "Pure SPL immutable collections (`HashMap<K, V>`, AVL `TreeSet<T>`, `List<T>`) with extension methods" },
];

const BUILTIN_DOCS: Record<string, { sig: string; doc: string }> = {
  // Intrinsics
  type_schema: {
    sig: "intrinsic type_schema<T>() -> Json",
    doc: "Compile-time JSON Schema (Draft 2020-12) generator for static type `T`, incorporating `''` LLM hints while omitting `//` and `///` comments.",
  },
  decode: {
    sig: "intrinsic decode<T>(json: Json) -> Result<T, DecodeError>",
    doc: "Compile-time generated runtime validator and decoder converting parsed `Json` into `Result<T, DecodeError>`.",
  },
  // Core ADTs
  Some: { sig: "enum Option.Some<T>(value: T) -> T?", doc: "Wraps a present value inside `Option<T>` (`T?`)." },
  None: { sig: "enum Option.None -> Option<T>", doc: "Represents the absence of a value in `Option<T>` (`T?`)." },
  Ok: { sig: "enum Result.Ok<T, E>(value: T) -> Result<T, E>", doc: "Wraps a successful value inside `Result<T, E>`." },
  Err: { sig: "enum Result.Err<T, E>(error: E) -> Result<T, E>", doc: "Wraps an error value inside `Result<T, E>`." },
  // Core I/O & conversion
  print: { sig: "fn print<T>(val: T) -> Unit", doc: "Formats `val` via `to_str` and prints it to stdout followed by a newline." },
  print_inline: { sig: "fn print_inline<T>(val: T) -> Unit", doc: "Formats `val` via `to_str` and writes it to stdout **without** a trailing newline (ideal for streaming LLM deltas)." },
  to_str: { sig: "fn to_str<T>(val: T) -> Str", doc: "Converts any SPL value to its human-readable string representation." },
  panic: { sig: "fn panic(msg: Str) -> Never", doc: "Aborts execution immediately by throwing an unrecoverable SPL panic error with `msg`." },
  // JSON
  json_parse: { sig: "fn json_parse(text: Str) -> Result<Json, Str>", doc: "Parses a JSON string into a `Json` value, returning `Err(reason)` on syntax error." },
  json_stringify: { sig: "fn json_stringify<T>(val: T) -> Str", doc: "Serializes any SPL value into a compact JSON string." },
  to_json: { sig: "fn to_json<T>(val: T) -> Json", doc: "Converts a typed SPL value into a dynamic `Json` value." },
  // Math
  floor: { sig: "fn floor(x: Float) -> Int", doc: "Returns the largest integer less than or equal to `x`." },
  ceil: { sig: "fn ceil(x: Float) -> Int", doc: "Returns the smallest integer greater than or equal to `x`." },
  round: { sig: "fn round(x: Float) -> Int", doc: "Rounds `x` to the nearest integer." },
  sqrt: { sig: "fn sqrt(x: Float) -> Float", doc: "Returns the square root of `x`." },
  abs: { sig: "fn abs(x: Float) -> Float", doc: "Returns the absolute value of a `Float`." },
  abs_int: { sig: "fn abs_int(x: Int) -> Int", doc: "Returns the absolute value of an `Int`." },
  log: { sig: "fn log(x: Float) -> Float", doc: "Returns the natural logarithm (`ln`) of `x`." },
  exp: { sig: "fn exp(x: Float) -> Float", doc: "Returns `e ** x`." },
  is_finite: { sig: "fn is_finite(x: Float) -> Bool", doc: "Returns `true` if `x` is a finite number (neither `NaN` nor `±Infinity`)." },
  int_to_float: { sig: "fn int_to_float(x: Int) -> Float", doc: "Converts an `Int` to a `Float`." },
  float_to_int: { sig: "fn float_to_int(x: Float) -> Int", doc: "Truncates a `Float` toward zero into an `Int`." },
  // Collections & Iterators
  array_fold: { sig: "fn array_fold<A, B>(arr: Array<A>, init: B, f: fn(B, A) -> B) -> B", doc: "Left-folds `arr` starting from `init` in $O(n)$ time." },
  array_from_fn: { sig: "fn array_from_fn<T>(len: Int, f: fn(Int) -> T) -> Array<T>", doc: "Creates an `Array<T>` of length `len` by calling `f(i)` for `i` in `0..len`." },
  dict_empty: { sig: "fn dict_empty<K, V>() -> Dict<K, V>", doc: "Creates an empty immutable `Dict<K, V>`." },
  iter_from_fn: { sig: "fn iter_from_fn<T>(next: fn() -> T?) -> Iter<T>", doc: "Creates a lazy pull iterator `Iter<T>` whose next element is produced by calling `next()` until it returns `None`." },
  // Regex
  regex_test: { sig: "fn regex_test(pattern: Str, input: Str) -> Bool", doc: "Returns `true` if JS regular expression `pattern` matches `input`." },
  regex_match: { sig: "fn regex_match(pattern: Str, input: Str) -> Array<Str>?", doc: "Matches `pattern` against `input`, returning `Some(captures)` or `None`." },
  regex_replace: { sig: "fn regex_replace(pattern: Str, input: Str, replacement: Str) -> Str", doc: "Replaces all matches of `pattern` in `input` with `replacement`." },
  // Async
  async_all: { sig: "async fn async_all<T>(thunks: Array<fn() -> T>) -> Array<T>", doc: "Runs all thunks concurrently (`Promise.all`) and returns their results in order." },
  async_race: { sig: "async fn async_race<T>(thunks: Array<fn() -> T>) -> T", doc: "Runs all thunks concurrently (`Promise.race`) and returns the first settled result." },
  // Bytes
  bytes_from_utf8: { sig: "fn bytes_from_utf8(s: Str) -> Bytes", doc: "Encodes a UTF-8 `Str` into a `Uint8Array` (`Bytes`)." },
  bytes_to_utf8: { sig: "fn bytes_to_utf8(b: Bytes) -> Str", doc: "Decodes `Bytes` (`Uint8Array`) as a UTF-8 `Str`." },
  bytes_len: { sig: "fn bytes_len(b: Bytes) -> Int", doc: "Returns the byte length of `b`." },
};

const PRIMITIVE_TYPE_DOCS: Record<string, string> = {
  Int: "64-bit integer number (`\"integer\"` in JSON Schema).",
  Float: "IEEE-754 floating-point number (`\"number\"` in JSON Schema).",
  Str: "Immutable UTF-8 string (`\"string\"` in JSON Schema).",
  Bool: "Boolean (`true` or `false`).",
  Char: "Single Unicode character literal (`'a'`).",
  Byte: "Unsigned 8-bit integer (`0..255`).",
  Bytes: "Binary byte buffer (`Uint8Array`).",
  Json: "Dynamic JSON value; validate into static types via `decode<T>(json)`.",
  Prompt: "First-class auto-dedented, brace-balanced prompt template produced by `@{ ... }`.",
  Array: "`Array<T>` — mutable dynamic array supporting `.get`, `.set`, `.push`, `.pop`, `.swap`, `.clear`, `.map`, `.par_map`, `.filter`, `.fold`, `.iter()`, and `for x in arr`.",
  Iter: "`Iter<T>` — lazy pull iterator supporting `.next()`, `.map`, `.filter`, `.flat_map`, `.take`, `.skip`, `.enumerate`, `.zip`, `.chain`, `.collect()`, `.fold`, and `for x in it`.",
  Dict: "`Dict<K, V>` — immutable key-value map backed by JS `Map`.",
  Option: "`Option<T>` (`T?`) — `Some(value)` or `None`, with `?.` and `??` operators.",
  Result: "`Result<T, E>` — `Ok(value)` or `Err(error)`, with postfix `?` error propagation.",
  Unit: "Unit type `()` indicating no meaningful return value.",
};

// ==================== Language Service ====================

export interface SplLanguageHost {
  uriToPath(uri: string): string;
  pathToUri(filePath: string): string;
  normalizePath(filePath: string): string;
  isStdlibPath(filePath: string): boolean;
  resolveModuleSpec(spec: string, fromFile: string): { sourcePath: string; isStdlib: boolean };
  readFile(filePath: string): string | undefined;
}

export class SplLanguageServiceCore {
  protected readonly host: SplLanguageHost;
  private openDocs = new Map<string, string>(); // normalized path -> text
  private lastGoodChecked = new Map<string, CheckedProgram>();

  constructor(host: SplLanguageHost) {
    this.host = host;
  }

  setDocument(uri: string, text: string): void {
    const key = this.host.normalizePath(this.host.uriToPath(uri));
    this.openDocs.set(key, text);
  }

  closeDocument(uri: string): void {
    const key = this.host.normalizePath(this.host.uriToPath(uri));
    this.openDocs.delete(key);
    this.lastGoodChecked.delete(key);
  }

  getDocumentText(uri: string): string | undefined {
    const fsPath = this.host.uriToPath(uri);
    const open = this.openDocs.get(this.host.normalizePath(fsPath));
    if (open !== undefined) return open;
    return this.host.readFile(fsPath);
  }

  /** Parse & typecheck a document, returning diagnostics and (if valid) CheckedProgram */
  analyze(uri: string, overrideText?: string): { diagnostics: LspDiagnostic[]; checked?: CheckedProgram } {
    const fsPath = this.host.uriToPath(uri);
    const key = this.host.normalizePath(fsPath);
    const text = overrideText ?? this.getDocumentText(uri) ?? "";
    const isStdlib = this.host.isStdlibPath(fsPath);

    const modCache = new Map<string, ModuleExports>();
    const resolveModule = (spec: string, fromFile: string): ModuleExports => {
      const target = this.host.resolveModuleSpec(spec, fromFile);
      const targetKey = this.host.normalizePath(target.sourcePath);
      const cached = modCache.get(targetKey);
      if (cached) return cached;
      const src = this.openDocs.get(targetKey) ?? this.host.readFile(target.sourcePath);
      if (src === undefined) throw new SplError("module", `Cannot read module '${spec}'`);
      const prog = parse(src, target.sourcePath, target.isStdlib);
      const chk = checkProgram(prog, resolveModule);
      modCache.set(targetKey, chk.exports);
      return chk.exports;
    };

    try {
      const program = parse(text, fsPath, isStdlib);
      const checked = checkProgram(program, resolveModule);
      if (!overrideText) {
        this.lastGoodChecked.set(key, checked);
      }
      return { diagnostics: [], checked };
    } catch (err) {
      if (err instanceof SplError) {
        const range = spanToRange(err.span, text);
        return {
          diagnostics: [
            {
              range,
              severity: 1,
              source: `splx (${err.phase})`,
              message: err.message.replace(/^.*?\[(lex|parse|type|codegen|module)\]\s*/, ""),
            },
          ],
        };
      }
      return {
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            source: "splx",
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }

  // ==================== Autocompletion ====================

  getCompletions(uri: string, pos: LspPosition): LspCompletionItem[] {
    const text = this.getDocumentText(uri);
    if (text === undefined) return [];
    const lines = text.split(/\r?\n/);
    const lineText = lines[pos.line] ?? "";
    const beforeCursor = lineText.slice(0, pos.character);

    // 1. Import path completion: `from "std/...`
    const importMatch = beforeCursor.match(/\bfrom\s+"([^"]*)$/);
    if (importMatch) {
      const prefix = importMatch[1];
      return STD_MODULES.filter((m) => m.name.startsWith(prefix)).map((m) => ({
        label: m.name,
        kind: CK.Module,
        detail: "SPL Standard Library",
        documentation: { kind: "markdown", value: m.desc },
      }));
    }

    // 2. Member / property / method completion after `.` or `?.` (supports single-line & multi-line chains!)
    const dotMatch = beforeCursor.match(/^(.*?)(\?\.|\.)([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (dotMatch) {
      const op = dotMatch[2]; // "." or "?."
      const memberPrefix = dotMatch[3] ?? "";
      const cursorOffset = positionToOffset(text, pos);
      const dotOffset = cursorOffset - memberPrefix.length - op.length;
      const receiverSlice = extractTrailingReceiverOffset(text, dotOffset);
      if (receiverSlice) {
        const items = this.completeMemberAccess(
          uri,
          text,
          pos,
          receiverSlice.exprText,
          receiverSlice.startOffset,
          cursorOffset,
          op,
          memberPrefix
        );
        if (items.length > 0) return items;
      }
    }

    // 3. Function call named-argument completions + general scope identifiers
    const identPrefixMatch = beforeCursor.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    const prefix = identPrefixMatch ? identPrefixMatch[1] : "";
    const active = this.getActiveCheckedForLine(uri, lines, pos.line);

    const cursorOffset = positionToOffset(text, pos);
    const callCtx = findEnclosingCallContext(text, cursorOffset);
    const argItems =
      callCtx && callCtx.isArgNamePosition
        ? this.completeCallArguments(uri, text, active, callCtx)
        : [];

    const scopeItems = this.completeScopeIdentifiers(active, pos, prefix);
    if (argItems.length > 0) {
      for (const item of scopeItems) {
        if (!item.sortText) item.sortText = `2_${item.label}`;
      }
      return [...argItems, ...scopeItems];
    }
    return scopeItems;
  }

  getSignatureHelp(uri: string, pos: LspPosition): LspSignatureHelp | null {
    const text = this.getDocumentText(uri);
    if (text === undefined) return null;
    const lines = text.split(/\r?\n/);
    const cursorOffset = positionToOffset(text, pos);
    const callCtx = findEnclosingCallContext(text, cursorOffset);
    if (!callCtx) return null;

    const active = this.getActiveCheckedForLine(uri, lines, pos.line);
    const callable = this.resolveCallable(uri, text, active, callCtx.calleeText);
    if (!callable) return null;

    const paramLabels = callable.params.map(
      (p) => `${p.name}: ${p.typeStr}${p.hasDefault ? " = ..." : ""}`
    );
    const fnPrefix = [
      callable.isReified ? "reified" : "",
      callable.isAsync ? "async" : "",
      "fn",
    ]
      .filter(Boolean)
      .join(" ");
    const sigLabel = `${fnPrefix} ${callable.name}(${paramLabels.join(", ")}) -> ${callable.returnTypeStr}`;

    let activeParameter = 0;
    if (callable.params.length > 0) {
      if (callCtx.currentArgName) {
        const idx = callable.params.findIndex((p) => p.name === callCtx.currentArgName);
        if (idx >= 0) activeParameter = idx;
      } else if (callCtx.isArgNamePosition && callCtx.argPrefix) {
        const idx = callable.params.findIndex(
          (p) => !callCtx.usedNamedArgs.has(p.name) && p.name.startsWith(callCtx.argPrefix)
        );
        activeParameter = idx >= 0 ? idx : Math.min(callCtx.positionalCount, callable.params.length - 1);
      } else if (callCtx.usedNamedArgs.size > 0) {
        const firstUnused = callable.params.findIndex((p) => !callCtx.usedNamedArgs.has(p.name));
        activeParameter = firstUnused >= 0 ? firstUnused : callable.params.length - 1;
      } else {
        activeParameter = Math.min(callCtx.positionalCount, callable.params.length - 1);
      }
    }

    return {
      signatures: [
        {
          label: sigLabel,
          documentation: callable.doc ? { kind: "markdown", value: callable.doc } : undefined,
          parameters: callable.params.map((p, i) => ({
            label: paramLabels[i],
            documentation: {
              kind: "markdown",
              value: `\`${p.name}: ${p.typeStr}\`${p.hasDefault ? " *(optional)*" : " *(required)*"}`,
            },
          })),
        },
      ],
      activeSignature: 0,
      activeParameter,
    };
  }

  private getActiveCheckedForLine(uri: string, lines: string[], lineIdx: number): CheckedProgram | undefined {
    const { checked } = this.analyze(uri);
    let active = checked ?? this.lastGoodChecked.get(this.host.normalizePath(this.host.uriToPath(uri)));
    if (!active && lineIdx >= 0 && lineIdx < lines.length) {
      const trimmed = [...lines];
      trimmed[lineIdx] = "";
      active = this.analyze(uri, trimmed.join("\n")).checked;
    }
    return active;
  }

  private completeCallArguments(
    uri: string,
    text: string,
    active: CheckedProgram | undefined,
    callCtx: CallContext
  ): LspCompletionItem[] {
    const callable = this.resolveCallable(uri, text, active, callCtx.calleeText);
    if (!callable || callable.params.length === 0) return [];

    const items: LspCompletionItem[] = [];
    for (let i = 0; i < callable.params.length; i++) {
      const p = callable.params[i];
      if (callCtx.usedNamedArgs.has(p.name)) continue;
      if (callCtx.usedNamedArgs.size === 0 && i < callCtx.positionalCount) continue;
      if (callCtx.argPrefix && !p.name.startsWith(callCtx.argPrefix)) continue;

      const reqLabel = p.hasDefault ? "optional" : "required";
      const docLines = [`Named argument \`${p.name}: ${p.typeStr}\` (${reqLabel}) for \`${callable.name}\`.`];
      if (callable.doc) docLines.push("", callable.doc);

      items.push({
        label: `${p.name}:`,
        kind: CK.Property,
        detail: `${p.typeStr} (${reqLabel})`,
        documentation: { kind: "markdown", value: docLines.join("\n") },
        insertText: `${p.name}: `,
        filterText: p.name,
        sortText: `${p.hasDefault ? "01" : "00"}_${String(i).padStart(2, "0")}_${p.name}`,
      });
    }
    return items;
  }

  private resolveCallable(
    uri: string,
    text: string,
    active: CheckedProgram | undefined,
    calleeText: string
  ): ResolvedCallable | undefined {
    const dotIdx = calleeText.lastIndexOf(".");
    if (dotIdx !== -1) {
      const left = calleeText.slice(0, dotIdx).trim();
      const member = calleeText.slice(dotIdx + 1).trim();
      if (!member) return undefined;

      // 1. Module namespace call (`llm.ask`, `fs.read`, `codegen.js_fn`, `traces.save_jsonl`, ...)
      const nsMod =
        active?.namespaces.get(left) ?? this.resolveImportsFallback(uri, text).namespaces.get(left)?.mod;
      if (nsMod) {
        return this.callableFromModuleExport(nsMod, member, `${left}.${member}`);
      }

      // 2. Extension method in scope (`s.push`, `scores.put`, `trace.to_jsonl`, ...)
      const allExts: ExtensionMethodInfo[] = [];
      if (active) allExts.push(...active.extensions);
      if (allExts.length === 0) {
        const fb = this.resolveImportsFallback(uri, text);
        for (const entry of fb.namespaces.values()) allExts.push(...entry.mod.extensions);
      }
      const extMatch = allExts.find((e) => e.name === member);
      if (extMatch) {
        const fnT = prune(extMatch.fnType);
        if (fnT.kind === "TFn") {
          const params: CallableParam[] = [];
          for (let i = 1; i < fnT.params.length; i++) {
            params.push({
              name: fnT.paramNames?.[i] ?? `arg${i - 1}`,
              typeStr: formatType(fnT.params[i]),
              hasDefault: false,
            });
          }
          return {
            name: `${left}.${member}`,
            params,
            returnTypeStr: formatType(fnT.ret),
            doc: extMatch.doc,
            isAsync: extMatch.isAsync,
          };
        }
      }
      return undefined;
    }

    // 3. Direct function call: local / imported symbol
    if (active) {
      const sym = active.symbols.find((s) => s.name === calleeText && (s.kind === "fn" || s.kind === "extern"));
      if (sym?.type) {
        const fnT = prune(sym.type);
        if (fnT.kind === "TFn") {
          const defaults = active.namedParamDefaults.get(calleeText);
          return this.callableFromFnType(calleeText, fnT, defaults, sym.doc, Boolean(fnT.isAsync), false);
        }
      }
    }

    // 4. Fallback named import (`import { ask, agent } from "std/llm"`)
    const fbNamed = this.resolveImportsFallback(uri, text).namedExports.get(calleeText);
    if (fbNamed) {
      return this.callableFromModuleExport(fbNamed.mod, fbNamed.exportedName, calleeText);
    }

    // 5. Builtin function (`json_parse`, `iter_from_fn`, etc.)
    const builtin = BUILTIN_DOCS[calleeText];
    if (builtin) {
      return parseSignatureString(calleeText, builtin.sig, builtin.doc);
    }

    return undefined;
  }

  private callableFromModuleExport(
    mod: ModuleExports,
    member: string,
    displayName: string
  ): ResolvedCallable | undefined {
    const scheme = mod.values.get(member);
    if (!scheme) return undefined;
    const fnT = prune(scheme.type);
    if (fnT.kind !== "TFn") return undefined;
    const defaults = mod.valueDefaults.get(member);
    const doc = mod.valueDocs.get(member);
    return this.callableFromFnType(
      displayName,
      fnT,
      defaults,
      doc,
      mod.asyncValues.has(member) || Boolean(fnT.isAsync),
      mod.reifiedValues.has(member)
    );
  }

  private callableFromFnType(
    name: string,
    fnT: Extract<Type, { kind: "TFn" }>,
    defaults: (Expr | undefined)[] | undefined,
    doc: string | undefined,
    isAsync: boolean,
    isReified: boolean
  ): ResolvedCallable {
    const params: CallableParam[] = fnT.params.map((pt, i) => ({
      name: fnT.paramNames?.[i] ?? `arg${i}`,
      typeStr: formatType(pt),
      hasDefault: defaults ? defaults[i] !== undefined : false,
    }));
    return {
      name,
      params,
      returnTypeStr: formatType(fnT.ret),
      doc,
      isAsync,
      isReified,
    };
  }

  private completeMemberAccess(
    uri: string,
    text: string,
    pos: LspPosition,
    receiverExpr: string,
    receiverStartOffset: number,
    cursorOffset: number,
    op: string,
    memberPrefix: string
  ): LspCompletionItem[] {
    const fsPath = this.host.uriToPath(uri);

    // Strategy A1: Preserve exact receiver type (`{ let __lsp_probe = <recv>; __lsp_probe }`)
    // so mid-chain edits followed by `.push(6)` on subsequent lines STILL typecheck cleanly!
    const probeKeepType =
      text.slice(0, receiverStartOffset) +
      `{ let __lsp_probe = ${receiverExpr}; __lsp_probe }` +
      text.slice(cursorOffset);
    let probed = this.analyze(uri, probeKeepType).checked;

    // Strategy A2: Diverging `panic("")` probe when enclosing context expects a different type
    // (e.g. `fn foo(ev: ToolEvent) -> Str { ev. }`)
    if (!probed) {
      const probeDiverge =
        text.slice(0, receiverStartOffset) +
        `{ let __lsp_probe = ${receiverExpr}; panic("") }` +
        text.slice(cursorOffset);
      probed = this.analyze(uri, probeDiverge).checked;
    }

    // Strategy A3: Truncate everything AFTER the cursor and close open blocks with `panic("")`,
    // so unrelated errors BELOW the cursor (e.g. half-written lines later in the function)
    // NEVER break completion at the cursor!
    if (!probed) {
      const truncatedProbe = buildTruncatedPrefixProbe(text, receiverStartOffset, receiverExpr);
      probed = this.analyze(uri, truncatedProbe).checked;
    }

    // Strategy B: Fallback to stripping the incomplete line / last known good AST (e.g. namespace `fs.`)
    if (!probed) {
      const lines = text.split(/\r?\n/);
      const trimmedProbe = [...lines];
      trimmedProbe[pos.line] = "";
      probed = this.analyze(uri, trimmedProbe.join("\n")).checked ?? this.lastGoodChecked.get(this.host.normalizePath(fsPath));
    }

    const trimmedRecv = receiverExpr.trim();

    // Strategy C: Even if there are errors ABOVE the cursor so the full file didn't typecheck,
    // still resolve stdlib namespace imports (`fs.`, `llm.`, `col.`) or annotated identifiers (`arr: Array<Int>`).
    if (!probed) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedRecv)) {
        const fbImports = this.resolveImportsFallback(uri, text);
        const nsEntry = fbImports.namespaces.get(trimmedRecv);
        if (nsEntry) {
          return this.completeNamespace(nsEntry.mod, memberPrefix);
        }
        const fbType = inferAnnotatedTypeFromText(text, trimmedRecv);
        if (fbType) {
          let effType = fbType;
          if (op === "?." && effType.kind === "TEnum" && effType.name === "Option" && effType.typeArgs.length === 1) {
            effType = prune(effType.typeArgs[0]);
          }
          const emptyChecked = makeEmptyCheckedProgram(fsPath);
          // Populate imported extensions so stdlib methods (e.g. HashMap/List/TreeSet) still appear!
          for (const entry of fbImports.namespaces.values()) {
            for (const ext of entry.mod.extensions) emptyChecked.extensions.push(ext);
          }
          return this.completionsForType(effType, emptyChecked, memberPrefix);
        }
      }
      return [];
    }

    // Check if receiver is a module namespace (`fs`, `http`, `agent`, `col`, etc.)
    const ns = probed.namespaces.get(trimmedRecv);
    if (ns) {
      return this.completeNamespace(ns, memberPrefix);
    }

    // Find the inferred type of `__lsp_probe` (or match the variable directly in symbols)
    let recvType: Type | undefined;
    const probeSym = probed.symbols.find((s) => s.name === "__lsp_probe");
    if (probeSym?.type) {
      recvType = prune(probeSym.type);
    } else {
      const sym = findBestSymbol(probed, trimmedRecv, pos.line + 1);
      if (sym?.type) recvType = prune(sym.type);
    }

    if (!recvType) return [];

    // If `?.`, unwrap Option<T>
    if (op === "?." && recvType.kind === "TEnum" && recvType.name === "Option" && recvType.typeArgs.length === 1) {
      recvType = prune(recvType.typeArgs[0]);
    }

    return this.completionsForType(recvType, probed, memberPrefix);
  }

  private completeNamespace(ns: ModuleExports, prefix: string): LspCompletionItem[] {
    const items: LspCompletionItem[] = [];
    for (const [name, scheme] of ns.values) {
      if (prefix && !name.startsWith(prefix)) continue;
      const doc = ns.valueDocs.get(name);
      const isFn = prune(scheme.type).kind === "TFn";
      items.push({
        label: name,
        kind: isFn ? CK.Function : CK.Variable,
        detail: formatType(scheme.type),
        documentation: doc ? { kind: "markdown", value: doc } : undefined,
      });
    }
    for (const [name, td] of ns.types) {
      if (prefix && !name.startsWith(prefix)) continue;
      items.push({
        label: name,
        kind: CK.Struct,
        detail: `type ${name}`,
        documentation: td.doc ? { kind: "markdown", value: td.doc } : undefined,
      });
    }
    return items;
  }

  private completionsForType(t: Type, checked: CheckedProgram, prefix: string): LspCompletionItem[] {
    const items: LspCompletionItem[] = [];
    const seen = new Set<string>();
    const add = (item: LspCompletionItem) => {
      if (prefix && !item.label.startsWith(prefix)) return;
      if (seen.has(item.label)) return;
      seen.add(item.label);
      items.push(item);
    };

    const p = prune(t);

    // 1. Record / Struct fields (including row-polymorphic preserved fields!)
    if (p.kind === "TRecord") {
      const flat = flattenRecord(p);
      for (const [fieldName, fieldType] of flat.fields) {
        const fDoc = flat.meta?.fieldDocs.get(fieldName);
        const fHint = flat.meta?.fieldHints.get(fieldName);
        const md = formatDocAndHint(fDoc, fHint);
        add({
          label: fieldName,
          kind: CK.Field,
          detail: formatType(fieldType),
          documentation: md ? { kind: "markdown", value: md } : undefined,
          sortText: `0_${fieldName}`,
        });
      }
      if (flat.tail.kind === "ROpenDict") {
        const extraName = flat.tail.extraName ?? "extra";
        const valFmt = formatType(flat.tail.valueType);
        const docText = [
          formatDocAndHint(flat.tail.doc, flat.tail.llmHint),
          `Dynamic extra properties (\`Dict<Str, ${valFmt}>\`). Use bracket indexing \`obj["key"]\` -> \`${valFmt}?\` for dynamic keys.`,
        ]
          .filter(Boolean)
          .join("\n\n");
        add({
          label: extraName,
          kind: CK.Field,
          detail: `Dict<Str, ${valFmt}>`,
          documentation: { kind: "markdown", value: docText },
          sortText: `0_${extraName}`,
        });
      }
    }

    // 2. Built-in methods per type
    if (p.kind === "TArray") {
      const el = formatType(p.element);
      const builtins: [string, string, string][] = [
        ["len", "fn() -> Int", "Number of elements in the array."],
        ["get", `fn(index: Int) -> ${el}?`, "Bounds-checked element lookup."],
        ["set", `fn(index: Int, value: ${el}) -> Array<${el}>`, "Mutates the element at `index` in place and returns the array (panics if out of bounds)."],
        ["slice", `fn(start: Int, end: Int) -> Array<${el}>`, "Returns a sub-array slice."],
        ["concat", `fn(other: Array<${el}>) -> Array<${el}>`, "Concatenates two arrays into a new array."],
        ["push", `fn(item: ${el}) -> Array<${el}>`, "Appends `item` in place and returns the array."],
        ["pop", `fn() -> ${el}?`, "Removes and returns the last element in place (`Some(val)` or `None` if empty)."],
        ["swap", `fn(i: Int, j: Int) -> Array<${el}>`, "Swaps the elements at indices `i` and `j` in place and returns the array."],
        ["clear", `fn() -> Array<${el}>`, "Removes all elements from the array in place and returns the array."],
        ["map", `fn(f: fn(${el}) -> B) -> Array<B>`, "Maps elements sequentially (colorless async aware)."],
        ["par_map", `fn(f: fn(${el}) -> B) -> Array<B>`, "Maps elements concurrently (`Promise.all`)."],
        ["filter", `fn(f: fn(${el}) -> Bool) -> Array<${el}>`, "Filters elements matching predicate."],
        ["fold", `fn(init: B, f: fn(B, ${el}) -> B) -> B`, "Folds array from left to right."],
        ["flat_map", `fn(f: fn(${el}) -> Array<B>) -> Array<B>`, "Maps and flattens nested arrays."],
        ["find", `fn(f: fn(${el}) -> Bool) -> ${el}?`, "Finds the first matching element."],
        ["join", "fn(sep: Str) -> Str", "Joins an `Array<Str>` with separator."],
        ["iter", `fn() -> Iter<${el}>`, "Returns a lazy iterator over array elements."],
      ];
      for (const [label, detail, doc] of builtins) {
        add({ label, kind: CK.Method, detail, documentation: { kind: "markdown", value: doc }, sortText: `1_${label}` });
      }
    } else if (p.kind === "TIter") {
      const el = formatType(p.element);
      const builtins: [string, string, string][] = [
        ["next", `fn() -> ${el}?`, "Pulls the next element (`Some(x)` or `None`)."],
        ["map", `fn(f: fn(${el}) -> B) -> Iter<B>`, "Lazily transforms each element."],
        ["filter", `fn(pred: fn(${el}) -> Bool) -> Iter<${el}>`, "Lazily filters elements matching `pred`."],
        ["flat_map", `fn(f: fn(${el}) -> Iter<B>) -> Iter<B>`, "Lazily maps each element to an iterator and flattens."],
        ["take", `fn(n: Int) -> Iter<${el}>`, "Lazily yields at most `n` elements."],
        ["skip", `fn(n: Int) -> Iter<${el}>`, "Lazily skips the first `n` elements."],
        ["enumerate", `fn() -> Iter<(Int, ${el})>`, "Lazily yields `(index, element)` tuples."],
        ["zip", `fn(other: Iter<B>) -> Iter<(${el}, B)>`, "Lazily pairs elements with another iterator."],
        ["chain", `fn(other: Iter<${el}>) -> Iter<${el}>`, "Lazily yields all elements of `self` then `other`."],
        ["collect", `fn() -> Array<${el}>`, "Consumes the iterator into an `Array`."],
        ["to_array", `fn() -> Array<${el}>`, "Alias for `collect()`."],
        ["fold", `fn(init: B, f: fn(B, ${el}) -> B) -> B`, "Consumes the iterator with a left fold."],
        ["for_each", `fn(f: fn(${el}) -> Unit) -> Unit`, "Consumes the iterator calling `f` on each element."],
        ["find", `fn(pred: fn(${el}) -> Bool) -> ${el}?`, "Short-circuiting search for first matching element."],
        ["any", `fn(pred: fn(${el}) -> Bool) -> Bool`, "Short-circuiting existential check."],
        ["all", `fn(pred: fn(${el}) -> Bool) -> Bool`, "Short-circuiting universal check."],
        ["count", "fn() -> Int", "Consumes the iterator and counts remaining elements."],
      ];
      for (const [label, detail, doc] of builtins) {
        add({ label, kind: CK.Method, detail, documentation: { kind: "markdown", value: doc }, sortText: `1_${label}` });
      }
    } else if (p.kind === "TPrim" && p.name === "Str") {
      const builtins: [string, string, string][] = [
        ["len", "fn() -> Int", "Number of UTF-16 code units in the string."],
        ["trim", "fn() -> Str", "Removes leading and trailing whitespace."],
        ["to_upper", "fn() -> Str", "Converts the string to uppercase."],
        ["to_lower", "fn() -> Str", "Converts the string to lowercase."],
        ["slice", "fn(start: Int, end: Int) -> Str", "Returns the substring from `start` (inclusive) to `end` (exclusive)."],
        ["split", "fn(sep: Str) -> Array<Str>", "Splits the string on separator `sep`."],
        ["starts_with", "fn(prefix: Str) -> Bool", "Returns `true` if the string begins with `prefix`."],
        ["ends_with", "fn(suffix: Str) -> Bool", "Returns `true` if the string ends with `suffix`."],
        ["contains", "fn(sub: Str) -> Bool", "Returns `true` if `sub` occurs anywhere in the string."],
        ["index_of", "fn(sub: Str) -> Int?", "Returns `Some(index)` of the first occurrence of `sub`, or `None`."],
        ["replace", "fn(from: Str, to: Str) -> Str", "Replaces all occurrences of `from` with `to`."],
        ["chars", "fn() -> Iter<Char>", "Returns a lazy iterator over the Unicode characters (`Char`) of the string."],
        ["bytes", "fn() -> Iter<Byte>", "Returns a lazy iterator over the UTF-8 bytes (`Byte`) of the string."],
      ];
      for (const [label, detail, doc] of builtins) {
        add({ label, kind: CK.Method, detail, documentation: { kind: "markdown", value: doc }, sortText: `1_${label}` });
      }
    } else if (p.kind === "TDict") {
      const k = formatType(p.key);
      const v = formatType(p.value);
      const builtins: [string, string, string][] = [
        ["len", "fn() -> Int", "Number of key-value entries in the dictionary."],
        ["get", `fn(key: ${k}) -> ${v}?`, "Looks up `key`, returning `Some(value)` or `None`."],
        ["set", `fn(key: ${k}, value: ${v}) -> Dict<${k}, ${v}>`, "Returns a new `Dict` with `key -> value` inserted or updated."],
        ["delete", `fn(key: ${k}) -> Dict<${k}, ${v}>`, "Returns a new `Dict` with `key` removed."],
        ["entries", `fn() -> Array<(${k}, ${v})>`, "Returns all `(key, value)` pairs as an array."],
        ["iter", `fn() -> Iter<(${k}, ${v})>`, "Returns a lazy iterator over `(key, value)` pairs."],
        ["keys_iter", `fn() -> Iter<${k}>`, "Returns a lazy iterator over keys."],
        ["values_iter", `fn() -> Iter<${v}>`, "Returns a lazy iterator over values."],
      ];
      for (const [label, detail, doc] of builtins) {
        add({ label, kind: CK.Method, detail, documentation: { kind: "markdown", value: doc }, sortText: `1_${label}` });
      }
    } else if (p.kind === "TEnum" && p.name === "Option") {
      const inner = formatType(p.typeArgs[0]);
      add({ label: "unwrap_or", kind: CK.Method, detail: `fn(default: ${inner}) -> ${inner}`, documentation: { kind: "markdown", value: "Returns the contained value if `Some`, otherwise `default`." }, sortText: "1_unwrap_or" });
      add({ label: "map", kind: CK.Method, detail: `fn(f: fn(${inner}) -> B) -> B?`, documentation: { kind: "markdown", value: "Applies `f` to the contained value if `Some`, returning `None` otherwise." }, sortText: "1_map" });
      add({ label: "is_some", kind: CK.Method, detail: "fn() -> Bool", documentation: { kind: "markdown", value: "Returns `true` if the option is `Some(...)`." }, sortText: "1_is_some" });
      add({ label: "is_none", kind: CK.Method, detail: "fn() -> Bool", documentation: { kind: "markdown", value: "Returns `true` if the option is `None`." }, sortText: "1_is_none" });
    } else if (p.kind === "TEnum" && p.name === "Result") {
      const ok = formatType(p.typeArgs[0]);
      const err = formatType(p.typeArgs[1]);
      add({ label: "unwrap_or", kind: CK.Method, detail: `fn(default: ${ok}) -> ${ok}`, documentation: { kind: "markdown", value: "Returns the `Ok` value, or `default` if `Err`." }, sortText: "1_unwrap_or" });
      add({ label: "map", kind: CK.Method, detail: `fn(f: fn(${ok}) -> B) -> Result<B, ${err}>`, documentation: { kind: "markdown", value: "Transforms the `Ok` value using `f`, leaving `Err` unchanged." }, sortText: "1_map" });
      add({ label: "is_ok", kind: CK.Method, detail: "fn() -> Bool", documentation: { kind: "markdown", value: "Returns `true` if the result is `Ok(...)`." }, sortText: "1_is_ok" });
      add({ label: "is_err", kind: CK.Method, detail: "fn() -> Bool", documentation: { kind: "markdown", value: "Returns `true` if the result is `Err(...)`." }, sortText: "1_is_err" });
    } else if (p.kind === "TPrim" && p.name === "Prompt") {
      add({ label: "text", kind: CK.Property, detail: "Str", documentation: { kind: "markdown", value: "Rendered prompt text string." }, sortText: "0_text" });
      add({ label: "parts", kind: CK.Property, detail: "Array<Str>", documentation: { kind: "markdown", value: "Static text segments of the prompt template." }, sortText: "0_parts" });
      add({ label: "render", kind: CK.Method, detail: "fn() -> Str", documentation: { kind: "markdown", value: "Renders the prompt template with interpolated values into a `Str`." }, sortText: "1_render" });
    }

    // 3. Extension methods in scope structurally matching `p`
    for (const ext of checked.extensions) {
      if (structurallyMatches(ext.receiverType, p)) {
        add({
          label: ext.name,
          kind: CK.Method,
          detail: `(extension) ${formatType(ext.fnType)}`,
          documentation: ext.doc ? { kind: "markdown", value: ext.doc } : undefined,
          sortText: `2_${ext.name}`,
        });
      }
    }

    // 4. Trait impl methods matching `p`'s canonical shape
    const shapeKey = canonicalShapeKey(p);
    for (const impl of checked.traitImpls) {
      if (impl.shapeKey !== shapeKey) continue;
      for (const [mName, mInfo] of impl.methods) {
        add({
          label: mName,
          kind: CK.Method,
          detail: `(trait ${impl.traitName}) ${formatType(mInfo.fnType)}`,
          sortText: `2_${mName}`,
        });
      }
    }

    return items;
  }

  private completeScopeIdentifiers(
    checked: CheckedProgram | undefined,
    pos: LspPosition,
    prefix: string
  ): LspCompletionItem[] {
    const items: LspCompletionItem[] = [];
    const seen = new Set<string>();
    const add = (item: LspCompletionItem) => {
      if (prefix && !item.label.startsWith(prefix)) return;
      if (seen.has(item.label)) return;
      seen.add(item.label);
      items.push(item);
    };

    const targetLine = pos.line + 1;
    if (checked) {
      for (const sym of checked.symbols) {
        if (sym.name === "__lsp_probe") continue;
        if (sym.scopeSpan && (targetLine < sym.scopeSpan.line || (sym.scopeSpan.endLine && targetLine > sym.scopeSpan.endLine))) {
          continue;
        }
        const kindMap: Record<string, number> = {
          fn: CK.Function,
          extern: CK.Function,
          type: CK.Struct,
          enum: CK.Enum,
          variant: CK.EnumMember,
          trait: CK.Interface,
          var: CK.Variable,
          param: CK.Variable,
          extension: CK.Method,
        };
        const md = formatDocAndHint(sym.doc, sym.llmHint);
        add({
          label: sym.name,
          kind: kindMap[sym.kind] ?? CK.Variable,
          detail: sym.type ? formatType(sym.type) : sym.kind,
          documentation: md ? { kind: "markdown", value: md } : undefined,
        });
      }

      for (const alias of checked.namespaces.keys()) {
        add({ label: alias, kind: CK.Module, detail: `module ${alias}` });
      }
    }

    // Built-in intrinsics & prelude
    add({
      label: "type_schema",
      kind: CK.Function,
      detail: "intrinsic type_schema<T>() -> Json",
      documentation: { kind: "markdown", value: "Compile-time JSON Schema generator for static type `T` (includes `''` LLM hints)." },
    });
    add({
      label: "decode",
      kind: CK.Function,
      detail: "intrinsic decode<T>(json: Json) -> Result<T, DecodeError>",
      documentation: { kind: "markdown", value: "Compile-time generated runtime validator/decoder for static type `T`." },
    });
    for (const [bName, bSig] of [
      ["Some", "fn<T>(value: T) -> T?"],
      ["None", "Option<T>"],
      ["Ok", "fn<T, E>(value: T) -> Result<T, E>"],
      ["Err", "fn<T, E>(error: E) -> Result<T, E>"],
      ["json_parse", "fn(s: Str) -> Result<Json, Str>"],
      ["json_stringify", "fn<T>(val: T) -> Str"],
      ["to_json", "fn<T>(val: T) -> Json"],
      ["print", "fn<T>(val: T) -> Unit"],
      ["print_inline", "fn<T>(val: T) -> Unit"],
      ["to_str", "fn<T>(val: T) -> Str"],
      ["panic", "fn(msg: Str) -> Never"],
      ["dict_empty", "fn<K, V>() -> Dict<K, V>"],
      ["iter_from_fn", "fn<T>(next: fn() -> T?) -> Iter<T>"],
    ] as const) {
      add({ label: bName, kind: CK.Function, detail: bSig });
    }

    for (const pt of PRIMITIVE_TYPES) {
      add({ label: pt, kind: CK.Struct, detail: "primitive type" });
    }
    for (const kw of KEYWORDS) {
      add({ label: kw, kind: CK.Keyword, detail: "keyword" });
    }

    return items;
  }

  // ==================== Hover ====================

  getHover(uri: string, pos: LspPosition): LspHover | null {
    const text = this.getDocumentText(uri);
    if (!text) return null;
    const { checked } = this.analyze(uri);
    const active = checked ?? this.lastGoodChecked.get(this.host.normalizePath(this.host.uriToPath(uri)));

    const line = pos.line + 1;
    const col = pos.character + 1;
    const word = wordAtPosition(text, pos);

    // 1. Check `type_schema<T>()` hover -> show live generated JSON Schema!
    if (active) {
      for (const [expr, schema] of active.schemaLiterals) {
        if (spanContains(expr.span, line, col)) {
          const md = [
            "```splx",
            "type_schema<T>() -> Json",
            "```",
            BUILTIN_DOCS.type_schema.doc,
            "",
            "**Generated JSON Schema:**",
            "```json",
            JSON.stringify(schema, null, 2),
            "```",
          ].join("\n");
          return { contents: { kind: "markdown", value: md }, range: spanToRange(expr.span, text) };
        }
      }
    }

    // 2. Check member/namespace hover (`fs.read`, `llm.ask`, `arr.get`, `scores.put`, `user.firstName`)
    const memberHover = this.hoverMemberOrNamespace(uri, text, pos, active);
    if (memberHover) return memberHover;

    // 3. Find innermost expression covering (line, col)
    if (active) {
      let bestExpr: Expr | undefined;
      let bestSize = Infinity;
      for (const expr of active.exprTypes.keys()) {
        if (spanContains(expr.span, line, col)) {
          const size = spanSize(expr.span);
          const preferTie =
            size === bestSize &&
            bestExpr !== undefined &&
            expr.kind === "IdentExpr" &&
            bestExpr.kind !== "IdentExpr";
          if (size < bestSize || preferTie) {
            bestSize = size;
            bestExpr = expr;
          }
        }
      }

      if (bestExpr) {
        const exprType = active.exprTypes.get(bestExpr)!;
        if (bestExpr.kind === "DecodeExpr" && word?.text === "decode") {
          const parts = [
            "```splx",
            `${BUILTIN_DOCS.decode.sig}  // -> ${formatType(exprType)}`,
            "```",
            "",
            BUILTIN_DOCS.decode.doc,
          ];
          return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
        }

        if (bestExpr.kind === "IdentExpr" && active.namespaces.has(bestExpr.name)) {
          const spec = active.namespaceImports.get(bestExpr.name);
          const stdInfo = spec ? STD_MODULES.find((m) => m.name === spec) : undefined;
          const parts = ["```splx", `module ${bestExpr.name}${spec ? ` ("${spec}")` : ""}`, "```"];
          if (stdInfo) parts.push("", stdInfo.desc);
          return { contents: { kind: "markdown", value: parts.join("\n") }, range: spanToRange(bestExpr.span, text) };
        }

        const defInfo = active.identDefs.get(bestExpr);
        const builtinInfo = bestExpr.kind === "IdentExpr" ? BUILTIN_DOCS[bestExpr.name] : undefined;
        const label =
          bestExpr.kind === "IdentExpr"
            ? `${defInfo?.kind ?? (builtinInfo ? "builtin" : "val")} ${bestExpr.name}: ${formatType(exprType)}`
            : formatType(exprType);
        const parts = ["```splx", label, "```"];
        const docText = defInfo?.doc ?? builtinInfo?.doc;
        if (docText) parts.push("", docText);
        return { contents: { kind: "markdown", value: parts.join("\n") }, range: spanToRange(bestExpr.span, text) };
      }
    }

    // 4. Fallback word lookup (local symbols, builtins, primitive types, and stdlib imports even when file has errors!)
    if (word) {
      if (active) {
        const sym = findBestSymbol(active, word.text, line);
        if (sym) {
          const typeStr = sym.type ? `: ${formatType(sym.type)}` : "";
          const parts = ["```splx", `${sym.kind} ${sym.name}${typeStr}`, "```"];
          const md = formatDocAndHint(sym.doc, sym.llmHint);
          if (md) parts.push("", md);
          return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
        }
      }

      const builtinInfo = BUILTIN_DOCS[word.text];
      if (builtinInfo) {
        const parts = ["```splx", builtinInfo.sig, "```", "", builtinInfo.doc];
        return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
      }

      const primDoc = PRIMITIVE_TYPE_DOCS[word.text];
      if (primDoc) {
        const parts = ["```splx", `type ${word.text}`, "```", "", primDoc];
        return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
      }

      // Check fallback imported modules (e.g. `import { save_jsonl } from "std/traces"` or namespace alias `llm`)
      const fallbackImports = this.resolveImportsFallback(uri, text);
      const nsEntry = fallbackImports.namespaces.get(word.text);
      if (nsEntry) {
        const stdInfo = STD_MODULES.find((m) => m.name === nsEntry.spec);
        const parts = ["```splx", `module ${word.text} ("${nsEntry.spec}")`, "```"];
        if (stdInfo) parts.push("", stdInfo.desc);
        return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
      }
      const named = fallbackImports.namedExports.get(word.text);
      if (named) {
        return this.formatModuleMemberHover(named.mod, named.exportedName, word.range);
      }
    }

    return null;
  }

  private formatModuleMemberHover(mod: ModuleExports, member: string, range: LspRange): LspHover | null {
    const valScheme = mod.values.get(member);
    if (valScheme) {
      const doc = mod.valueDocs.get(member);
      const isFn = prune(valScheme.type).kind === "TFn";
      const isAsync = mod.asyncValues.has(member);
      const isReified = mod.reifiedValues.has(member);
      const prefix = isFn
        ? `${isAsync ? "async " : ""}${isReified ? "reified " : ""}fn`
        : "val";
      const parts = ["```splx", `${prefix} ${member}: ${formatType(valScheme.type)}`, "```"];
      if (doc) parts.push("", doc);
      return { contents: { kind: "markdown", value: parts.join("\n") }, range };
    }
    const td = mod.types.get(member);
    if (td) {
      const tp = td.typeParams.length > 0 ? `<${td.typeParams.join(", ")}>` : "";
      const parts = ["```splx", `type ${member}${tp}`, "```"];
      const md = formatDocAndHint(td.doc, td.llmHint);
      if (md) parts.push("", md);
      return { contents: { kind: "markdown", value: parts.join("\n") }, range };
    }
    const ed = mod.enums.get(member);
    if (ed) {
      const tp = ed.typeParams.length > 0 ? `<${ed.typeParams.join(", ")}>` : "";
      const parts = ["```splx", `enum ${member}${tp}`, "```"];
      const md = formatDocAndHint(ed.doc, ed.llmHint);
      if (md) parts.push("", md);
      return { contents: { kind: "markdown", value: parts.join("\n") }, range };
    }
    const tr = mod.traits.get(member);
    if (tr) {
      const parts = ["```splx", `trait ${member}`, "```"];
      if (tr.doc) parts.push("", tr.doc);
      return { contents: { kind: "markdown", value: parts.join("\n") }, range };
    }
    return null;
  }

  private hoverMemberOrNamespace(
    uri: string,
    text: string,
    pos: LspPosition,
    active: CheckedProgram | undefined
  ): LspHover | null {
    const word = wordAtPosition(text, pos);
    if (!word) return null;

    const lineStartOffset = positionToOffset(text, { line: pos.line, character: 0 });
    const wordStartOffset = lineStartOffset + word.range.start.character;
    const beforeWord = skipTriviaBackward(text, wordStartOffset - 1);
    if (beforeWord < 0 || text[beforeWord] !== ".") return null;
    // Ignore range `..` / `..=` / spread `...`
    if (beforeWord > 0 && text[beforeWord - 1] === ".") return null;

    const isOpt = beforeWord > 0 && text[beforeWord - 1] === "?";
    const dotStart = isOpt ? beforeWord - 1 : beforeWord;
    const recvInfo = extractTrailingReceiverOffset(text, dotStart);
    if (!recvInfo) return null;

    const trimmedRecv = recvInfo.exprText.trim();

    // 1. Check module namespace member (`fs.read`, `llm.ask`, `codegen.llm_fn`, `traces.save_jsonl`, `col.map_new`)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedRecv)) {
      const nsMod = active?.namespaces.get(trimmedRecv) ?? this.resolveImportsFallback(uri, text).namespaces.get(trimmedRecv)?.mod;
      if (nsMod) {
        return this.formatModuleMemberHover(nsMod, word.text, word.range);
      }
    }

    // 2. Check receiver member/method (`arr.get`, `scores.put`, `trace.save_jsonl`, `s.trim`, `user.firstName`)
    const wordEndOffset = lineStartOffset + word.range.end.character;
    const items = this.completeMemberAccess(
      uri,
      text,
      pos,
      recvInfo.exprText,
      recvInfo.startOffset,
      wordEndOffset,
      isOpt ? "?." : ".",
      word.text
    );
    const exact = items.find((it) => it.label === word.text);
    if (exact) {
      const parts = ["```splx", `${exact.label}: ${exact.detail ?? ""}`, "```"];
      if (exact.documentation?.value) parts.push("", exact.documentation.value);
      return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
    }

    // 3. Fallback when file has errors so `completeMemberAccess` failed: inspect simple local `name: Type` annotation!
    if (!active && /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedRecv)) {
      const fallbackType = inferAnnotatedTypeFromText(text, trimmedRecv);
      if (fallbackType) {
        const fakeChecked = makeEmptyCheckedProgram(this.host.uriToPath(uri));
        const fallbackItems = this.completionsForType(fallbackType, fakeChecked, word.text);
        const exactFb = fallbackItems.find((it) => it.label === word.text);
        if (exactFb) {
          const parts = ["```splx", `${exactFb.label}: ${exactFb.detail ?? ""}`, "```"];
          if (exactFb.documentation?.value) parts.push("", exactFb.documentation.value);
          return { contents: { kind: "markdown", value: parts.join("\n") }, range: word.range };
        }
      }
    }

    return null;
  }

  private resolveImportsFallback(
    uri: string,
    text: string
  ): {
    namespaces: Map<string, { spec: string; mod: ModuleExports }>;
    namedExports: Map<string, { mod: ModuleExports; exportedName: string }>;
  } {
    const namespaces = new Map<string, { spec: string; mod: ModuleExports }>();
    const namedExports = new Map<string, { mod: ModuleExports; exportedName: string }>();
    const fsPath = this.host.uriToPath(uri);
    const cache = new Map<string, ModuleExports>();

    const loadMod = (spec: string, fromFile: string): ModuleExports => {
      const resolved = this.host.resolveModuleSpec(spec, fromFile);
      const key = this.host.normalizePath(resolved.sourcePath);
      const cached = cache.get(key);
      if (cached) return cached;
      const src = this.openDocs.get(key) ?? this.host.readFile(resolved.sourcePath);
      if (src === undefined) throw new SplError("module", `Cannot read module '${spec}'`);
      const prog = parse(src, resolved.sourcePath, resolved.isStdlib);
      const checked = checkProgram(prog, (subSpec, subFrom) => loadMod(subSpec, subFrom));
      cache.set(key, checked.exports);
      return checked.exports;
    };

    const importRe = /^\s*import\s+(.+?)\s+from\s+"([^"]+)"/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) {
      const clause = m[1].trim();
      const spec = m[2].trim();
      try {
        const mod = loadMod(spec, fsPath);
        // Default namespace alias: `import fs from "std/fs"` or `import llm, { Approve } from "std/llm"`
        const defMatch = clause.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (defMatch) {
          namespaces.set(defMatch[1], { spec, mod });
        }
        // Named specifiers: `{ a, b as c }`
        const braceMatch = clause.match(/\{([^}]+)\}/);
        if (braceMatch) {
          for (const part of braceMatch[1].split(",")) {
            const p = part.trim();
            if (!p) continue;
            const asMatch = p.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
            if (asMatch) {
              namedExports.set(asMatch[2], { mod, exportedName: asMatch[1] });
            } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
              namedExports.set(p, { mod, exportedName: p });
            }
          }
        }
      } catch {
        // ignore unresolvable import
      }
    }

    return { namespaces, namedExports };
  }

  // ==================== Go to Definition ====================

  getDefinition(uri: string, pos: LspPosition): LspLocation | null {
    const text = this.getDocumentText(uri);
    if (!text) return null;
    const { checked } = this.analyze(uri);
    const active = checked ?? this.lastGoodChecked.get(this.host.normalizePath(this.host.uriToPath(uri)));
    if (!active) return null;

    const line = pos.line + 1;
    const col = pos.character + 1;

    // 1. Check `identDefs` on expressions
    for (const [expr, info] of active.identDefs) {
      if (spanContains(expr.span, line, col)) {
        return this.spanToLocation(info.span);
      }
    }

    // 2. Check namespace member call e.g. `fs.read` -> jump to `read` in `stdlib/fs.splx`
    const lineText = text.split(/\r?\n/)[pos.line] ?? "";
    const nsMember = extractNamespaceMemberAt(lineText, pos.character);
    if (nsMember) {
      const mod = active.namespaces.get(nsMember.ns);
      const targetSpan = mod?.valueSpans.get(nsMember.member) ?? mod?.types.get(nsMember.member)?.span;
      if (targetSpan) return this.spanToLocation(targetSpan);
    }

    // 3. Check type/enum/fn symbol by word
    const word = wordAtPosition(text, pos);
    if (word) {
      const sym = findBestSymbol(active, word.text, line);
      if (sym) return this.spanToLocation(sym.span);
    }

    return null;
  }

  // ==================== Document Symbols ====================

  getDocumentSymbols(uri: string): LspDocumentSymbol[] {
    const text = this.getDocumentText(uri);
    if (!text) return [];
    let program;
    try {
      program = parse(text, this.host.uriToPath(uri), false);
    } catch {
      const cached = this.lastGoodChecked.get(this.host.normalizePath(this.host.uriToPath(uri)));
      if (!cached) return [];
      program = cached.program;
    }

    const out: LspDocumentSymbol[] = [];
    for (const item of program.items) {
      const range = spanToRange(item.span, text);
      switch (item.kind) {
        case "TypeDecl": {
          const children: LspDocumentSymbol[] = [];
          if (item.body.kind === "RecordTypeExpr") {
            for (const f of item.body.fields) {
              const r = spanToRange(f.span, text);
              children.push({
                name: f.name,
                detail: f.doc,
                kind: SK.Field,
                range: r,
                selectionRange: r,
              });
            }
          }
          out.push({
            name: item.name,
            detail: item.doc?.split("\n")[0],
            kind: SK.Struct,
            range,
            selectionRange: range,
            children,
          });
          break;
        }
        case "EnumDecl": {
          const children = item.variants.map((v) => {
            const r = spanToRange(v.span, text);
            return { name: v.name, detail: v.doc, kind: SK.EnumMember, range: r, selectionRange: r };
          });
          out.push({
            name: item.name,
            detail: item.doc?.split("\n")[0],
            kind: SK.Enum,
            range,
            selectionRange: range,
            children,
          });
          break;
        }
        case "TraitDecl":
          out.push({ name: item.name, kind: SK.Interface, range, selectionRange: range });
          break;
        case "FnDecl":
          out.push({
            name: item.receiverType ? `*.${item.name}` : item.name,
            kind: SK.Function,
            range,
            selectionRange: range,
          });
          break;
        case "ExternFnDecl":
          out.push({
            name: item.name,
            detail: `extern ${item.jsModule}:${item.jsName}`,
            kind: SK.Function,
            range,
            selectionRange: range,
          });
          break;
        case "LetStmt":
          if (item.pattern.kind === "IdentPattern") {
            out.push({ name: item.pattern.name, kind: SK.Variable, range, selectionRange: range });
          }
          break;
      }
    }
    return out;
  }

  private spanToLocation(span: Span): LspLocation {
    const uri = span.file.startsWith("file://") ? span.file : this.host.pathToUri(span.file);
    return {
      uri,
      range: {
        start: { line: Math.max(0, span.line - 1), character: Math.max(0, span.col - 1) },
        end: {
          line: Math.max(0, (span.endLine ?? span.line) - 1),
          character: Math.max(0, (span.endCol ?? span.col + 1) - 1),
        },
      },
    };
  }
}

// ==================== Helpers ====================

function spanToRange(span: Span | undefined, text: string): LspRange {
  if (!span) return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const sLine = Math.max(0, span.line - 1);
  const sCol = Math.max(0, span.col - 1);
  const eLine = Math.max(sLine, (span.endLine ?? span.line) - 1);
  let eCol = Math.max(0, (span.endCol ?? span.col + 1) - 1);
  if (eLine === sLine && eCol <= sCol) {
    const lineLen = (text.split(/\r?\n/)[sLine] ?? "").length;
    eCol = Math.min(lineLen, sCol + 1);
  }
  return {
    start: { line: sLine, character: sCol },
    end: { line: eLine, character: eCol },
  };
}

function spanContains(span: Span, line: number, col: number): boolean {
  const endLine = span.endLine ?? span.line;
  const endCol = span.endCol ?? span.col + 1;
  if (line < span.line || line > endLine) return false;
  if (line === span.line && col < span.col) return false;
  if (line === endLine && col > endCol) return false;
  return true;
}

function spanSize(span: Span): number {
  const endLine = span.endLine ?? span.line;
  const endCol = span.endCol ?? span.col + 1;
  return (endLine - span.line) * 10000 + Math.max(0, endCol - span.col);
}

function positionToOffset(text: string, pos: LspPosition): number {
  let line = 0;
  let i = 0;
  while (line < pos.line && i < text.length) {
    if (text[i] === "\n") line++;
    i++;
  }
  return Math.min(text.length, i + pos.character);
}

/** Skip whitespace and `//` / `///` / `''` comments moving backwards from `idx` */
function skipTriviaBackward(text: string, idx: number): number {
  let i = idx;
  while (i >= 0) {
    // Skip whitespace
    while (i >= 0 && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) {
      i--;
    }
    if (i < 0) break;
    // Check if `i` sits inside a line comment (`//` or `''`) on the current line
    const lineStart = text.lastIndexOf("\n", i) + 1;
    const linePrefix = text.slice(lineStart, i + 1);
    const commentIdx = findLineCommentStart(linePrefix);
    if (commentIdx !== -1) {
      i = lineStart + commentIdx - 1;
      continue;
    }
    break;
  }
  return i;
}

function findLineCommentStart(line: string): number {
  let inStr = false;
  let inChar = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (inChar) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inChar = false;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "/" && line[i + 1] === "/") return i;
    if (ch === "'" && line[i + 1] === "'") return i;
    if (ch === "'") { inChar = true; continue; }
  }
  return -1;
}

/** Find matching opening delimiter walking backwards from closing `closeIdx` (`)`, `]`, `}`, or `>`) */
function findMatchingOpen(text: string, closeIdx: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = closeIdx;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "\"" || ch === "'") {
      // Skip string/char literal backwards conservatively
      const quote = ch;
      i--;
      while (i >= 0) {
        if (text[i] === quote && text[i - 1] !== "\\") break;
        i--;
      }
      i--;
      continue;
    }
    if (ch === closeCh) depth++;
    else if (ch === openCh) {
      depth--;
      if (depth === 0) return i;
    }
    i--;
  }
  return -1;
}

/**
 * Walk backwards across the full document from `dotOffset` to extract the full receiver
 * expression of a `.` or `?.` access — supporting single-line & multi-line method chains,
 * trailing lambdas (`.filter { n -> ... }`), generic calls (`fn<A, B>(...)`), indexers,
 * and postfix `?` propagation.
 */
function extractTrailingReceiverOffset(
  text: string,
  dotOffset: number
): { exprText: string; startOffset: number } | null {
  const endIdx = skipTriviaBackward(text, dotOffset - 1);
  if (endIdx < 0) return null;

  let i = endIdx;
  let startOffset = -1;

  while (i >= 0) {
    // 1. Optional postfix `?` (error propagation like `calc({ a: 1 })?.`)
    if (text[i] === "?" && text[i - 1] !== "?") {
      i = skipTriviaBackward(text, i - 1);
      continue;
    }

    // 2. Trailing call/index/lambda/record group: `(...)`, `[...]`, `{...}`
    if (text[i] === ")" || text[i] === "]" || text[i] === "}") {
      const closeCh = text[i];
      const openCh = closeCh === ")" ? "(" : closeCh === "]" ? "[" : "{";
      const openIdx = findMatchingOpen(text, i, openCh, closeCh);
      if (openIdx < 0) break;
      startOffset = openIdx;

      // Check for prompt prefix `@{`
      if (openCh === "{" && openIdx > 0 && text[openIdx - 1] === "@") {
        startOffset = openIdx - 1;
        i = openIdx - 2;
      } else {
        i = openIdx - 1;
      }

      // Skip horizontal whitespace before `(` or `{` (e.g. `.filter { ... }` or `agent(...) @{ ... }`)
      let prev = i;
      while (prev >= 0 && (text[prev] === " " || text[prev] === "\t")) prev--;

      // Generic type arguments before `(`: e.g. `js_fn<CalcIn, CalcOut>(...)`
      if (closeCh === ")" && prev >= 0 && text[prev] === ">") {
        const ltIdx = findMatchingOpen(text, prev, "<", ">");
        if (ltIdx >= 0) {
          startOffset = ltIdx;
          prev = ltIdx - 1;
        }
      }

      // If preceded by an identifier, closing delimiter, or `?`, keep walking the same call/chain!
      if (
        prev >= 0 &&
        (/[A-Za-z0-9_)\]}]/.test(text[prev]) || text[prev] === "?")
      ) {
        // Don't swallow a preceding keyword like `return`, `let`, `if`, `else`, `in`, `match`
        if (/[A-Za-z0-9_]/.test(text[prev])) {
          let wStart = prev;
          while (wStart > 0 && /[A-Za-z0-9_]/.test(text[wStart - 1])) wStart--;
          const word = text.slice(wStart, prev + 1);
          if (["return", "if", "else", "match", "while", "let", "mut", "in"].includes(word)) {
            break;
          }
        }
        i = prev;
        continue;
      }
      break;
    }

    // 3. String literal receiver `"hello".`
    if (text[i] === "\"") {
      let s = i - 1;
      while (s >= 0 && !(text[s] === "\"" && text[s - 1] !== "\\")) s--;
      if (s < 0) break;
      startOffset = s;
      break;
    }

    // 4. Identifier segment (e.g. `nums`, `push`, `take`, `col`)
    if (/[A-Za-z0-9_]/.test(text[i])) {
      let idStart = i;
      while (idStart > 0 && /[A-Za-z0-9_]/.test(text[idStart - 1])) idStart--;
      startOffset = idStart;

      // Check if preceded by `.` or `?.` (possibly across newlines/comments!)
      const beforeId = skipTriviaBackward(text, idStart - 1);
      if (beforeId >= 0 && text[beforeId] === ".") {
        const beforeDot = beforeId > 0 && text[beforeId - 1] === "?" ? beforeId - 2 : beforeId - 1;
        const nextIdx = skipTriviaBackward(text, beforeDot);
        if (nextIdx >= 0) {
          i = nextIdx;
          continue;
        }
      }
      break;
    }

    break;
  }

  if (startOffset < 0 || startOffset > endIdx) return null;
  const exprText = text.slice(startOffset, endIdx + 1).trim();
  if (!exprText) return null;
  return { exprText, startOffset };
}

function wordAtPosition(text: string, pos: LspPosition): { text: string; range: LspRange } | null {
  const line = text.split(/\r?\n/)[pos.line] ?? "";
  let s = pos.character;
  let e = pos.character;
  while (s > 0 && /[A-Za-z0-9_]/.test(line[s - 1])) s--;
  while (e < line.length && /[A-Za-z0-9_]/.test(line[e])) e++;
  if (e <= s) return null;
  return {
    text: line.slice(s, e),
    range: { start: { line: pos.line, character: s }, end: { line: pos.line, character: e } },
  };
}

function extractNamespaceMemberAt(line: string, character: number): { ns: string; member: string } | null {
  let s = character;
  let e = character;
  while (s > 0 && /[A-Za-z0-9_]/.test(line[s - 1])) s--;
  while (e < line.length && /[A-Za-z0-9_]/.test(line[e])) e++;
  if (s >= 2 && line[s - 1] === ".") {
    let nsStart = s - 1;
    while (nsStart > 0 && /[A-Za-z0-9_]/.test(line[nsStart - 1])) nsStart--;
    const ns = line.slice(nsStart, s - 1);
    const member = line.slice(s, e);
    if (ns && member) return { ns, member };
  }
  return null;
}

function findBestSymbol(checked: CheckedProgram, name: string, line: number) {
  const candidates = checked.symbols.filter((s) => s.name === name);
  if (candidates.length === 0) return undefined;
  // Prefer local symbol in scope, else top-level
  const inScope = candidates.find(
    (s) => s.scopeSpan && line >= s.scopeSpan.line && (!s.scopeSpan.endLine || line <= s.scopeSpan.endLine)
  );
  return inScope ?? candidates[0];
}

function formatDocAndHint(doc?: string, llmHint?: string): string | undefined {
  const parts: string[] = [];
  if (doc) parts.push(doc);
  if (llmHint) parts.push(`**LLM hint:** ${llmHint}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function makeEmptyCheckedProgram(file: string): CheckedProgram {
  return {
    program: { file, isStdlib: false, items: [] },
    exports: {
      file: "", values: new Map(), valueSpans: new Map(), valueDocs: new Map(), valueDefaults: new Map(),
      asyncValues: new Set(), reifiedValues: new Set(), types: new Map(), enums: new Map(),
      traits: new Map(), extensions: [], traitImpls: [],
    },
    exprTypes: new Map(), callResolutions: new Map(), forResolutions: new Map(), castResolutions: new Map(),
    schemaLiterals: new Map(), decodeCodecs: new Map(), reifiedExprTypes: new Map(), asyncFns: new Set(), asyncCalls: new Set(),
    extensionJsSymbols: new Map(), traitImplJsSymbols: new Map(), fnReifiedParams: new Map(),
    namedParamDefaults: new Map(), importBindings: new Map(), namespaceImports: new Map(),
    symbols: [], identDefs: new Map(), namespaces: new Map(), extensions: [], traitImpls: [],
  };
}

/**
 * Builds a truncated source probe up to `receiverStartOffset`, inserts
 * `{ let __lsp_probe = <receiverExpr>; panic("") }`, and closes all open delimiters
 * (ending the outermost block with `panic("")`) so errors BELOW the cursor never
 * block completion at the cursor.
 */
function buildTruncatedPrefixProbe(text: string, receiverStartOffset: number, receiverExpr: string): string {
  const prefix = text.slice(0, receiverStartOffset);
  const stack: ("{" | "(" | "[")[] = [];
  let inStr = false;
  let inChar = false;
  let inLineComment = false;

  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (inChar) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inChar = false;
      continue;
    }
    if (ch === "/" && prefix[i + 1] === "/") { inLineComment = true; i++; continue; }
    if (ch === "'" && prefix[i + 1] === "'") { inLineComment = true; i++; continue; }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "'") { inChar = true; continue; }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === ")" || ch === "]") {
      const expected = ch === "}" ? "{" : ch === ")" ? "(" : "[";
      if (stack.length > 0 && stack[stack.length - 1] === expected) {
        stack.pop();
      }
    }
  }

  let out = prefix + `{ let __lsp_probe = ${receiverExpr}; panic("") }`;
  while (stack.length > 0) {
    const open = stack.pop()!;
    if (open === "(") out += ")";
    else if (open === "[") out += "]";
    else if (open === "{") {
      // Top-level enclosing block (e.g. fn body): diverge with panic("") so return type always unifies
      out += stack.length === 0 ? `\npanic("")\n}` : `\n}`;
    }
  }
  return out;
}

function parseSimplePrim(name: string): Type {
  const n = name.trim();
  if (n === "Int" || n === "Float" || n === "Str" || n === "Bool" || n === "Char" || n === "Byte" || n === "Bytes" || n === "Json" || n === "Prompt" || n === "Unit") {
    return { kind: "TPrim", name: n };
  }
  return { kind: "TPrim", name: "Json" };
}

/** Lightweight regex fallback to resolve simple `name: Array<Int>` / `name: Str` param annotations when a file has errors */
function inferAnnotatedTypeFromText(text: string, ident: string): Type | undefined {
  const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(
    new RegExp(`\\b${esc}\\s*:\\s*(Array<[^>]+>|Iter<[^>]+>|Dict<[^>]+>|Option<[^>]+>|Result<[^>]+>|Str|Int|Float|Bool|Prompt)(?![A-Za-z0-9_])`)
  );
  if (!m) return undefined;
  const raw = m[1];
  if (raw.startsWith("Array<")) {
    return { kind: "TArray", element: parseSimplePrim(raw.slice(6, -1)) };
  }
  if (raw.startsWith("Iter<")) {
    return { kind: "TIter", element: parseSimplePrim(raw.slice(5, -1)) };
  }
  if (raw.startsWith("Dict<")) {
    const parts = raw.slice(5, -1).split(",");
    return { kind: "TDict", key: parseSimplePrim(parts[0] ?? "Str"), value: parseSimplePrim(parts[1] ?? "Json") };
  }
  if (raw === "Str" || raw === "Int" || raw === "Float" || raw === "Bool" || raw === "Prompt") {
    return { kind: "TPrim", name: raw };
  }
  return undefined;
}

function structurallyMatches(patternType: Type, actualType: Type): boolean {
  const fv = collectFreeVars(patternType);
  const scheme = {
    quantifiedTypeVars: Array.from(fv.tVars),
    quantifiedRowVars: Array.from(fv.rVars),
    type: patternType,
  };
  const cloneP = instantiate(scheme);
  const cloneA = cloneWithSubst(actualType, new Map(), new Map());
  try {
    unify(cloneP, cloneA);
    return true;
  } catch {
    return false;
  }
}

interface CallableParam {
  name: string;
  typeStr: string;
  hasDefault: boolean;
}

interface ResolvedCallable {
  name: string;
  params: CallableParam[];
  returnTypeStr: string;
  doc?: string;
  isAsync?: boolean;
  isReified?: boolean;
}

interface CallContext {
  openParenOffset: number;
  calleeText: string;
  typeArgsText?: string;
  isArgNamePosition: boolean;
  argPrefix: string;
  currentArgName?: string;
  usedNamedArgs: Set<string>;
  positionalCount: number;
}

const CALL_REJECT_KEYWORDS = new Set([
  "if", "else", "while", "for", "match", "fn", "type", "struct",
  "enum", "trait", "impl", "let", "mut", "return", "pub", "import", "from", "as", "in",
]);

function splitTopLevelCommas(slice: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inStr = false;
  let inChar = false;
  let inLineComment = false;

  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    const next = slice[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (inChar) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inChar = false;
      continue;
    }
    if ((ch === "/" && next === "/") || (ch === "'" && next === "'")) {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "'") { inChar = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { if (depth > 0) depth--; continue; }
    if (ch === "," && depth === 0) {
      parts.push(slice.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(slice.slice(start));
  return parts;
}

function hasTopLevelColon(segment: string): boolean {
  let depth = 0;
  let inStr = false;
  let inChar = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (inChar) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inChar = false;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "'") { inChar = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { if (depth > 0) depth--; continue; }
    if (ch === ":" && depth === 0) return true;
  }
  return false;
}

function findEnclosingCallContext(text: string, cursorOffset: number): CallContext | null {
  const stack: { kind: "(" | "[" | "{"; offset: number }[] = [];
  let inStr = false;
  let inChar = false;
  let inLineComment = false;

  for (let i = 0; i < cursorOffset && i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (inChar) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inChar = false;
      continue;
    }
    if ((ch === "/" && next === "/") || (ch === "'" && next === "'")) {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "'") { inChar = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push({ kind: ch, offset: i });
    } else if (ch === ")" && stack.length > 0 && stack[stack.length - 1].kind === "(") {
      stack.pop();
    } else if (ch === "]" && stack.length > 0 && stack[stack.length - 1].kind === "[") {
      stack.pop();
    } else if (ch === "}" && stack.length > 0 && stack[stack.length - 1].kind === "{") {
      stack.pop();
    }
  }

  if (inStr || inChar || inLineComment) return null;
  if (stack.length === 0 || stack[stack.length - 1].kind !== "(") return null;

  const openParenOffset = stack[stack.length - 1].offset;

  // Locate callee immediately before `(` (skipping optional generic `<...>`)
  let p = openParenOffset - 1;
  while (p >= 0 && /\s/.test(text[p])) p--;

  let typeArgsText: string | undefined;
  if (p >= 0 && text[p] === ">") {
    const endAngle = p;
    let angleDepth = 0;
    let scan = p;
    while (scan >= 0) {
      const c = text[scan];
      if (c === ">") angleDepth++;
      else if (c === "<") {
        angleDepth--;
        if (angleDepth === 0) break;
      } else if (c === "\n" || c === ";") {
        scan = -1;
        break;
      }
      scan--;
    }
    if (scan >= 0 && angleDepth === 0) {
      typeArgsText = text.slice(scan, endAngle + 1);
      p = scan - 1;
      while (p >= 0 && /\s/.test(text[p])) p--;
    }
  }

  if (p < 0 || !/[A-Za-z0-9_]/.test(text[p])) return null;
  const calleeEnd = p + 1;
  while (p >= 0 && /[A-Za-z0-9_.]/.test(text[p])) p--;
  const calleeStart = p + 1;
  const calleeText = text.slice(calleeStart, calleeEnd).replace(/^\.+|\.+$/g, "");
  if (!calleeText) return null;

  const lastIdent = calleeText.includes(".") ? calleeText.slice(calleeText.lastIndexOf(".") + 1) : calleeText;
  if (CALL_REJECT_KEYWORDS.has(lastIdent)) return null;

  // Reject function declarations (`fn foo(x: Int)`, `reified fn foo<T>(x: T)`, `fn T.bar(self)`)
  const beforeCallee = text.slice(Math.max(0, calleeStart - 40), calleeStart);
  if (/\bfn\s+$/.test(beforeCallee)) return null;

  // Parse arguments before cursor
  const beforeSlice = text.slice(openParenOffset + 1, cursorOffset);
  const segsBefore = splitTopLevelCommas(beforeSlice);
  const usedNamedArgs = new Set<string>();
  let positionalCount = 0;

  for (let i = 0; i < segsBefore.length - 1; i++) {
    const s = segsBefore[i].trim();
    if (!s) continue;
    const nm = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (nm) usedNamedArgs.add(nm[1]);
    else positionalCount++;
  }

  const lastSeg = (segsBefore[segsBefore.length - 1] ?? "").trimStart();
  let isArgNamePosition = false;
  let argPrefix = "";
  let currentArgName: string | undefined;

  if (!hasTopLevelColon(lastSeg)) {
    if (/^[A-Za-z_]?[A-Za-z0-9_]*$/.test(lastSeg)) {
      isArgNamePosition = true;
      argPrefix = lastSeg;
    }
  } else {
    const nm = lastSeg.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (nm) currentArgName = nm[1];
  }

  // Also collect named arguments AFTER cursor up to matching `)` so we don't suggest duplicates
  let afterEnd = cursorOffset;
  let remDepth = 1;
  let aStr = false;
  let aChar = false;
  let aComment = false;
  for (let i = cursorOffset; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (aComment) { if (ch === "\n") aComment = false; continue; }
    if (aStr) { if (ch === "\\") { i++; continue; } if (ch === "\"") aStr = false; continue; }
    if (aChar) { if (ch === "\\") { i++; continue; } if (ch === "'") aChar = false; continue; }
    if ((ch === "/" && next === "/") || (ch === "'" && next === "'")) { aComment = true; i++; continue; }
    if (ch === "\"") { aStr = true; continue; }
    if (ch === "'") { aChar = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") remDepth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      remDepth--;
      if (remDepth === 0) {
        afterEnd = i;
        break;
      }
    }
  }
  if (afterEnd > cursorOffset) {
    const afterSlice = text.slice(cursorOffset, afterEnd);
    const afterSegs = splitTopLevelCommas(afterSlice);
    // Skip index 0 (continuation of current arg) unless current arg is empty
    const startIdx = lastSeg.length === 0 ? 0 : 1;
    for (let i = startIdx; i < afterSegs.length; i++) {
      const nm = afterSegs[i].trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (nm) usedNamedArgs.add(nm[1]);
    }
  }

  return {
    openParenOffset,
    calleeText,
    typeArgsText,
    isArgNamePosition,
    argPrefix,
    currentArgName,
    usedNamedArgs,
    positionalCount,
  };
}

function parseSignatureString(name: string, sig: string, doc: string): ResolvedCallable | undefined {
  const open = sig.indexOf("(");
  const close = sig.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return undefined;
  const paramsRaw = sig.slice(open + 1, close).trim();
  const retMatch = sig.slice(close + 1).match(/->\s*(.+)$/);
  const returnTypeStr = retMatch ? retMatch[1].trim() : "Unit";
  const params: CallableParam[] = [];
  if (paramsRaw) {
    for (const part of splitTopLevelCommas(paramsRaw)) {
      const m = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
      if (m) {
        const hasDefault = m[2].includes("=");
        const typeStr = hasDefault ? m[2].slice(0, m[2].indexOf("=")).trim() : m[2].trim();
        params.push({ name: m[1], typeStr, hasDefault });
      }
    }
  }
  return { name, params, returnTypeStr, doc };
}
