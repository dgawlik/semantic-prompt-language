import {
  BookOpen,
  Cpu,
  Database,
  FileCode2,
  Scale,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { CodeBlock } from "@/components/CodeBlock";
import { InteractiveTranslator } from "@/components/InteractiveTranslator";

const SECTIONS = [
  { id: "overview", label: "Overview & Determinism", icon: BookOpen },
  { id: "translator", label: "Interactive Translator", icon: Sparkles },
  { id: "language", label: "Language & Types", icon: FileCode2 },
  { id: "model-leaves", label: "Model Leaves", icon: Scale },
  { id: "capabilities", label: "Catalog & Sandboxing", icon: ShieldCheck },
  { id: "bytecode", label: "SPLB 5 Bytecode", icon: Cpu },
  { id: "state-replay", label: "State & Strict Replay", icon: Database },
  { id: "cli", label: "CLI & VS Code Plugin", icon: Terminal },
];

const EXAMPLE_SPL = `type Ticket = { id: int, text: string };
input ticket: Ticket;
state approved_count: int = 0;

fn main() -> string {
  let verdict = model.decide(
    "classifier_default",
    \`Classify refund ticket #\${ticket.id}: \${ticket.text}\`,
    ["approve", "reject"],
    { min_confidence: 0.8 }
  );

  // Flow-sensitive nullability narrowing: verdict becomes ("approve" | "reject")
  if (verdict == null) {
    return "manual_review";
  }

  switch (verdict) {
    case "approve": {
      approved_count = approved_count + 1;
      return model.ask<string>("default", \`Write approval reply for #\${ticket.id}\`);
    }
    case "reject": {
      return "rejected";
    }
  }
}`;

const EXAMPLE_SPLB = `SPLB 5
CATALOG f27395a9be5f5f8137efc47bf5de8107a26e0ad613c48775eb6f8dfce19e6913
CAPS ["decision:classifier_default","model:default"]
INPUTS
  ticket {id:int,text:string} NONE
STATE
  approved_count int c0
CONSTS
  c0 I 0
  c1 S "classifier_default"
  c2 S "Classify refund ticket #"
  c3 S "id"
  c4 S ": "
  c5 S "text"
  c6 J ["approve","reject"]
  c7 S "min_confidence"
  c8 F 0.8
SCHEMAS
  s0 {"type":"string"}
FN main () -> string locals=1
  0000: PUSH_CONST c2
  0001: LOAD_INPUT 0
  0002: GET_FIELD c3
  0003: FMT_VAL
  ...
  0012: EFF_DECIDE c1 c6 1
  0013: STORE_LOCAL 0
END`;

const CATALOG_SNIPPET = `{
  "spec_version": "5",
  "models": {
    "default": {
      "provider": "openai",
      "model": "gpt-4.1",
      "max_output_tokens": 1024,
      "strict_schema": true
    }
  },
  "decisions": {
    "classifier_default": {
      "adapter": "openai_logprobs",
      "model": "gpt-4.1-mini",
      "top_logprobs": 20
    }
  },
  "fs_roots": {
    "output": { "permissions": ["read", "write", "list"], "max_file_bytes": 1048576 }
  },
  "shell_profiles": {
    "git_status": {
      "executable": "git",
      "base_argv": ["status", "--porcelain"],
      "cwd_root": "workspace",
      "argv_template": ["--", "\${path}"],
      "env_allowlist": ["LANG"],
      "timeout_ms": 5000
    }
  }
}`;

const CLI_DOCS_SNIPPET = `# Scaffold a starter catalog.json + workflow.txt
spl init

# Compile natural-language prose into canonical SPLB 5 bytecode
spl translate examples/02_invoice_extraction.txt \\
  -c examples/catalog.json \\
  -m gpt-6-luna \\
  --emit-source invoice.spl \\
  -o invoice.splb

# Audit SHA-256, capabilities, inputs, state, and disassembly
spl inspect invoice.splb --disasm

# Run bytecode with typed --arg inputs, virtual FS mount, durable state & WAL
spl run invoice.splb \\
  -c examples/catalog.json \\
  --arg raw_document="Invoice from Acme Cloud Corp: $155 USD" \\
  -s state.json --commit-state \\
  --mount output=./out_sandbox \\
  --wal run.wal.jsonl \\
  --trace-out trace.json

# Verify deterministic offline replay (0 API calls; traps on REPLAY_DIVERGENCE)
spl replay invoice.splb --trace trace.json --strict`;

const OPCODE_GROUPS = [
  {
    group: "Stack & Bindings",
    ops: "PUSH_CONST, PUSH_NULL, PUSH_TRUE, PUSH_FALSE, POP, DUP, LOAD_LOCAL, STORE_LOCAL, LOAD_INPUT, LOAD_STATE, STORE_STATE",
  },
  {
    group: "Checked i64 & Bitwise",
    ops: "IADD, ISUB, IMUL, IDIV, IMOD, INEG, BIT_AND, BIT_OR, BIT_XOR, BIT_NOT, SHL, SHR, USHR",
  },
  {
    group: "Finite f64 & Casts",
    ops: "FADD, FSUB, FMUL, FDIV, FNEG, CAST_I2F, CAST_F2I, CAST_JSON, STR_CONCAT, FMT_VAL",
  },
  {
    group: "Compare & Logic",
    ops: "EQ, NEQ, ILT, ILE, IGT, IGE, FLT, FLE, FGT, FGE, SLT, SLE, SGT, SGE, NOT, IS_NULL",
  },
  {
    group: "Containers (Value Semantics)",
    ops: "MAKE_LIST, MAKE_REC, MAKE_MAP, GET_FIELD, GET_FIELD_OPT, SET_FIELD, GET_INDEX, GET_INDEX_OPT, SET_INDEX, LIST_LEN",
  },
  {
    group: "Control Flow & Exceptions",
    ops: "JMP, JMP_IF_FALSE, JMP_IF_TRUE, JMP_IF_NULL, JMP_IF_NOT_NULL, CALL_FN, CALL_BUILTIN, RET, TRY_PUSH, TRY_POP",
  },
  {
    group: "Leaf Effects",
    ops: "EFF_ASK, EFF_DECIDE, EFF_WEB_SEARCH, EFF_WEB_FETCH, EFF_FS, EFF_SHELL, EFF_JS_TOOL, EFF_MCP_TOOL",
  },
];

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
        {/* Sticky Sidebar TOC */}
        <aside className="hidden lg:col-span-3 lg:block">
          <div className="sticky top-24 space-y-6">
            <div>
              <div className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                SPL v5 Specification
              </div>
              <nav className="space-y-1">
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                  <a
                    key={id}
                    href={`#${id}`}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/[0.05] hover:text-white"
                  >
                    <Icon className="h-4 w-4 text-cyan-400/80" />
                    {label}
                  </a>
                ))}
              </nav>
            </div>

            <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.06] p-4 text-xs text-zinc-300">
              <div className="font-semibold text-cyan-200">Determinism Boundary</div>
              <p className="mt-1.5 leading-relaxed text-zinc-400">
                Prose translation may be non-deterministic. Determinism starts at{" "}
                <code className="text-cyan-300">SPLB 5</code> bytecode generation and holds strictly through execution
                and replay.
              </p>
            </div>
          </div>
        </aside>

        {/* Main Documentation Column */}
        <div className="space-y-16 lg:col-span-9">
          {/* 1. Overview */}
          <section id="overview" className="scroll-mt-24">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[11px] text-cyan-300">
              Normative Spec v5.0
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              SPL v5 Documentation
            </h1>
            <p className="mt-4 text-base leading-relaxed text-zinc-400">
              <strong className="text-zinc-200">Semantic Prompt Language (SPL) v5</strong> turns natural-language
              instructions into a minimal Context-Free Language via OpenAI <code className="text-zinc-200">llguidance</code>{" "}
              Lark CFG constrained decoding, statically validates types and capabilities against a host{" "}
              <strong className="text-zinc-200">Signature Catalog</strong>, compiles the AST into byte-identical UTF-8
              textual stack bytecode (<code className="text-cyan-300">SPLB 5</code>), and runs it on a deterministic VM.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-4">
                <div className="font-mono text-xs text-cyan-300">Invariant 01</div>
                <div className="mt-1 text-sm font-semibold text-white">VM Owns Control Flow</div>
                <p className="mt-1 text-xs text-zinc-400">
                  Models never steer execution flow; outputs are untrusted data validated against strict schemas.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-4">
                <div className="font-mono text-xs text-violet-300">Invariant 02</div>
                <div className="mt-1 text-sm font-semibold text-white">Byte-Identical Compilation</div>
                <p className="mt-1 text-xs text-zinc-400">
                  Fixed AST + canonical catalog always emits the exact same UTF-8 bytecode without algebraic rewrites.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-4">
                <div className="font-mono text-xs text-emerald-300">Invariant 03</div>
                <div className="mt-1 text-sm font-semibold text-white">Exact Offline Replay</div>
                <p className="mt-1 text-xs text-zinc-400">
                  Identical bytecode, inputs, initial state, limits, and effect log reproduce identical traces or trap.
                </p>
              </div>
            </div>
          </section>

          {/* 2. Interactive Natural-Language -> SPL Translator INSIDE Docs */}
          <section id="translator" className="scroll-mt-24">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-cyan-300" />
              <h2 className="text-2xl font-bold tracking-tight text-white">
                Interactive Natural-Language → SPL v5 Translator
              </h2>
            </div>
            <p className="mb-6 text-sm leading-relaxed text-zinc-400">
              Experiment directly inside the documentation. Write plain-English workflow rules (or pick a preset),
              translate via OpenAI Lark CFG (or Instant Demo with a real compile-repair cycle), edit the generated SPL
              to inspect live static diagnostics, examine canonical <code className="text-cyan-300">SPLB 5</code>{" "}
              bytecode, and run the deterministic stack VM with strict offline replay verification.
            </p>
            <InteractiveTranslator />
          </section>

          {/* 3. Language & Type System */}
          <section id="language" className="scroll-mt-24 space-y-5">
            <h2 className="text-2xl font-bold tracking-tight text-white">Language &amp; Static Type System</h2>
            <p className="text-sm leading-relaxed text-zinc-400">
              SPL v5 uses a minimal TypeScript-like brace grammar designed for clean <code className="text-zinc-200">llguidance</code>{" "}
              constrained decoding: no closures, no implicit numeric coercions, explicit <code className="text-zinc-200">mut</code>{" "}
              bindings, pure value semantics for records/lists/maps, and flow-sensitive nullability narrowing.
            </p>

            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 bg-white/[0.03] font-mono text-zinc-300">
                  <tr>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Semantics &amp; Runtime Guarantee</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-zinc-400">
                  <tr>
                    <td className="px-4 py-2.5 font-mono text-amber-300">int</td>
                    <td className="px-4 py-2.5">
                      Checked signed 64-bit <code className="text-zinc-200">BigInt</code> (traps{" "}
                      <code className="text-red-300">NUM_OVERFLOW</code> / <code className="text-red-300">DIV_BY_ZERO</code>
                      ); supports 64-bit bitwise &amp; checked shifts (<code className="text-zinc-200">0..63</code>).
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5 font-mono text-amber-300">float</td>
                    <td className="px-4 py-2.5">
                      Finite IEEE-754 binary64 only. <code className="text-zinc-200">-0.0</code> normalizes to{" "}
                      <code className="text-zinc-200">0.0</code>; <code className="text-red-300">NaN</code> /{" "}
                      <code className="text-red-300">±Infinity</code> trap with{" "}
                      <code className="text-red-300">FLOAT_NON_FINITE</code>. Explicit <code className="text-zinc-200">as float</code> /{" "}
                      <code className="text-zinc-200">as int</code> casts required.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5 font-mono text-amber-300">string</td>
                    <td className="px-4 py-2.5">
                      Valid UTF-8. <code className="text-zinc-200">len(s)</code>, indexing, slicing, and ordering operate
                      on Unicode scalar values (code points), not UTF-16 code units.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5 font-mono text-amber-300">T?</td>
                    <td className="px-4 py-2.5">
                      Nullable type. Direct <code className="text-zinc-200">.field</code> / <code className="text-zinc-200">[i]</code>{" "}
                      is a compile error unless narrowed via <code className="text-zinc-200">if (x != null)</code>,
                      coalesced via <code className="text-zinc-200">??</code>, or optional-chained via{" "}
                      <code className="text-zinc-200">?.</code>.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5 font-mono text-amber-300">&quot;a&quot; | &quot;b&quot;</td>
                    <td className="px-4 py-2.5">
                      Closed string literal union (≥2 distinct literals). Requires exhaustive{" "}
                      <code className="text-zinc-200">switch</code> coverage or <code className="text-zinc-200">default</code>.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5 font-mono text-amber-300">list&lt;T&gt;, map&lt;string, T&gt;, {"{...}"}</td>
                    <td className="px-4 py-2.5">
                      Pure value-semantic containers with canonical Unicode code-point key sorting. Recursive type
                      aliases are forbidden for finite strict JSON Schema bijection.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <CodeBlock code={EXAMPLE_SPL} language="spl" title="Example — Nullability Narrowing, Switch & Leaf Effects" showLineNumbers />
          </section>

          {/* 4. Model Leaves */}
          <section id="model-leaves" className="scroll-mt-24 space-y-5">
            <h2 className="text-2xl font-bold tracking-tight text-white">Leaf Model Effects</h2>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="rounded-2xl border border-cyan-400/20 bg-zinc-900/50 p-5">
                <div className="font-mono text-xs font-semibold text-cyan-300">model.decide(profile, prompt, options, opts?)</div>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  Backed by a pluggable host Decision API (reference adapter:{" "}
                  <code className="text-zinc-200">openai_logprobs</code>). Maps candidate labels to single tokens,
                  computes numerically stable softmax scores summing to <code className="text-zinc-200">1.0</code>, and
                  records the full <code className="text-zinc-200">decision_scores</code> vector in the trace.
                </p>
                <ul className="mt-3 space-y-1 text-xs text-zinc-400">
                  <li>• Without <code className="text-zinc-200">min_confidence</code>: returns union <code className="text-amber-300">&quot;a&quot; | &quot;b&quot;</code></li>
                  <li>• With <code className="text-zinc-200">min_confidence</code>: returns nullable <code className="text-amber-300">(&quot;a&quot; | &quot;b&quot;)?</code> (<code className="text-zinc-200">null</code> when uncertain)</li>
                  <li>• Deterministic tie-breaking by option index</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-violet-400/20 bg-zinc-900/50 p-5">
                <div className="font-mono text-xs font-semibold text-violet-300">model.ask&lt;T&gt;(profile, prompt, opts?)</div>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  Calls the OpenAI Responses API with explicit parameters (<code className="text-zinc-200">store: false</code>,
                  explicit <code className="text-zinc-200">model</code>, <code className="text-zinc-200">max_output_tokens</code>).
                  Uses plain text for <code className="text-amber-300">string</code> and deterministic strict JSON Schema
                  for all structured types <code className="text-amber-300">T</code>.
                </p>
                <ul className="mt-3 space-y-1 text-xs text-zinc-400">
                  <li>• Non-object schemas (e.g. <code className="text-zinc-200">list&lt;int&gt;</code>) auto-wrap/unwrap</li>
                  <li>• Runtime boundary validates int64 bounds, finite floats, closed fields</li>
                  <li>• Invalid model output raises catchable <code className="text-red-300">MODEL_SCHEMA_ERROR</code></li>
                </ul>
              </div>
            </div>
          </section>

          {/* 5. Signature Catalog & Capabilities */}
          <section id="capabilities" className="scroll-mt-24 space-y-5">
            <h2 className="text-2xl font-bold tracking-tight text-white">Signature Catalog &amp; Sandboxed Capabilities</h2>
            <p className="text-sm leading-relaxed text-zinc-400">
              Every effect call is statically type-checked against the host-supplied{" "}
              <code className="text-zinc-200">SignatureCatalog</code> at compile time. The compiler embeds{" "}
              <code className="text-cyan-300">CATALOG &lt;sha256&gt;</code> and a sorted{" "}
              <code className="text-cyan-300">CAPS [...]</code> manifest directly in the bytecode header so hosts can
              audit and authorize exact capabilities before loading.
            </p>
            <CodeBlock code={CATALOG_SNIPPET} language="json" title="catalog.json (excerpt)" />
          </section>

          {/* 6. SPLB 5 Bytecode */}
          <section id="bytecode" className="scroll-mt-24 space-y-5">
            <h2 className="text-2xl font-bold tracking-tight text-white">Canonical SPLB 5 Bytecode</h2>
            <p className="text-sm leading-relaxed text-zinc-400">
              Compiled artifacts are human-readable UTF-8 textual stack bytecode (<code className="text-cyan-300">.splb</code>)
              with LF line endings, first-encounter deduplicated <code className="text-zinc-200">CONSTS</code> and{" "}
              <code className="text-zinc-200">SCHEMAS</code> pools, and lexicographically sorted function blocks (with{" "}
              <code className="text-zinc-200">main</code> last).
            </p>

            <CodeBlock code={EXAMPLE_SPLB} language="splb" title="ticket.splb — Canonical SPLB 5 Disassembly" />

            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 bg-white/[0.03] font-mono text-zinc-300">
                  <tr>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Opcodes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-zinc-400">
                  {OPCODE_GROUPS.map((g) => (
                    <tr key={g.group}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-zinc-200">{g.group}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-cyan-200/90">{g.ops}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 7. Durable State & Replay */}
          <section id="state-replay" className="scroll-mt-24 space-y-4">
            <h2 className="text-2xl font-bold tracking-tight text-white">Transactional State &amp; Strict Replay</h2>
            <p className="text-sm leading-relaxed text-zinc-400">
              Module-level <code className="text-zinc-200">state</code> bindings mutate an in-VM staged copy and commit
              atomically only when <code className="text-zinc-200">fn main</code> returns normally. Any trap (
              <code className="text-red-300">LIMIT_EXCEEDED</code>, <code className="text-red-300">NUM_OVERFLOW</code>,{" "}
              <code className="text-red-300">UNHANDLED_ERROR</code>, or{" "}
              <code className="text-red-300">REPLAY_DIVERGENCE</code>) discards all staged mutations.
            </p>
            <p className="text-sm leading-relaxed text-zinc-400">
              Every completed effect appends a canonical record to the write-ahead effect log. During crash recovery or{" "}
              <code className="text-zinc-200">--strict</code> offline replay, the VM compares{" "}
              <code className="text-zinc-200">(seq, kind, target, canonical_args)</code> byte-for-byte against the log
              and hard-traps with uncatchable <code className="text-red-300">REPLAY_DIVERGENCE</code> on any mismatch.
            </p>
          </section>

          {/* 8. CLI & VS Code */}
          <section id="cli" className="scroll-mt-24 space-y-5">
            <h2 className="text-2xl font-bold tracking-tight text-white">CLI Reference &amp; VS Code Extension</h2>
            <CodeBlock code={CLI_DOCS_SNIPPET} language="bash" title="End-to-End CLI Commands" />

            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-sm font-semibold text-white">VS Code Syntax Highlighting (.spl &amp; .splb)</div>
              <p className="mt-1.5 text-xs text-zinc-400">
                Install the bundled extension from the repo root (auto-detects VS Code, Cursor, Antigravity, and
                Windsurf):
              </p>
              <div className="mt-3">
                <CodeBlock code="npm run install:vscode" language="bash" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
