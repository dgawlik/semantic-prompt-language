import { parse } from "../../../src/parser.ts";
import { checkProgram, type CheckedProgram, type ModuleExports } from "../../../src/typechecker.ts";
import { generateJs } from "../../../src/codegen.ts";
import { SplError } from "../../../src/errors.ts";
import {
  SplLanguageServiceCore,
  type SplLanguageHost,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspHover,
  type LspSignatureHelp,
} from "../../../src/lsp-core.ts";

// Inline SPL stdlib sources for browser typechecking, completion, and execution
import stdAgent from "../../../stdlib/agent.splx?raw";
import stdClock from "../../../stdlib/clock.splx?raw";
import stdCodegen from "../../../stdlib/codegen.splx?raw";
import stdCollections from "../../../stdlib/collections.splx?raw";
import stdConsole from "../../../stdlib/console.splx?raw";
import stdCrypto from "../../../stdlib/crypto.splx?raw";
import stdFs from "../../../stdlib/fs.splx?raw";
import stdHttp from "../../../stdlib/http.splx?raw";
import stdLlm from "../../../stdlib/llm.splx?raw";
import stdOs from "../../../stdlib/os.splx?raw";
import stdProc from "../../../stdlib/proc.splx?raw";
import stdTraces from "../../../stdlib/traces.splx?raw";

// Inline universal runtime sources for browser ESM execution
import coreRuntimeRaw from "../../../runtime/core.mjs?raw";
import ffiUniversalRaw from "../../../runtime/ffi_universal.mjs?raw";
import llmCapabilitiesRaw from "../../../runtime/llm_capabilities.mjs?raw";
import ffiLlmRaw from "../../../runtime/ffi_llm.mjs?raw";

export type { LspCompletionItem, LspDiagnostic, LspHover, LspSignatureHelp };

export const PLAYGROUND_URI = "file:///playground/main.splx";
const PLAYGROUND_PATH = "/playground/main.splx";

const STDLIB_SOURCES: Record<string, string> = {
  agent: stdAgent,
  clock: stdClock,
  codegen: stdCodegen,
  collections: stdCollections,
  console: stdConsole,
  crypto: stdCrypto,
  fs: stdFs,
  http: stdHttp,
  llm: stdLlm,
  os: stdOs,
  proc: stdProc,
  traces: stdTraces,
};

function resolveVirtualSpec(
  spec: string,
  _fromFile: string
): { sourcePath: string; isStdlib: boolean } {
  if (spec.startsWith("std/")) {
    const modName = spec.slice(4);
    if (Object.prototype.hasOwnProperty.call(STDLIB_SOURCES, modName)) {
      return { sourcePath: `/stdlib/${modName}.splx`, isStdlib: true };
    }
    throw new SplError("module", `Unknown standard library module '${spec}'`);
  }
  throw new SplError(
    "module",
    `Local file import '${spec}' is not available in the single-file browser playground (use "std/*" imports).`
  );
}

const browserHost: SplLanguageHost = {
  uriToPath(uri: string): string {
    if (uri.startsWith("file://")) return uri.slice("file://".length);
    return uri;
  },
  pathToUri(filePath: string): string {
    if (filePath.startsWith("file://")) return filePath;
    return `file://${filePath.startsWith("/") ? "" : "/"}${filePath}`;
  },
  normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
  },
  isStdlibPath(filePath: string): boolean {
    return filePath.replace(/\\/g, "/").startsWith("/stdlib/");
  },
  resolveModuleSpec: resolveVirtualSpec,
  readFile(filePath: string): string | undefined {
    const normalized = filePath.replace(/\\/g, "/");
    const m = normalized.match(/^\/stdlib\/([^/]+)\.splx$/);
    if (m && Object.prototype.hasOwnProperty.call(STDLIB_SOURCES, m[1])) {
      return STDLIB_SOURCES[m[1]];
    }
    return undefined;
  },
};

const service = new SplLanguageServiceCore(browserHost);

export interface PlaygroundAnalysis {
  diagnostics: LspDiagnostic[];
  checked?: CheckedProgram;
  jsCode?: string;
  schemas: Array<{ line: number; schema: Record<string, unknown> }>;
}

export function analyzePlayground(source: string): PlaygroundAnalysis {
  service.setDocument(PLAYGROUND_URI, source);
  const { diagnostics, checked } = service.analyze(PLAYGROUND_URI);

  let jsCode: string | undefined;
  const schemas: Array<{ line: number; schema: Record<string, unknown> }> = [];

  if (checked) {
    for (const [expr, schema] of checked.schemaLiterals.entries()) {
      schemas.push({ line: expr.span.line, schema });
    }
    try {
      jsCode = generateJs(checked, {
        runtimeDirUrl: "spl-lang/runtime",
        resolveImportPath: (spec) => spec,
      });
    } catch {
      jsCode = undefined;
    }
  }

  return { diagnostics, checked, jsCode, schemas };
}

export function getPlaygroundCompletions(
  source: string,
  line: number,
  character: number
): LspCompletionItem[] {
  service.setDocument(PLAYGROUND_URI, source);
  try {
    return service.getCompletions(PLAYGROUND_URI, { line, character });
  } catch {
    return [];
  }
}

export function getPlaygroundHover(
  source: string,
  line: number,
  character: number
): LspHover | null {
  service.setDocument(PLAYGROUND_URI, source);
  try {
    return service.getHover(PLAYGROUND_URI, { line, character });
  } catch {
    return null;
  }
}

export function getPlaygroundSignatureHelp(
  source: string,
  line: number,
  character: number
): LspSignatureHelp | null {
  service.setDocument(PLAYGROUND_URI, source);
  try {
    return service.getSignatureHelp(PLAYGROUND_URI, { line, character });
  } catch {
    return null;
  }
}

export interface PlaygroundOutputChunk {
  kind: "stdout" | "inline" | "warn" | "error";
  text: string;
}

export interface PlaygroundRunResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

declare global {
  interface Window {
    __splPlaygroundOut?: (text: string, kind: PlaygroundOutputChunk["kind"]) => void;
    __splLlmProxy?: Record<string, string>;
  }
}

function buildCoreBlobSource(): string {
  // Redirect print() and printInline() to the playground output hook when present
  return coreRuntimeRaw
    .replace(
      `export function print(v) {\n  console.log(toStr(v));\n}`,
      `export function print(v) {\n  const s = toStr(v);\n  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "stdout");\n  else console.log(s);\n}`
    )
    .replace(
      `export function printInline(v) {\n  const s = toStr(v);\n  if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") {\n    process.stdout.write(s);\n  } else {\n    console.log(s);\n  }\n}`,
      `export function printInline(v) {\n  const s = toStr(v);\n  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "inline");\n  else console.log(s);\n}`
    );
}

function buildFfiUniversalBlobSource(coreUrl: string): string {
  return ffiUniversalRaw
    .replace(`from "./core.mjs"`, `from ${JSON.stringify(coreUrl)}`)
    .replace(
      `export function consoleLog(v) {\n  console.log(toStr(v));\n}`,
      `export function consoleLog(v) {\n  const s = toStr(v);\n  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "stdout");\n  else console.log(s);\n}`
    )
    .replace(
      `export function consoleWarn(v) {\n  console.warn(toStr(v));\n}`,
      `export function consoleWarn(v) {\n  const s = toStr(v);\n  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "warn");\n  else console.warn(s);\n}`
    )
    .replace(
      `export function consoleError(v) {\n  console.error(toStr(v));\n}`,
      `export function consoleError(v) {\n  const s = toStr(v);\n  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "error");\n  else console.error(s);\n}`
    );
}

function buildFfiServerStubSource(coreUrl: string): string {
  return `import { Err, None, toStr } from ${JSON.stringify(coreUrl)};
const msg = (api) => Err(api + " is a server-only API and is unavailable in the browser playground.");
export async function fsRead() { return msg("std/fs.read"); }
export async function fsWrite() { return msg("std/fs.write"); }
export async function fsExists() { return false; }
export async function fsListDir() { return msg("std/fs.list_dir"); }
export async function fsStat() { return msg("std/fs.stat"); }
export async function fsMkdir() { return msg("std/fs.mkdir"); }
export async function fsRemove() { return msg("std/fs.remove"); }
export async function procExec() { return msg("std/proc.exec"); }
export async function procShell() { return msg("std/proc.shell"); }
export function osEnv() { return None; }
export function osArgs() { return []; }
export function osCwd() { return "/playground"; }
export function osPlatform() { return "browser"; }
export function osExit(code) { throw new Error("os.exit(" + code + ") called in browser playground"); }
export function consoleWriteLine(v) {
  const s = toStr(v);
  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "stdout");
}
export function consoleWriteInline(v) {
  const s = toStr(v);
  if (typeof globalThis.__splPlaygroundOut === "function") globalThis.__splPlaygroundOut(s, "inline");
}
`;
}

function buildFfiCodegenStubSource(coreUrl: string): string {
  return `import { Ok, Err, decode } from ${JSON.stringify(coreUrl)};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function resolveCodeArg(strArg, promptArg) {
  const s = typeof strArg === "string" ? strArg : "";
  const p = promptArg && promptArg.$tag === "Prompt" && typeof promptArg.text === "string" ? promptArg.text : "";
  return s.trim() !== "" ? s : p;
}
function decodeResult(outInfo, raw) {
  if (!outInfo?.codec) return Ok(raw);
  const checked = decode(outInfo.codec, raw);
  if (checked.$tag === "Ok") return checked;
  return Err("Output type mismatch at " + checked._0.path + ": " + checked._0.message);
}
export function reifiedTypeMeta(typeInfos) {
  const t = Array.isArray(typeInfos) ? typeInfos[0] : null;
  return {
    name: t?.name ?? "Json",
    spl_type: t?.splType ?? "Json",
    schema_json: JSON.stringify(t?.schema ?? {}),
  };
}
export function compileJsFn(typeInfos, body = "", _timeoutMs = 5000, codePrompt = null) {
  const [_inInfo, outInfo] = typeInfos ?? [];
  const effectiveBody = resolveCodeArg(body, codePrompt);
  try {
    const rawFn = new Function("input", '"use strict";\\n' + effectiveBody);
    return Ok((input) => {
      try {
        return decodeResult(outInfo, rawFn(input));
      } catch (e) {
        return Err(e instanceof Error ? e.message : String(e));
      }
    });
  } catch (e) {
    return Err("JS syntax error: " + (e instanceof Error ? e.message : String(e)));
  }
}
export function compileJsAsyncFn(typeInfos, body = "", codePrompt = null) {
  const [_inInfo, outInfo] = typeInfos ?? [];
  const effectiveBody = resolveCodeArg(body, codePrompt);
  try {
    const rawFn = new AsyncFunction("input", '"use strict";\\n' + effectiveBody);
    return Ok(async (input) => {
      try {
        return decodeResult(outInfo, await rawFn(input));
      } catch (e) {
        return Err(e instanceof Error ? e.message : String(e));
      }
    });
  } catch (e) {
    return Err("Async JS syntax error: " + (e instanceof Error ? e.message : String(e)));
  }
}
export function evalJsExpr(typeInfos, exprSource = "", timeoutMs = 5000, codePrompt = null) {
  const [outInfo] = typeInfos ?? [];
  const effectiveExpr = resolveCodeArg(exprSource, codePrompt);
  const compiled = compileJsFn([null, outInfo], "return (" + effectiveExpr + ");", timeoutMs);
  if (compiled.$tag === "Err") return compiled;
  return compiled._0(undefined);
}
export async function compileSplFn() {
  return Err("codegen.spl_fn runtime compilation requires the Node CLI runtime.");
}
`;
}

export async function runPlaygroundCode(
  source: string,
  onOutput: (chunk: PlaygroundOutputChunk) => void
): Promise<PlaygroundRunResult> {
  const createdUrls: string[] = [];
  const makeBlobUrl = (code: string): string => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    createdUrls.push(url);
    return url;
  };

  const t0 = performance.now();

  try {
    // 1. Create runtime module Blob URLs
    const coreUrl = makeBlobUrl(buildCoreBlobSource());
    const ffiUniversalUrl = makeBlobUrl(buildFfiUniversalBlobSource(coreUrl));
    const ffiServerUrl = makeBlobUrl(buildFfiServerStubSource(coreUrl));
    const ffiCodegenUrl = makeBlobUrl(buildFfiCodegenStubSource(coreUrl));
    const llmCapsUrl = makeBlobUrl(llmCapabilitiesRaw);
    const ffiLlmUrl = makeBlobUrl(
      ffiLlmRaw
        .replace(`from "./core.mjs"`, `from ${JSON.stringify(coreUrl)}`)
        .replace(`from "./llm_capabilities.mjs"`, `from ${JSON.stringify(llmCapsUrl)}`)
    );

    const runtimeMap: Record<string, string> = {
      core: coreUrl,
      ffi_universal: ffiUniversalUrl,
      ffi_server: ffiServerUrl,
      ffi_codegen: ffiCodegenUrl,
      ffi_llm: ffiLlmUrl,
    };

    const rewriteRuntimeImports = (js: string): string =>
      js.replace(
        /from\s+"__spl_rt__\/([a-zA-Z0-9_]+)\.mjs"/g,
        (_m, modName: string) => `from ${JSON.stringify(runtimeMap[modName] ?? coreUrl)}`
      );

    // 2. Compile entry + transitive stdlib modules to Blob URLs
    const compiledMods = new Map<string, { checked: CheckedProgram; blobUrl: string }>();

    const compileMod = (srcPath: string, src: string, isStdlib: boolean): { checked: CheckedProgram; blobUrl: string } => {
      const existing = compiledMods.get(srcPath);
      if (existing) return existing;

      const prog = parse(src, srcPath, isStdlib);
      const checked = checkProgram(prog, (spec, from): ModuleExports => {
        const target = resolveVirtualSpec(spec, from);
        const modSrc = browserHost.readFile(target.sourcePath);
        if (modSrc === undefined) {
          throw new SplError("module", `Cannot load module '${spec}'`);
        }
        return compileMod(target.sourcePath, modSrc, target.isStdlib).checked.exports;
      });

      const rawJs = generateJs(checked, {
        runtimeDirUrl: "__spl_rt__",
        resolveImportPath: (spec, from) => {
          const target = resolveVirtualSpec(spec, from);
          const sub = compiledMods.get(target.sourcePath);
          if (!sub) throw new SplError("module", `Uncompiled module '${spec}'`);
          return sub.blobUrl;
        },
      });

      const js = rewriteRuntimeImports(rawJs);
      const blobUrl = makeBlobUrl(js);
      const entry = { checked, blobUrl };
      compiledMods.set(srcPath, entry);
      return entry;
    };

    const entryMod = compileMod(PLAYGROUND_PATH, source, false);

    // 3. Execute live in browser ESM with captured stdout/print_inline and server-side LLM proxy
    window.__splPlaygroundOut = (text, kind) => onOutput({ text, kind });
    const origin = window.location.origin;
    window.__splLlmProxy = {
      openai: `${origin}/api/llm/openai/v1`,
      anthropic: `${origin}/api/llm/anthropic`,
      google: `${origin}/api/llm/google`,
    };
    await import(/* @vite-ignore */ entryMod.blobUrl);

    return { ok: true, elapsedMs: Math.round(performance.now() - t0) };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === "object" && err !== null ? String(err) : String(err);
    return { ok: false, elapsedMs: Math.round(performance.now() - t0), error: message };
  } finally {
    window.__splPlaygroundOut = undefined;
    window.__splLlmProxy = undefined;
    for (const url of createdUrls) {
      URL.revokeObjectURL(url);
    }
  }
}
