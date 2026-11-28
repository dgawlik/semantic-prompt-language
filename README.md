# Semantic Prompt Language (SPL) v5

**SPL v5** is a CLI compiler and deterministic stack VM that turns **natural-language instructions** into verifiable, replayable bytecode where **the VM—not the LLM—owns control flow**.

You write plain-English workflow instructions + a **Signature Catalog** (`catalog.json`). The `spl` CLI compiles your prose via **OpenAI Lark CFG constrained decoding** and a **bounded compile-repair loop** into statically typed, canonical UTF-8 stack bytecode (`SPLB 5`), pushing model calls strictly down to typed leaf effects (`model.decide` and `model.ask<T>`).

See [SPEC.md](./SPEC.md) for the full normative specification.

---

## What It Is & How It Works

```text
Natural-language prose (.txt) + Signature Catalog (catalog.json)
   │  spl translate: OpenAI Lark CFG decoding + static typecheck + compile-repair loop
   ▼
Canonical UTF-8 Textual Stack Bytecode (.splb / SPLB 5)
   │  ═══════════════ DETERMINISM BOUNDARY ═══════════════
   │  spl run: Deterministic Stack VM + sandboxed effects + WAL + transactional state
   ▼
Result + Atomic Durable State Commit + Normative Trace (.json)
   │  spl replay --strict: 0-API-call offline verification
   ▼
Byte-identical Normative Trace (or REPLAY_DIVERGENCE trap)
```

### Core Guarantees
- **Write prose, get checked bytecode:** Constrained decoding enforces the static Lark CFG ([grammar/spl_v5.lark](./grammar/spl_v5.lark)), and the compiler statically verifies types, nullability, exhaustive `switch`, strict JSON Schemas, and catalog capabilities before emitting `.splb`.
- **VM owns control flow; models are typed data leaves:**
  - `model.decide`: Closed-set judgment via OpenAI logprob-scored softmax classifier with optional `min_confidence` thresholds and full probability vectors in the trace.
  - `model.ask<T>`: Text or strict JSON-Schema-constrained generation via OpenAI Responses API, runtime-validated against `T`.
- **Byte-identical bytecode & strict replay:** Once compiled to `.splb`, identical `(bytecode, inputs, initial_state, limits, effect_log)` always produces the identical result, state commit, and normative trace.
- **Transactional durable state:** `state` variables commit atomically to `--state` / `--save-state` only on clean completion and roll back on any trap.
- **Sandboxed capabilities:** Virtual FS mounts (`--mount`), argv-only `shell.run` (`execFile`, never `sh -c`), SSRF/domain-checked `web.fetch`, and typed JS/MCP tools (`--js-tools`, `--mcp-module`).

---

## Setup

Requires **Node.js 22+**.

```bash
npm install
npm run build
npm test
```

Optionally install `spl` globally from this repo so you can run `spl` directly (otherwise use `node dist/src/cli.js` or `npm run spl --`):

```bash
npm link
```

Set your OpenAI API key for `translate` and live model calls:

```bash
# macOS / Linux
export OPENAI_API_KEY="sk-..."

# Windows PowerShell
$env:OPENAI_API_KEY="sk-..."
```

---

## CLI Workflow: Natural Language → Bytecode → Run → Replay

### 1. Compile Natural Language to Bytecode (`spl translate`)

```bash
spl translate examples/01_ticket_triage.txt \
  --catalog examples/catalog.json \
  --model gpt-4.1 \
  --max-attempts 3 \
  --emit-source ticket.spl \
  --out ticket.splb
```

You can also pipe prose from stdin using `-`:

```bash
echo "Take an integer input n and return n * 2." | spl translate - --catalog examples/catalog.json --out double.splb
```

### 2. Inspect Compiled Bytecode & Capabilities (`spl inspect`)

Audit the exact capabilities, inputs, durable state, and SHA-256 hash before running anything:

```bash
spl inspect ticket.splb
```

### 3. Run Compiled Bytecode with Durable State & Trace (`spl run`)

```bash
spl run ticket.splb \
  --catalog examples/catalog.json \
  --inputs examples/01_ticket_inputs.json \
  --state ticket_state.json \
  --commit-state \
  --wal ticket.wal.jsonl \
  --trace-out ticket_trace.json
```

- `--state ticket_state.json --commit-state`: Loads persistent state (if the file exists) and atomically updates it **only** if the run succeeds cleanly (rolled back on trap).
- `--wal ticket.wal.jsonl`: Appends every completed effect to a write-ahead log for mid-run crash recovery.
- `--trace-out ticket_trace.json`: Saves the full canonical trace JSON.
- `--input-json '{"ticket":{"id":42,"text":"Charged twice"}}'`: Pass inputs inline without a JSON file.
- `--result-only`: Print only the result object instead of the full trace to stdout.

You can also pass a `.txt` prose file directly to `spl run` to translate and execute in one command:

```bash
spl run examples/01_ticket_triage.txt \
  --catalog examples/catalog.json \
  --inputs examples/01_ticket_inputs.json \
  --result-only
```

### 4. Strict Offline Replay & Crash Recovery (`spl replay`)

Verify a recorded trace offline with **zero API calls** (exits non-zero on `REPLAY_DIVERGENCE` or normative trace mismatch):

```bash
spl replay ticket.splb --trace ticket_trace.json --strict
```

Recover from a mid-run crash using the partial WAL (replays completed effects from the WAL, then seamlessly resumes live execution):

```bash
spl replay ticket.splb \
  --wal ticket.wal.jsonl \
  --catalog examples/catalog.json \
  --inputs examples/01_ticket_inputs.json \
  --state ticket_state.json
```

---

## Running the Examples via CLI (`examples/`)

All examples in `examples/` are plain natural-language `.txt` specs paired with [`examples/catalog.json`](./examples/catalog.json):

### Example 1: Refund Ticket Triage (Decisions + Durable State + Reply)
```bash
spl translate examples/01_ticket_triage.txt --catalog examples/catalog.json --out ticket.splb
spl inspect ticket.splb
spl run ticket.splb --catalog examples/catalog.json --inputs examples/01_ticket_inputs.json --state state.json --commit-state --trace-out trace.json
spl replay ticket.splb --trace trace.json --strict
```

### Example 2: Structured Invoice Extraction (Strict JSON Schema + Bounded Retry)
```bash
spl translate examples/02_invoice_extraction.txt --catalog examples/catalog.json --out invoice.splb
spl run invoice.splb --catalog examples/catalog.json --inputs examples/02_invoice_inputs.json --result-only
```

### Example 3: Research Brief (Web Search/Fetch + Virtual FS Output)
```bash
spl translate examples/03_research_brief.txt --catalog examples/catalog.json --out research.splb
spl run research.splb \
  --catalog examples/catalog.json \
  --inputs examples/03_research_inputs.json \
  --mount output=./out_sandbox \
  --result-only
```

### Example 4: Hybrid Refund Risk Routing (MCP + JS Tool + Shell Profile + Decision API)
```bash
spl translate examples/04_refund_risk_routing.txt --catalog examples/catalog.json --out routing.splb
spl run routing.splb \
  --catalog examples/catalog.json \
  --inputs examples/04_refund_inputs.json \
  --mount workspace=. \
  --js-tools examples/js_tools.mjs \
  --mcp-module examples/mcp_handler.mjs \
  --result-only
```

---

## Full CLI Reference

Run `spl <command> --help` for full details on any command.

| Command | Purpose |
|---|---|
| `spl init [dir] [--force]` | Scaffold a starter `catalog.json` and `workflow.txt` |
| `spl translate <prose.txt\|-> [-c cat.json] [-m model] [--temperature n] [--max-attempts 3] [-o out.splb] [--emit-source out.spl]` | Compile natural language into canonical `SPLB 5` bytecode via OpenAI Lark CFG + live compile-repair progress |
| `spl inspect <file.splb> [--disasm] [--json]` | Audit bytecode SHA-256, catalog digest, capabilities, inputs, state, and functions |
| `spl compile <file.spl\|-> [-c cat.json] [-o out.splb]` | Compile an existing `.spl` file into canonical `SPLB 5` bytecode |
| `spl run <file.splb\|.spl\|.txt> [-c cat.json] [-i inputs.json] [--arg k=v]... [-s state.json] [--commit-state] [--mount root=dir]... [--js-tools mod.mjs] [--mcp-module mod.mjs] [--wal wal.jsonl] [--trace-out trace.json] [--json\|--result-only]` | Execute bytecode (or auto-compile `.spl`/`.txt`) with typed `--arg` inputs, sandboxed mounts/tools, transactional state, and WAL |
| `spl replay <file.splb> -t <trace.json> [--strict] [--wal wal.jsonl]` | Strictly verify a trace offline (`--strict`) or resume from a partial WAL |
