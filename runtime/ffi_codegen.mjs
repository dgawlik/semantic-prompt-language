// SPL Dynamic Codegen FFI Kernel (JS sandboxed eval + SPL runtime compiler)
import * as __spl from "./core.mjs";
import { Ok, Err, decode } from "./core.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Lazily detect Node's `node:vm` so this module still loads cleanly in browsers
let nodeVm = null;
try {
  nodeVm = await import("node:vm");
} catch {
  nodeVm = null;
}

function formatErr(e) {
  return e instanceof Error ? e.message : String(e);
}

function decodeResult(outInfo, raw) {
  const checked = decode(outInfo.codec, raw);
  if (checked.$tag === "Ok") return checked;
  return Err(`Output type mismatch at ${checked._0.path}: ${checked._0.message}`);
}

/**
 * Exposes compile-time reified type metadata (`name`, `spl_type`, `schema_json`)
 * so pure-SPL helpers like `codegen.llm_fn<In, Out>` can prompt an LLM with exact schemas.
 */
export function reifiedTypeMeta(typeInfos) {
  const t = Array.isArray(typeInfos) ? typeInfos[0] : null;
  return {
    name: t?.name ?? "Json",
    spl_type: t?.splType ?? "Json",
    schema_json: JSON.stringify(t?.schema ?? {}),
  };
}

/**
 * Compile a synchronous JS function body into a strongly-typed SPL function:
 *   `fn(In) -> Result<Out, Str>`
 * On Node/Bun/Deno, executes inside an isolated `node:vm` context with `timeout_ms`
 * (blocking infinite loops and hiding `process`/`require`/`fs`).
 * In browsers, falls back to `new Function("input", body)`.
 */
function resolveCodeArg(strArg, promptArg) {
  const s = typeof strArg === "string" ? strArg : "";
  const p = promptArg && promptArg.$tag === "Prompt" && typeof promptArg.text === "string" ? promptArg.text : "";
  return s.trim() !== "" ? s : p;
}

export function compileJsFn(typeInfos, body = "", timeoutMs = 5000, codePrompt = null) {
  const [_inInfo, outInfo] = typeInfos;
  const effectiveBody = resolveCodeArg(body, codePrompt);
  try {
    if (nodeVm) {
      // Syntax-check at compile time inside a fresh Script
      const wrappedSrc = `(function(input) {\n"use strict";\n${effectiveBody}\n})`;
      const script = new nodeVm.Script(wrappedSrc, { filename: "<spl-codegen-js>" });

      const fn = (input) => {
        try {
          const sandbox = Object.create(null);
          sandbox.Math = Math;
          sandbox.JSON = JSON;
          sandbox.Array = Array;
          sandbox.Object = Object;
          sandbox.Number = Number;
          sandbox.String = String;
          sandbox.Boolean = Boolean;
          sandbox.RegExp = RegExp;
          sandbox.Map = Map;
          sandbox.Set = Set;
          sandbox.Date = Date;
          sandbox.Error = Error;
          const ctx = nodeVm.createContext(sandbox);
          const compiled = script.runInContext(ctx, { timeout: timeoutMs });
          const runner = new nodeVm.Script("__fn(__input)", { filename: "<spl-codegen-js-call>" });
          sandbox.__fn = compiled;
          sandbox.__input = input;
          const raw = runner.runInContext(ctx, { timeout: timeoutMs });
          return decodeResult(outInfo, raw);
        } catch (e) {
          return Err(formatErr(e));
        }
      };
      return Ok(fn);
    }

    // Browser fallback
    const rawFn = new Function("input", `"use strict";\n${effectiveBody}`);
    const fn = (input) => {
      try {
        return decodeResult(outInfo, rawFn(input));
      } catch (e) {
        return Err(formatErr(e));
      }
    };
    return Ok(fn);
  } catch (e) {
    return Err(`JS syntax error: ${formatErr(e)}`);
  }
}

/**
 * Compile an async JS function body (`await` allowed inside `body`) into an async SPL function:
 *   `async fn(In) -> Result<Out, Str>`
 */
export function compileJsAsyncFn(typeInfos, body = "", codePrompt = null) {
  const [_inInfo, outInfo] = typeInfos;
  const effectiveBody = resolveCodeArg(body, codePrompt);
  try {
    const rawFn = new AsyncFunction("input", `"use strict";\n${effectiveBody}`);
    const fn = async (input) => {
      try {
        const raw = await rawFn(input);
        return decodeResult(outInfo, raw);
      } catch (e) {
        return Err(formatErr(e));
      }
    };
    return Ok(fn);
  } catch (e) {
    return Err(`Async JS syntax error: ${formatErr(e)}`);
  }
}

/**
 * One-shot typed JS expression evaluation returning `Result<Out, Str>`.
 */
export function evalJsExpr(typeInfos, exprSource = "", timeoutMs = 5000, codePrompt = null) {
  const [outInfo] = typeInfos;
  const effectiveExpr = resolveCodeArg(exprSource, codePrompt);
  const compiled = compileJsFn([null, outInfo], `return (${effectiveExpr});`, timeoutMs);
  if (compiled.$tag === "Err") return compiled;
  return compiled._0(undefined);
}

/**
 * Dynamically parse, type-check (against `fn(In) -> Out`), and compile SPL (`.splx`)
 * source code at runtime into a strongly-typed SPL function `fn(In) -> Result<Out, Str>`.
 */
let compilerModPromise = null;
async function loadSplCompiler() {
  if (!compilerModPromise) {
    compilerModPromise = import("../dist/index.js");
  }
  return compilerModPromise;
}

export async function compileSplFn(typeInfos, source = "", entry = "run", codePrompt = null) {
  const [inInfo, outInfo] = typeInfos;
  const effectiveSource = resolveCodeArg(source, codePrompt);
  try {
    const { parse, checkProgram, generateJs } = await loadSplCompiler();

    // Append a compile-time signature verification check so generated SPL code
    // MUST match `fn(In) -> Out` before any code is ever executed!
    const probeSource = `${effectiveSource}\nlet __spl_codegen_sig_check: fn(${inInfo.splType}) -> ${outInfo.splType} = ${entry}\n`;
    const program = parse(probeSource, "<codegen>.splx", false);
    const checked = checkProgram(program);

    const jsModule = generateJs(checked, {
      runtimeDirUrl: "__unused__",
      resolveImportPath: () => {
        throw new Error("Dynamic `spl_fn` snippets cannot import external modules");
      },
    });

    // Transform the generated ESM into a self-contained sandboxed factory with `__spl` injected
    const body = jsModule
      .replace(/^import \* as __spl from .*?;\r?\n/, "")
      .replace(/^export\s+/gm, "");

    const entryIsAsync = Array.from(checked.asyncFns).some(
      (n) => n && n.kind === "FnDecl" && n.name === entry
    );

    const factory = new Function("__spl", `"use strict";\n${body}\nreturn ${entry};`);
    const entryFn = factory(__spl);

    if (typeof entryFn !== "function") {
      return Err(`Entry point '${entry}' is not a callable function`);
    }

    if (entryIsAsync) {
      return Ok(async (input) => {
        try {
          const raw = await entryFn(input);
          return decodeResult(outInfo, raw);
        } catch (e) {
          return Err(formatErr(e));
        }
      });
    }

    return Ok((input) => {
      try {
        const raw = entryFn(input);
        return decodeResult(outInfo, raw);
      } catch (e) {
        return Err(formatErr(e));
      }
    });
  } catch (e) {
    return Err(formatErr(e));
  }
}
