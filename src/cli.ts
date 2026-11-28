#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HostRuntime,
  JsToolHandler,
  McpToolHandler,
  SplCompileError,
  SplType,
  canonicalJsonParse,
  canonicalJsonStringify,
  canonicalTraceJson,
  canonicalTypeString,
  compileSource,
  createEmptyCatalog,
  createOfficialOpenAiClient,
  parseBytecode,
  runVm,
  sha256Hex,
  translateProseToSpl,
  validateSignatureCatalog,
} from "./index.js";
import { EffectRecord, NormativeTrace, VmLimits } from "./vm.js";

const CLI_VERSION = "5.0.0";

// --- Zero-dependency ANSI Styling (respects NO_COLOR and TTY) ---

const useColorStdout = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const useColorStderr = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

function style(enabled: boolean, code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const c = {
  bold: (s: string, err = false) => style(err ? useColorStderr : useColorStdout, "1", s),
  dim: (s: string, err = false) => style(err ? useColorStderr : useColorStdout, "2", s),
  red: (s: string, err = false) => style(err ? useColorStderr : useColorStdout, "31", s),
  green: (s: string, err = false) => style(err ? useColorStderr : useColorStdout, "32", s),
  yellow: (s: string, err = false) => style(err ? useColorStderr : useColorStdout, "33", s),
  cyan: (s: string, err = false) => style(err ? useColorStderr : useColorStdout, "36", s),
};

// --- Argument Parser with Short Flags, --k=v, Aliases & Typo Suggestions ---

interface FlagSpec {
  name: string;
  short?: string;
  aliases?: string[];
  takesValue: boolean;
  multi?: boolean;
}

interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | undefined>;
  multi: Record<string, string[]>;
  bools: Record<string, boolean>;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function parseFlags(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  const allFlagNames: string[] = [];

  for (const s of specs) {
    byLong.set(s.name, s);
    allFlagNames.push(`--${s.name}`);
    for (const al of s.aliases ?? []) {
      byLong.set(al, s);
      allFlagNames.push(`--${al}`);
    }
    if (s.short) {
      byShort.set(s.short, s);
    }
  }

  const out: ParsedArgs = { positionals: [], values: {}, multi: {}, bools: {} };
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (afterDoubleDash || tok === "-" || !tok.startsWith("-")) {
      out.positionals.push(tok);
      continue;
    }
    if (tok === "--") {
      afterDoubleDash = true;
      continue;
    }

    let spec: FlagSpec | undefined;
    let inlineVal: string | undefined;

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      if (eq !== -1) inlineVal = body.slice(eq + 1);
      spec = byLong.get(key);
    } else if (tok.length === 2) {
      spec = byShort.get(tok.slice(1));
    }

    if (!spec) {
      const closest = allFlagNames
        .map((n) => ({ n, d: levenshtein(tok.split("=")[0], n) }))
        .sort((a, b) => a.d - b.d)[0];
      const hint = closest && closest.d <= 3 ? ` Did you mean ${c.cyan(closest.n, true)}?` : "";
      throw new Error(`Unknown flag '${tok}'.${hint} Run with --help to see supported options.`);
    }

    if (!spec.takesValue) {
      if (inlineVal !== undefined) {
        throw new Error(`Flag '--${spec.name}' does not take a value`);
      }
      out.bools[spec.name] = true;
      continue;
    }

    let val = inlineVal;
    if (val === undefined) {
      if (i + 1 >= argv.length) {
        throw new Error(`Flag '${tok}' requires a value`);
      }
      val = argv[++i];
    }

    if (spec.multi) {
      if (!out.multi[spec.name]) out.multi[spec.name] = [];
      out.multi[spec.name].push(val);
    } else {
      out.values[spec.name] = val;
    }
  }

  return out;
}

// --- Help Text ---

function printMainHelp(): void {
  console.log(
    [
      `${c.bold("SPL v5")} ${c.dim(`(v${CLI_VERSION})`)} — Compile natural language into deterministic SPLB 5 bytecode`,
      "",
      c.bold("USAGE"),
      "  spl <command> [options]",
      "",
      c.bold("COMMANDS"),
      `  ${c.cyan("translate")}  Compile natural-language prose (.txt or -) into SPLB 5 bytecode`,
      `  ${c.cyan("run")}        Execute .splb bytecode (or auto-compile .spl / .txt prose)`,
      `  ${c.cyan("replay")}     Strictly verify a trace offline (--strict) or recover from a WAL`,
      `  ${c.cyan("inspect")}    Audit bytecode hash, capabilities, inputs, state, and disassembly`,
      `  ${c.cyan("compile")}    Compile existing .spl source directly to .splb bytecode`,
      `  ${c.cyan("init")}       Scaffold a starter catalog.json and workflow.txt`,
      "",
      c.bold("QUICK EXAMPLES"),
      `  ${c.dim("# 1. Compile prose -> bytecode")}`,
      "  spl translate examples/02_invoice_extraction.txt -c examples/catalog.json -m gpt-4.1 -o invoice.splb",
      "",
      `  ${c.dim("# 2. Inspect required capabilities & inputs")}`,
      "  spl inspect invoice.splb",
      "",
      `  ${c.dim("# 3. Run bytecode with inputs file or --arg key=value")}`,
      "  spl run invoice.splb -c examples/catalog.json -i examples/02_invoice_inputs.json --trace-out trace.json",
      `  spl run invoice.splb -c examples/catalog.json --arg raw_document="Invoice #1: $50 USD"`,
      "",
      `  ${c.dim("# 4. Verify deterministic replay offline (0 API calls)")}`,
      "  spl replay invoice.splb --trace trace.json --strict",
      "",
      `Run ${c.cyan("spl <command> --help")} for detailed options on any command.`,
    ].join("\n")
  );
}

function printCommandHelp(cmd: string): void {
  const helps: Record<string, string[]> = {
    translate: [
      `${c.bold("spl translate")} <prose.txt|-> [options]`,
      "",
      "Compile natural-language instructions into canonical SPLB 5 bytecode via OpenAI Lark CFG.",
      "",
      c.bold("OPTIONS"),
      "  -c, --catalog <file>       Signature Catalog JSON (auto-uses ./catalog.json if present)",
      "  -m, --model <id>           OpenAI model ID (default: $SPL_MODEL or gpt-4.1)",
      "  -o, --out <file.splb>      Write compiled bytecode to file (prints to stdout if omitted)",
      "      --emit-source <file>   Also save the generated SPL v5 source code (.spl)",
      "      --max-attempts <n>     Max compile-repair attempts (default: 3)",
      "      --temperature <n>      Explicit temperature (omitted by default for reasoning models)",
      "  -q, --quiet                Suppress progress logs on stderr",
      "      --json                 Print machine-readable compilation summary JSON",
      "",
      c.bold("EXAMPLE"),
      "  spl translate examples/01_ticket_triage.txt -c examples/catalog.json -m gpt-6-luna --emit-source ticket.spl -o ticket.splb",
    ],
    run: [
      `${c.bold("spl run")} <file.splb|file.spl|prose.txt|-> [options]`,
      "",
      "Execute compiled SPLB 5 bytecode (or auto-compile .spl / .txt prose) on the deterministic VM.",
      "",
      c.bold("OPTIONS"),
      "  -c, --catalog <file>       Signature Catalog JSON (auto-uses ./catalog.json if present)",
      "  -i, --inputs <file.json>   Input values JSON file (alias: --input)",
      "      --input-json <json>    Inline JSON object for inputs",
      "      --arg <key=value>      Pass individual typed input (repeatable; auto-coerced to declared type)",
      "  -s, --state <file.json>    Initial durable state JSON file",
      "      --commit-state         Atomically overwrite --state file on clean exit (rolled back on trap)",
      "      --save-state <file>    Atomically write final state to a specific file on clean exit",
      "      --mount <root=dir>     Mount virtual FS / shell root (repeatable)",
      "      --js-tools <mod.mjs>   ESM module exporting host JS tool handlers",
      "      --mcp-module <mod.mjs> ESM module exporting default MCP handler(server, tool, args)",
      "      --limits <file.json>   Override VM logical limits JSON",
      "      --wal <wal.jsonl>      Append-only effect write-ahead log (also resumes if non-empty)",
      "      --trace-out <file>     Save full canonical trace JSON to file",
      "  -m, --model <id>           Translator model if running a .txt prose file directly",
      "      --max-attempts <n>     Max compile-repair attempts for .txt files (default: 3)",
      "      --temperature <n>      Optional translator temperature for .txt files",
      "      --json                 Print full canonical trace JSON to stdout (default when piped)",
      "      --result-only          Print only the result JSON object to stdout",
      "  -q, --quiet                Suppress progress logs on stderr",
      "",
      c.bold("EXAMPLES"),
      "  spl run ticket.splb -c examples/catalog.json -i examples/01_ticket_inputs.json -s state.json --commit-state",
      '  spl run invoice.splb -c examples/catalog.json --arg raw_document="Acme Corp $50 USD"',
    ],
    replay: [
      `${c.bold("spl replay")} <file.splb> [options]`,
      "",
      "Strictly replay a recorded trace offline (0 API calls) or recover a crashed run from a WAL.",
      "",
      c.bold("OPTIONS"),
      "  -t, --trace <file.json>    Recorded trace JSON file",
      "      --strict               Strict offline replay (traps with REPLAY_DIVERGENCE on any mismatch)",
      "      --wal <wal.jsonl>      Partial effect WAL for crash recovery",
      "  -c, --catalog <file>       Signature Catalog JSON (needed for live recovery)",
      "  -i, --inputs <file.json>   Override inputs (for WAL recovery without trace)",
      "  -s, --state <file.json>    Initial state (for WAL recovery without trace)",
      "      --mount <root=dir>     Virtual FS mounts for live recovery (repeatable)",
      "      --js-tools <mod.mjs>   Host JS tools for live recovery",
      "      --mcp-module <mod.mjs> MCP handler for live recovery",
      "      --trace-out <file>     Write replayed trace JSON to file",
      "      --json                 Output raw canonical trace JSON",
      "",
      c.bold("EXAMPLE"),
      "  spl replay ticket.splb --trace trace.json --strict",
    ],
    inspect: [
      `${c.bold("spl inspect")} <file.splb> [options]`,
      "",
      "Audit bytecode SHA-256, catalog digest, capabilities, inputs, durable state, and functions.",
      "",
      c.bold("OPTIONS"),
      "      --disasm               Also print the full SPLB 5 bytecode disassembly",
      "      --json                 Output inspection report as JSON",
    ],
    compile: [
      `${c.bold("spl compile")} <source.spl|-> [options]`,
      "",
      "Compile an SPL v5 source file into canonical UTF-8 SPLB 5 bytecode.",
      "",
      c.bold("OPTIONS"),
      "  -c, --catalog <file>       Signature Catalog JSON (auto-uses ./catalog.json if present)",
      "  -o, --out <file.splb>      Write bytecode to file (prints to stdout if omitted)",
      "  -q, --quiet                Suppress status message on stderr",
    ],
    init: [
      `${c.bold("spl init")} [directory] [options]`,
      "",
      "Scaffold a starter catalog.json and workflow.txt ready to translate and run.",
      "",
      c.bold("OPTIONS"),
      "      --force                Overwrite existing files if present",
    ],
  };

  const lines = helps[cmd];
  if (lines) console.log(lines.join("\n"));
  else printMainHelp();
}

// --- Helpers ---

function resolveCatalog(flagPath: string | undefined, quiet: boolean): { catalog: ReturnType<typeof createEmptyCatalog>; pathUsed?: string } {
  if (flagPath) {
    if (!fs.existsSync(flagPath)) {
      throw new Error(`Catalog file not found: '${flagPath}'`);
    }
    return {
      catalog: validateSignatureCatalog(JSON.parse(fs.readFileSync(flagPath, "utf8"))),
      pathUsed: flagPath,
    };
  }
  const autoPath = path.resolve("catalog.json");
  if (fs.existsSync(autoPath)) {
    if (!quiet) console.error(c.dim(`Using catalog: ./catalog.json`, true));
    return {
      catalog: validateSignatureCatalog(JSON.parse(fs.readFileSync(autoPath, "utf8"))),
      pathUsed: autoPath,
    };
  }
  return { catalog: createEmptyCatalog() };
}

function parseMounts(specs: string[]): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid --mount '${spec}'; expected <root>=<host_directory>`);
    }
    mounts[spec.slice(0, eq)] = path.resolve(spec.slice(eq + 1));
  }
  return mounts;
}

function coerceCliArg(rawVal: string, declaredType?: SplType): unknown {
  if (!declaredType) {
    try {
      return canonicalJsonParse(rawVal);
    } catch {
      return rawVal;
    }
  }
  const t = declaredType.kind === "nullable" ? declaredType.inner : declaredType;
  if (declaredType.kind === "nullable" && rawVal === "null") return null;
  if (t.kind === "string" || t.kind === "str_union") return rawVal;
  if (t.kind === "bool") {
    if (rawVal === "true") return true;
    if (rawVal === "false") return false;
    throw new Error(`Expected 'true' or 'false', got '${rawVal}'`);
  }
  if (t.kind === "int") {
    if (!/^-?\d+$/.test(rawVal)) throw new Error(`Expected integer, got '${rawVal}'`);
    return BigInt(rawVal);
  }
  if (t.kind === "float") {
    const n = Number(rawVal);
    if (!Number.isFinite(n)) throw new Error(`Expected finite float, got '${rawVal}'`);
    return n;
  }
  // list, map, record, json
  return canonicalJsonParse(rawVal);
}

async function loadJsTools(modPath?: string): Promise<Record<string, JsToolHandler> | undefined> {
  if (!modPath) return undefined;
  const mod = (await import(pathToFileURL(path.resolve(modPath)).href)) as Record<string, unknown>;
  return (mod.default && typeof mod.default === "object" ? mod.default : mod) as Record<string, JsToolHandler>;
}

async function loadMcpHandler(modPath?: string): Promise<McpToolHandler | undefined> {
  if (!modPath) return undefined;
  const mod = (await import(pathToFileURL(path.resolve(modPath)).href)) as Record<string, unknown>;
  const fn = mod.default ?? mod.mcpHandler;
  if (typeof fn !== "function") {
    throw new Error(`--mcp-module '${modPath}' must export a default or mcpHandler function`);
  }
  return fn as McpToolHandler;
}

function readTextOrStdin(filePath: string): string {
  if (filePath === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: '${filePath}'`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function readWalJsonl(walPath: string): EffectRecord[] {
  if (!fs.existsSync(walPath)) return [];
  const raw = fs.readFileSync(walPath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => canonicalJsonParse(line) as unknown as EffectRecord);
}

function formatPrettyJson(val: unknown): string {
  return JSON.stringify(
    val,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    2
  );
}

function printPrettyTrace(trace: NormativeTrace, savedStatePath?: string, traceOutPath?: string): void {
  const r = trace.result;
  if (r.status === "ok") {
    console.log(`${c.green(c.bold("✓ OK"))} ${c.dim(`(steps=${r.metrics.steps}, effects=${r.metrics.effects_count}, peak_mem=${r.metrics.peak_memory_bytes}B)`)}`);
    console.log("");
    console.log(c.bold("Result:"));
    console.log(typeof r.value === "string" ? r.value : formatPrettyJson(r.value));
    if (Object.keys(r.final_state).length > 0) {
      console.log("");
      console.log(c.bold("Durable State:") + (savedStatePath ? c.dim(` (committed -> ${savedStatePath})`) : ""));
      console.log(formatPrettyJson(r.final_state));
    }
  } else {
    console.log(`${c.red(c.bold(`✗ TRAP [${r.trap_code}]`))} ${c.dim(`at ${r.trap_fn}:${String(r.trap_pc).padStart(4, "0")}`)}`);
    console.log(`  ${r.trap_message}`);
    console.log(c.dim(`  (durable state rolled back; steps=${r.metrics.steps}, effects=${r.metrics.effects_count})`));
  }

  if (trace.effects.length > 0) {
    console.log("");
    console.log(c.bold(`Effects (${trace.effects.length}):`));
    for (const e of trace.effects) {
      const badge = e.outcome.status === "ok" ? c.green("ok") : c.red(`err:${e.outcome.error.code}`);
      const extra =
        e.outcome.status === "ok" && e.outcome.confidence !== undefined
          ? c.dim(` (choice=${String(e.outcome.value)}, confidence=${(e.outcome.confidence * 100).toFixed(1)}%)`)
          : "";
      console.log(`  #${e.seq} ${c.cyan(`${e.kind}`)} ${c.dim(e.target)} -> ${badge}${extra}`);
    }
  }
  if (traceOutPath) {
    console.log("");
    console.log(c.dim(`Trace written to ${traceOutPath}`));
  }
}

function formatCompileError(err: SplCompileError, source?: string): string {
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : [];
  const parts: string[] = [];
  for (const d of err.diagnostics) {
    const loc = d.span ? `${d.span.line}:${d.span.col}` : "?";
    parts.push(`${c.red(c.bold(d.code, true), true)} ${c.dim(`at ${loc}`, true)}: ${d.message}`);
    if (d.span && lines[d.span.line - 1] !== undefined) {
      const srcLine = lines[d.span.line - 1];
      parts.push(`  ${c.dim(`${d.span.line} |`, true)} ${srcLine}`);
      parts.push(`  ${" ".repeat(String(d.span.line).length + 2)}${" ".repeat(Math.max(0, d.span.col - 1))}${c.red("^", true)}`);
    }
  }
  return parts.join("\n");
}

// --- Subcommands ---

async function cmdInit(rawArgs: string[]): Promise<void> {
  const parsed = parseFlags(rawArgs, [
    { name: "force", takesValue: false },
    { name: "help", short: "h", takesValue: false },
  ]);
  if (parsed.bools.help) {
    printCommandHelp("init");
    return;
  }
  const targetDir = path.resolve(parsed.positionals[0] ?? ".");
  fs.mkdirSync(targetDir, { recursive: true });

  const catPath = path.join(targetDir, "catalog.json");
  const wfPath = path.join(targetDir, "workflow.txt");

  if (!parsed.bools.force && (fs.existsSync(catPath) || fs.existsSync(wfPath))) {
    throw new Error(`catalog.json or workflow.txt already exists in '${targetDir}'. Use --force to overwrite.`);
  }

  const starterCatalog = {
    spec_version: "5",
    models: {
      default: {
        provider: "openai",
        model: "gpt-4.1",
        max_output_tokens: 1024,
        strict_schema: true,
      },
    },
    decisions: {
      classifier_default: {
        adapter: "openai_logprobs",
        model: "gpt-4.1-mini",
        top_logprobs: 20,
      },
    },
    shell_profiles: {},
    fs_roots: {
      output: { permissions: ["read", "write", "list", "stat"], max_file_bytes: 1048576 },
    },
    web: {
      search: { enabled: false, max_results_cap: 0 },
      fetch: {
        enabled: false,
        allowed_methods: ["GET"],
        allowed_domains: [],
        denied_domains: [],
        block_private_ips: true,
        max_redirects: 3,
        max_response_bytes: 65536,
      },
    },
    js_tools: {},
    mcp_tools: {},
  };

  const starterProse = [
    "Take a string input called text.",
    'Use classifier_default to decide whether text is "positive", "negative", or "neutral" with min_confidence 0.7.',
    'If uncertain, return { sentiment: "uncertain", summary: "Needs human review" }.',
    "Otherwise ask the default model for a 1-sentence summary and return { sentiment, summary }.",
  ].join("\n") + "\n";

  fs.writeFileSync(catPath, JSON.stringify(starterCatalog, null, 2) + "\n", "utf8");
  fs.writeFileSync(wfPath, starterProse, "utf8");

  console.log(`${c.green("✓")} Created ${c.cyan(path.relative(process.cwd(), catPath) || "catalog.json")}`);
  console.log(`${c.green("✓")} Created ${c.cyan(path.relative(process.cwd(), wfPath) || "workflow.txt")}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. spl translate workflow.txt -o workflow.splb`);
  console.log(`  2. spl run workflow.splb --arg text="Loved the fast delivery!"`);
}

async function cmdInspect(rawArgs: string[]): Promise<void> {
  const parsed = parseFlags(rawArgs, [
    { name: "disasm", takesValue: false },
    { name: "json", takesValue: false },
    { name: "help", short: "h", takesValue: false },
  ]);
  if (parsed.bools.help || parsed.positionals.length === 0) {
    printCommandHelp("inspect");
    if (!parsed.bools.help) process.exitCode = 1;
    return;
  }

  const bcPath = parsed.positionals[0];
  const raw = readTextOrStdin(bcPath);
  const prog = parseBytecode(raw);
  const bcSha = sha256Hex(raw);

  if (parsed.bools.json || !process.stdout.isTTY) {
    const info = {
      spec_version: prog.specVersion,
      bytecode_sha256: bcSha,
      catalog_sha256: prog.catalogSha256,
      capabilities: prog.capabilities,
      inputs: prog.inputs.map((i) => ({ name: i.name, type: canonicalTypeString(i.type), default: i.defaultRef })),
      state: prog.states.map((s) => ({ name: s.name, type: canonicalTypeString(s.type), init: s.initRef })),
      consts_count: prog.consts.length,
      schemas_count: prog.schemas.length,
      functions: prog.functions.map((f) => ({
        name: f.name,
        params: f.paramTypes.map(canonicalTypeString),
        return_type: canonicalTypeString(f.retType),
        locals: f.locals,
        instructions: f.code.length,
      })),
    };
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    return;
  }

  console.log(`${c.bold("SPLB 5 Bytecode")} ${c.dim(`(${bcPath})`)}`);
  console.log(`  Bytecode SHA-256 : ${c.cyan(bcSha)}`);
  console.log(`  Catalog SHA-256  : ${c.dim(prog.catalogSha256)}`);
  console.log(
    `  Capabilities     : ${
      prog.capabilities.length > 0 ? prog.capabilities.map((x) => c.yellow(x)).join(", ") : c.dim("(pure — none)")
    }`
  );

  console.log("");
  console.log(c.bold(`Inputs (${prog.inputs.length}):`));
  if (prog.inputs.length === 0) console.log(c.dim("  (none)"));
  for (const inp of prog.inputs) {
    const def = inp.defaultRef === "NONE" ? c.red("required") : c.dim(`default=${inp.defaultRef}`);
    console.log(`  ${c.cyan(inp.name)}: ${canonicalTypeString(inp.type)}  [${def}]`);
  }

  console.log("");
  console.log(c.bold(`Durable State (${prog.states.length}):`));
  if (prog.states.length === 0) console.log(c.dim("  (none)"));
  for (const st of prog.states) {
    console.log(`  ${c.cyan(st.name)}: ${canonicalTypeString(st.type)}  ${c.dim(`init=${st.initRef}`)}`);
  }

  console.log("");
  console.log(c.bold(`Functions (${prog.functions.length}):`));
  for (const fn of prog.functions) {
    const sig = `${fn.name}(${fn.paramTypes.map(canonicalTypeString).join(", ")}) -> ${canonicalTypeString(fn.retType)}`;
    console.log(`  ${c.cyan(sig)}  ${c.dim(`locals=${fn.locals}, instructions=${fn.code.length}`)}`);
  }

  if (parsed.bools.disasm) {
    console.log("");
    console.log(c.bold("Disassembly:"));
    console.log(raw.trimEnd());
  }
}

async function cmdCompile(rawArgs: string[]): Promise<void> {
  const parsed = parseFlags(rawArgs, [
    { name: "catalog", short: "c", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "quiet", short: "q", takesValue: false },
    { name: "help", short: "h", takesValue: false },
  ]);
  if (parsed.bools.help || parsed.positionals.length === 0) {
    printCommandHelp("compile");
    if (!parsed.bools.help) process.exitCode = 1;
    return;
  }

  const srcPath = parsed.positionals[0];
  const quiet = Boolean(parsed.bools.quiet);
  const { catalog } = resolveCatalog(parsed.values.catalog, quiet);
  const src = readTextOrStdin(srcPath);

  try {
    const res = compileSource(src, catalog);
    if (parsed.values.out) {
      fs.writeFileSync(parsed.values.out, res.text, "utf8");
      if (!quiet) {
        console.error(
          `${c.green("✓", true)} Compiled ${srcPath} -> ${c.cyan(parsed.values.out, true)} ${c.dim(`(sha256: ${res.sha256.slice(0, 12)}...)`, true)}`
        );
      }
    } else {
      process.stdout.write(res.text);
    }
  } catch (err) {
    if (err instanceof SplCompileError) {
      console.error(formatCompileError(err, src));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function cmdTranslate(rawArgs: string[]): Promise<void> {
  const parsed = parseFlags(rawArgs, [
    { name: "catalog", short: "c", takesValue: true },
    { name: "model", short: "m", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "emit-source", aliases: ["emit-spl"], takesValue: true },
    { name: "max-attempts", takesValue: true },
    { name: "temperature", takesValue: true },
    { name: "quiet", short: "q", takesValue: false },
    { name: "json", takesValue: false },
    { name: "help", short: "h", takesValue: false },
  ]);
  if (parsed.bools.help || parsed.positionals.length === 0) {
    printCommandHelp("translate");
    if (!parsed.bools.help) process.exitCode = 1;
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      `OPENAI_API_KEY is not set.\n  PowerShell: $env:OPENAI_API_KEY="sk-..."\n  bash/zsh:   export OPENAI_API_KEY="sk-..."`
    );
  }

  const prosePath = parsed.positionals[0];
  const quiet = Boolean(parsed.bools.quiet);
  const { catalog } = resolveCatalog(parsed.values.catalog, quiet);
  const model = parsed.values.model ?? process.env.SPL_MODEL ?? "gpt-4.1";
  const maxAttempts = Number(parsed.values["max-attempts"] ?? "3");
  const temperature = parsed.values.temperature !== undefined ? Number(parsed.values.temperature) : undefined;
  const prose = readTextOrStdin(prosePath);

  const client = createOfficialOpenAiClient();
  const res = await translateProseToSpl({
    prose,
    catalog,
    client,
    model,
    temperature,
    maxAttempts,
    onProgress: quiet
      ? undefined
      : (ev) => {
          if (ev.type === "attempt_start") {
            console.error(c.dim(`→ Translating ${prosePath} with ${ev.model} (attempt ${ev.attempt}/${ev.maxAttempts})...`, true));
          } else if (ev.type === "repair") {
            const codes = ev.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ");
            console.error(c.yellow(`  ↻ Attempt ${ev.attempt} failed static checks (${codes}) — repairing...`, true));
          }
        },
  });

  if (parsed.values["emit-source"]) {
    fs.writeFileSync(parsed.values["emit-source"], res.source, "utf8");
    if (!quiet) console.error(`${c.green("✓", true)} Saved SPL source -> ${c.cyan(parsed.values["emit-source"], true)}`);
  }

  if (parsed.values.out) {
    fs.writeFileSync(parsed.values.out, res.compiled.text, "utf8");
    if (parsed.bools.json) {
      process.stdout.write(
        JSON.stringify(
          {
            out: parsed.values.out,
            attempts: res.attempts,
            bytecode_sha256: res.compiled.sha256,
            capabilities: res.compiled.program.capabilities,
          },
          null,
          2
        ) + "\n"
      );
    } else if (!quiet) {
      console.error(
        `${c.green("✓", true)} Compiled ${prosePath} -> ${c.cyan(parsed.values.out, true)} in ${res.attempts} attempt(s)`
      );
      console.error(
        c.dim(
          `  sha256: ${res.compiled.sha256.slice(0, 16)}...  caps: ${
            res.compiled.program.capabilities.join(", ") || "(none)"
          }`,
          true
        )
      );
      const reqInputs = res.compiled.program.inputs.filter((i) => i.defaultRef === "NONE");
      if (reqInputs.length > 0) {
        const argHint = reqInputs.map((i) => `--arg ${i.name}=<${canonicalTypeString(i.type)}>`).join(" ");
        console.error(c.dim(`  Run: spl run ${parsed.values.out} ${argHint}`, true));
      }
    }
  } else {
    process.stdout.write(res.compiled.text);
  }
}

async function cmdRun(rawArgs: string[]): Promise<void> {
  const parsed = parseFlags(rawArgs, [
    { name: "catalog", short: "c", takesValue: true },
    { name: "inputs", short: "i", aliases: ["input"], takesValue: true },
    { name: "input-json", takesValue: true },
    { name: "arg", takesValue: true, multi: true },
    { name: "state", short: "s", takesValue: true },
    { name: "commit-state", takesValue: false },
    { name: "save-state", takesValue: true },
    { name: "mount", takesValue: true, multi: true },
    { name: "js-tools", takesValue: true },
    { name: "mcp-module", takesValue: true },
    { name: "limits", takesValue: true },
    { name: "wal", takesValue: true },
    { name: "trace-out", aliases: ["save-trace"], takesValue: true },
    { name: "model", short: "m", takesValue: true },
    { name: "max-attempts", takesValue: true },
    { name: "temperature", takesValue: true },
    { name: "json", takesValue: false },
    { name: "result-only", takesValue: false },
    { name: "quiet", short: "q", takesValue: false },
    { name: "help", short: "h", takesValue: false },
  ]);

  if (parsed.bools.help || parsed.positionals.length === 0) {
    printCommandHelp("run");
    if (!parsed.bools.help) process.exitCode = 1;
    return;
  }

  const filePath = parsed.positionals[0];
  const quiet = Boolean(parsed.bools.quiet);
  const { catalog, pathUsed: catPath } = resolveCatalog(parsed.values.catalog, quiet);
  const raw = readTextOrStdin(filePath);

  let bytecode: string;
  if (filePath.endsWith(".splb")) {
    bytecode = raw;
  } else if (filePath.endsWith(".spl")) {
    try {
      bytecode = compileSource(raw, catalog).text;
    } catch (err) {
      if (err instanceof SplCompileError) {
        console.error(formatCompileError(err, raw));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  } else {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required to auto-translate natural-language prose");
    }
    const model = parsed.values.model ?? process.env.SPL_MODEL ?? "gpt-4.1";
    const maxAttempts = Number(parsed.values["max-attempts"] ?? "3");
    const temperature = parsed.values.temperature !== undefined ? Number(parsed.values.temperature) : undefined;
    const translated = await translateProseToSpl({
      prose: raw,
      catalog,
      client: createOfficialOpenAiClient(),
      model,
      temperature,
      maxAttempts,
      onProgress: quiet
        ? undefined
        : (ev) => {
            if (ev.type === "attempt_start") {
              console.error(c.dim(`→ Translating ${filePath} with ${ev.model} (attempt ${ev.attempt}/${ev.maxAttempts})...`, true));
            } else if (ev.type === "repair") {
              console.error(c.yellow(`  ↻ Attempt ${ev.attempt} failed static checks — repairing...`, true));
            }
          },
    });
    bytecode = translated.compiled.text;
  }

  const prog = parseBytecode(bytecode);
  const inputTypeMap = new Map(prog.inputs.map((inp) => [inp.name, inp.type]));

  // Build inputs from --inputs / --input-json / repeatable --arg key=val
  const inputs: Record<string, unknown> = {};
  if (parsed.values.inputs) {
    Object.assign(inputs, canonicalJsonParse(fs.readFileSync(parsed.values.inputs, "utf8")) as Record<string, unknown>);
  }
  if (parsed.values["input-json"]) {
    Object.assign(inputs, canonicalJsonParse(parsed.values["input-json"]) as Record<string, unknown>);
  }
  for (const argSpec of parsed.multi.arg ?? []) {
    const eq = argSpec.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --arg '${argSpec}'; expected key=value`);
    const k = argSpec.slice(0, eq);
    const v = argSpec.slice(eq + 1);
    inputs[k] = coerceCliArg(v, inputTypeMap.get(k));
  }

  // Friendly pre-flight check for missing required inputs
  const missing = prog.inputs.filter(
    (inp) => inp.defaultRef === "NONE" && !Object.prototype.hasOwnProperty.call(inputs, inp.name)
  );
  if (missing.length > 0) {
    const list = missing.map((m) => `  - ${m.name}: ${canonicalTypeString(m.type)}`).join("\n");
    const example = missing.map((m) => `--arg ${m.name}=...`).join(" ");
    throw new Error(
      `Missing required input(s) for ${filePath}:\n${list}\n\nProvide them via --inputs <file.json> or:\n  spl run ${filePath} ${example}`
    );
  }

  const statePath = parsed.values.state;
  const saveStatePath = parsed.values["save-state"] ?? (parsed.bools["commit-state"] ? statePath : undefined);
  const initialState =
    statePath && fs.existsSync(statePath)
      ? (canonicalJsonParse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>)
      : {};

  const limits = parsed.values.limits
    ? (JSON.parse(fs.readFileSync(parsed.values.limits, "utf8")) as Partial<VmLimits>)
    : undefined;

  const walPath = parsed.values.wal;
  const existingWal = walPath ? readWalJsonl(walPath) : undefined;
  if (!quiet && existingWal && existingWal.length > 0) {
    console.error(c.yellow(`↻ Resuming from WAL '${walPath}' (${existingWal.length} recorded effect(s))`, true));
  }

  const fsRootMounts = parseMounts(parsed.multi.mount ?? []);
  const jsTools = await loadJsTools(parsed.values["js-tools"]);
  const mcpHandler = await loadMcpHandler(parsed.values["mcp-module"]);
  const openaiClient = process.env.OPENAI_API_KEY ? createOfficialOpenAiClient() : undefined;
  const dispatcher = new HostRuntime({ catalog, openaiClient, fsRootMounts, jsTools, mcpHandler });

  const trace = await runVm({
    bytecode: prog,
    catalog: catPath ? catalog : undefined,
    inputs,
    initialState,
    limits,
    dispatcher,
    replayLog: existingWal && existingWal.length > 0 ? existingWal : undefined,
    replayMode: existingWal && existingWal.length > 0 ? "recovery" : "live",
    onEffectRecorded: walPath
      ? (rec) => {
          fs.appendFileSync(walPath, canonicalJsonStringify(rec) + "\n", "utf8");
        }
      : undefined,
    onCommitState: saveStatePath
      ? (finalState) => {
          fs.writeFileSync(saveStatePath, canonicalJsonStringify(finalState) + "\n", "utf8");
        }
      : undefined,
  });

  const traceOutPath = parsed.values["trace-out"];
  if (traceOutPath) {
    fs.writeFileSync(traceOutPath, canonicalJsonStringify(trace) + "\n", "utf8");
  }

  if (parsed.bools["result-only"]) {
    process.stdout.write(canonicalJsonStringify(trace.result) + "\n");
  } else if (parsed.bools.json || !process.stdout.isTTY) {
    process.stdout.write(canonicalJsonStringify(trace) + "\n");
  } else {
    printPrettyTrace(trace, saveStatePath, traceOutPath);
  }

  if (trace.result.status === "trap") {
    process.exitCode = 2;
  }
}

async function cmdReplay(rawArgs: string[]): Promise<void> {
  const parsed = parseFlags(rawArgs, [
    { name: "trace", short: "t", takesValue: true },
    { name: "strict", takesValue: false },
    { name: "wal", takesValue: true },
    { name: "catalog", short: "c", takesValue: true },
    { name: "inputs", short: "i", aliases: ["input"], takesValue: true },
    { name: "state", short: "s", takesValue: true },
    { name: "mount", takesValue: true, multi: true },
    { name: "js-tools", takesValue: true },
    { name: "mcp-module", takesValue: true },
    { name: "trace-out", aliases: ["save-trace"], takesValue: true },
    { name: "json", takesValue: false },
    { name: "quiet", short: "q", takesValue: false },
    { name: "help", short: "h", takesValue: false },
  ]);

  if (parsed.bools.help || parsed.positionals.length === 0 || (!parsed.values.trace && !parsed.values.wal)) {
    printCommandHelp("replay");
    if (!parsed.bools.help) process.exitCode = 1;
    return;
  }

  const bcPath = parsed.positionals[0];
  const bc = readTextOrStdin(bcPath);
  const strict = Boolean(parsed.bools.strict);
  const quiet = Boolean(parsed.bools.quiet);
  const { catalog, pathUsed: catPath } = resolveCatalog(parsed.values.catalog, quiet);

  let inputs: Record<string, unknown> = {};
  let initialState: Record<string, unknown> = {};
  let limits: Partial<VmLimits> | undefined;
  let replayLog: EffectRecord[] = [];
  let prevTrace: NormativeTrace | null = null;

  if (parsed.values.trace) {
    prevTrace = canonicalJsonParse(fs.readFileSync(parsed.values.trace, "utf8")) as unknown as NormativeTrace;
    inputs = prevTrace.inputs;
    initialState = prevTrace.initial_state;
    limits = prevTrace.limits;
    replayLog = prevTrace.effects as EffectRecord[];
  }
  if (parsed.values.wal) {
    replayLog = readWalJsonl(parsed.values.wal);
  }
  if (parsed.values.inputs) {
    inputs = canonicalJsonParse(fs.readFileSync(parsed.values.inputs, "utf8")) as Record<string, unknown>;
  }
  if (parsed.values.state && fs.existsSync(parsed.values.state)) {
    initialState = canonicalJsonParse(fs.readFileSync(parsed.values.state, "utf8")) as Record<string, unknown>;
  }

  const dispatcher = strict
    ? undefined
    : new HostRuntime({
        catalog,
        openaiClient: process.env.OPENAI_API_KEY ? createOfficialOpenAiClient() : undefined,
        fsRootMounts: parseMounts(parsed.multi.mount ?? []),
        jsTools: await loadJsTools(parsed.values["js-tools"]),
        mcpHandler: await loadMcpHandler(parsed.values["mcp-module"]),
      });

  const trace = await runVm({
    bytecode: bc,
    catalog: catPath ? catalog : undefined,
    inputs,
    initialState,
    limits,
    dispatcher,
    replayLog,
    replayMode: strict ? "strict_replay" : "recovery",
  });

  const traceOutPath = parsed.values["trace-out"];
  if (traceOutPath) {
    fs.writeFileSync(traceOutPath, canonicalJsonStringify(trace) + "\n", "utf8");
  }

  if (strict && prevTrace) {
    const identical = canonicalTraceJson(trace) === canonicalTraceJson(prevTrace);
    if (!quiet) {
      console.error(
        identical
          ? `${c.green("✓", true)} Strict replay verified: byte-identical normative trace (${trace.effects.length} effect(s))`
          : `${c.red("✗", true)} Strict replay MISMATCH: normative trace diverged`
      );
    }
    if (!identical) {
      process.exitCode = 3;
      if (parsed.bools.json || !process.stdout.isTTY) {
        process.stdout.write(canonicalJsonStringify(trace) + "\n");
      }
      return;
    }
  }

  if (parsed.bools.json || !process.stdout.isTTY) {
    process.stdout.write(canonicalJsonStringify(trace) + "\n");
  } else {
    printPrettyTrace(trace, undefined, traceOutPath);
  }

  if (trace.result.status === "trap") {
    process.exitCode = 2;
  }
}

// --- Entry Point ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    if (cmd === "help" && args[1]) printCommandHelp(args[1]);
    else printMainHelp();
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(`spl v${CLI_VERSION} (SPLB 5)`);
    return;
  }

  const rest = args.slice(1);
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "inspect":
      return cmdInspect(rest);
    case "compile":
      return cmdCompile(rest);
    case "translate":
      return cmdTranslate(rest);
    case "run":
      return cmdRun(rest);
    case "replay":
      return cmdReplay(rest);
    default: {
      const known = ["init", "inspect", "compile", "translate", "run", "replay"];
      const closest = known.map((k) => ({ k, d: levenshtein(cmd, k) })).sort((a, b) => a.d - b.d)[0];
      const hint = closest && closest.d <= 3 ? ` Did you mean '${closest.k}'?` : "";
      throw new Error(`Unknown command '${cmd}'.${hint} Run 'spl --help' to see available commands.`);
    }
  }
}

main().catch((err) => {
  console.error(`${c.red("Error:", true)} ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
