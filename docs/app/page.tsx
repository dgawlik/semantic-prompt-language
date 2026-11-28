import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Cpu,
  Database,
  FileCode2,
  GitBranch,
  Lock,
  Repeat,
  Scale,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { CodeBlock } from "@/components/CodeBlock";
import { InteractiveTranslator } from "@/components/InteractiveTranslator";

const PIPELINE = [
  {
    step: "01",
    title: "Natural-Language Prose",
    desc: "Plain-English instructions paired with a host Signature Catalog declaring permitted capabilities.",
    tag: "Input",
    accent: "from-zinc-500/20 to-zinc-700/10 border-white/10",
  },
  {
    step: "02",
    title: "Lark CFG + Repair Loop",
    desc: "OpenAI constrained decoding enforces SPL syntax while bounded retries repair static type & catalog errors.",
    tag: "Non-deterministic",
    accent: "from-violet-500/20 to-fuchsia-500/10 border-violet-400/25",
  },
  {
    step: "03",
    title: "Canonical SPLB 5 Bytecode",
    desc: "Determinism boundary: fixed AST + catalog always emits byte-identical UTF-8 textual stack bytecode.",
    tag: "Deterministic",
    accent: "from-cyan-500/20 to-sky-500/10 border-cyan-400/30",
  },
  {
    step: "04",
    title: "Stack VM + Strict Replay",
    desc: "Logical limits, transactional durable state, append-only effect log, and hard REPLAY_DIVERGENCE traps.",
    tag: "Verifiable",
    accent: "from-emerald-500/20 to-teal-500/10 border-emerald-400/25",
  },
];

const PILLARS = [
  {
    icon: GitBranch,
    title: "VM Owns Control Flow",
    body: "Branching, exhaustive switch, while/for loops, recursion, and try/catch execute deterministically in the stack VM—never improvised by an LLM loop.",
    color: "text-cyan-300 bg-cyan-500/10 border-cyan-400/20",
  },
  {
    icon: Scale,
    title: "Leaf Decision & Generation APIs",
    body: "model.decide runs a logprob-scored softmax classifier with min_confidence thresholds; model.ask<T> enforces strict JSON Schema validation at the boundary.",
    color: "text-violet-300 bg-violet-500/10 border-violet-400/20",
  },
  {
    icon: Cpu,
    title: "Byte-Identical SPLB 5 Bytecode",
    body: "Human-readable UTF-8 stack assembly with canonical constant pools, embedded catalog SHA-256, and sorted capability manifests. No algebraic rewrites.",
    color: "text-sky-300 bg-sky-500/10 border-sky-400/20",
  },
  {
    icon: Database,
    title: "Transactional State & WAL Replay",
    body: "Persistent state commits atomically on clean exit and rolls back on any trap. Crashed runs recover from the WAL; strict replay verifies zero divergence.",
    color: "text-emerald-300 bg-emerald-500/10 border-emerald-400/20",
  },
  {
    icon: ShieldCheck,
    title: "Capability-Sandboxed Effects",
    body: "Virtual-root fs.* blocks traversal & symlink escapes; shell.run uses argv-only execFile; web.fetch blocks SSRF private IPs; JS & MCP tools are schema-checked.",
    color: "text-amber-300 bg-amber-500/10 border-amber-400/20",
  },
  {
    icon: Lock,
    title: "Checked i64 & Finite f64",
    body: "Signed 64-bit BigInt overflow traps, finite float64 (-0.0 -> 0.0, NaN/Inf forbidden), Unicode code-point strings, value semantics, and integer step/memory limits.",
    color: "text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-400/20",
  },
];

const CLI_SNIPPET = `# 1. Compile natural-language instructions into canonical SPLB 5 bytecode
spl translate examples/01_ticket_triage.txt -c examples/catalog.json -m gpt-6-luna -o ticket.splb

# 2. Audit required capabilities, inputs, durable state, and SHA-256
spl inspect ticket.splb

# 3. Execute on the deterministic VM with atomic state commit + trace log
spl run ticket.splb -c examples/catalog.json -i examples/01_ticket_inputs.json -s state.json --commit-state --trace-out trace.json

# 4. Strictly verify deterministic replay offline (0 API calls)
spl replay ticket.splb --trace trace.json --strict`;

export default function HomePage() {
  return (
    <div className="relative">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/[0.08] bg-grid-subtle">
        <div className="hero-glow pointer-events-none absolute inset-0" />
        <div className="relative mx-auto max-w-7xl px-6 pb-20 pt-20 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3.5 py-1 text-xs font-medium text-cyan-200">
              <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
              <span>SPL v5 · OpenAI Lark CFG → Canonical SPLB 5 → Deterministic Stack VM</span>
            </div>

            <h1 className="bg-gradient-to-b from-white via-zinc-100 to-zinc-400 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-6xl sm:leading-[1.08]">
              Natural language in.
              <br />
              <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-400 bg-clip-text text-transparent">
                Deterministic bytecode out.
              </span>
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg">
              Semantic Prompt Language v5 compiles plain-English instructions into a statically typed Context-Free
              Language and canonical UTF-8 stack bytecode.{" "}
              <span className="text-zinc-200">The VM—not the model—owns control flow.</span> Model calls are explicit,
              schema-validated leaf data effects.
            </p>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/docs#translator"
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-violet-400 px-6 py-3 text-sm font-semibold text-zinc-950 shadow-xl shadow-cyan-500/20 transition hover:brightness-110"
              >
                <Sparkles className="h-4 w-4" />
                Try Interactive Translator
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/docs"
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-zinc-100 transition hover:border-white/25 hover:bg-white/[0.08]"
              >
                <BookOpen className="h-4 w-4 text-cyan-300" />
                Read v5 Documentation
              </Link>
            </div>
          </div>

          {/* 4-Stage Pipeline Cards */}
          <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {PIPELINE.map((p) => (
              <div
                key={p.step}
                className={`relative rounded-2xl border bg-gradient-to-b p-5 backdrop-blur-sm ${p.accent}`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-zinc-400">{p.step}</span>
                  <span className="rounded-full border border-white/10 bg-zinc-950/60 px-2.5 py-0.5 font-mono text-[10px] text-zinc-300">
                    {p.tag}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-white">{p.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Interactive Translator Preview */}
      <section id="playground" className="mx-auto max-w-7xl px-6 py-20">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <div className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-cyan-300">
              <FileCode2 className="h-3.5 w-3.5" />
              Live Compiler &amp; Stack VM
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Translate natural language into verified SPL v5
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-zinc-400">
              Test instant prose-to-SPL translation (including the bounded compile-repair loop), edit generated code to
              trigger real static diagnostics, inspect canonical <code className="text-cyan-300">SPLB 5</code> bytecode,
              and run strict offline replay right in your browser.
            </p>
          </div>
          <Link
            href="/docs"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-300 hover:text-cyan-200"
          >
            Open inside full Docs
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <InteractiveTranslator compact />
      </section>

      {/* 6 Pillars */}
      <section className="border-y border-white/[0.08] bg-zinc-950/60 py-20">
        <div className="mx-auto max-w-7xl px-6">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-violet-300">
              <Repeat className="h-3.5 w-3.5" />
              Architectural Guarantees
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Built for auditability, security, and exact replay
            </h2>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.title}
                  className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 transition hover:border-white/15 hover:bg-zinc-900/70"
                >
                  <div className={`inline-flex rounded-xl border p-2.5 ${item.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-white">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">{item.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CLI Quickstart */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-emerald-300">
              <Terminal className="h-3.5 w-3.5" />
              CLI-First Workflow
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Compile, inspect, run, and replay from your terminal
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Every operation runs directly from the <code className="text-zinc-200">spl</code> CLI—no boilerplate
              scripts required. Pass typed <code className="text-zinc-200">--arg key=value</code> inputs, mount virtual
              FS roots with <code className="text-zinc-200">--mount</code>, commit transactional state with{" "}
              <code className="text-zinc-200">--commit-state</code>, and verify traces offline with{" "}
              <code className="text-zinc-200">--strict</code>.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/docs#cli"
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-white/[0.08]"
              >
                Full CLI Reference
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/docs#bytecode"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-xs font-medium text-zinc-400 transition hover:text-white"
              >
                Explore SPLB 5 Opcodes
              </Link>
            </div>
          </div>

          <div className="lg:col-span-7">
            <CodeBlock code={CLI_SNIPPET} language="bash" title="Terminal — SPL v5 CLI" />
          </div>
        </div>
      </section>
    </div>
  );
}
