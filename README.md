# Semantic Prompt Language (SPL)

**SPL (`.splx`)** is a strongly-typed, agent-first functional programming language that compiles to standard ES Module JavaScript (`.mjs`), targeting **Browser** and **Node 22+ / Bun / Deno** with **zero runtime dependencies**.

---

## Highlights

- **Hindley-Milner Type Inference + Row Polymorphism**: structural records, functional spread (`{ ...x, k: v }`), open records (`..r`), hybrid dynamic records (`..extra: Dict<Str, Json>`), and zero `null`/`undefined`.
- **First-Class Prompt Blocks (`@{ ... }`)**: auto-dedented, brace-balanced templates with `${expr}` interpolation that can be passed as trailing arguments to any function.
- **Three Comment Layers (`//`, `///`, `''`)**: regular comments (`//`), IDE doc-comments (`///`), and compile-time LLM schema hints (`''`) emitted directly into JSON Schema `"description"` fields.
- **Compile-Time Schemas & Reifiable Generics**: `type_schema<T>()`, `decode<T>(json)`, and user-defined `reified fn<T>` with zero runtime reflection.
- **Colorless (Transparent) Async**: no `async`/`await` keywords; pure functions compile to sync JS, suspending functions compile to `async`/`await`, `map` runs sequentially by default, and concurrency is opt-in via `par_map`, `async_all`, and `async_race`.
- **Rust-Style Safety & Ergonomics**: tagged `enum`s with exhaustive `match`, `Option<T>` (`T?`, `?.`, `??`), `Result<T, E>` (`?`, `??`), `mut self` & `mut` params, explicit `as` casts, ranges (`0..10..2`, `0..=10`), lazy `Iter<T>`, lightweight `trait`/`impl`, extension methods, and self-tail-call optimization (TCO).
- **Batteries-Included Agentic Standard Library**: unified multi-provider `std/llm` (OpenAI Responses/Chat, Anthropic, Google Gemini), `std/traces` JSONL + deterministic `llm.agent_replay<T>`, sandboxed `std/codegen`, pure SPL `std/collections`, and universal/server host I/O.
- **Built-In LSP & VS Code Extension**: live diagnostics, error-tolerant member completion, named-argument completions, signature help, live JSON Schema hover previews, go-to-definition, and document symbols.

---

## Quick Example

```splx
import llm from "std/llm"

/// Developer doc-comment (IDE hover only; omitted from LLM schemas).
'' Historical figure profile returned by the LLM.
type Person = struct {
    firstName: Str  '' Given name, e.g. Ada
    lastName: Str   '' Family name, e.g. Lovelace
    age: Int        '' Age in years
    profession: Str '' Primary occupation
}

// Defaults to provider: "openai_responses", model: "gpt-6-luna", and ~/.spl/credentials.json (`spl login`).
// Automatically sends `type_schema<Person>()` and validates the response into `Person`!
let ada = @{
    Generate a profile for Ada Lovelace.
}.ask<Person>()?

print("${ada.firstName} ${ada.lastName} (${ada.age}) — ${ada.profession}")
```

### Multi-Turn Agent with Typed Tools & Streaming `StreamDelta`

```splx
import llm from "std/llm"
import fs from "std/fs"

type FilePath = Str '' Relative file path to read

let read_file = llm.tool<FilePath, Str>(
    name: "read_file",
    description: "Reads UTF-8 contents of a file"
) { path ->
    fs.read(path)
}

let (answer, trace) = @{
    Inspect package.json and summarize the available scripts.
}.agent<Str>(
    thinking: Some(llm.ThinkLow),
    tools: [read_file.any()],
    on_delta: Some({ delta ->
        match delta {
            llm.SummaryDelta(s) => print_inline(s)
            llm.ThinkingDelta(t) => print_inline(t)
            llm.TextDelta(t) => print_inline(t)
            _ => ()
        }
    })
)?

print("\nTurns: ${trace.turns}\n${answer}")
```

---

## Getting Started

### Requirements

- **Node.js 22+** (or Bun / Deno for executing compiled `.mjs` output)

### Build & Test

```bash
npm run build
npm test
```

### CLI Usage

```bash
# Save OpenAI / Google / Anthropic API tokens in ~/.spl/credentials.json
node dist/cli.js login

# Type-check a file and its imports
node dist/cli.js check examples/01_basics.splx

# Compile and run immediately
node dist/cli.js run examples/06_prompts_and_schemas.splx

# Build standalone ES Modules (.mjs)
node dist/cli.js build examples/06_prompts_and_schemas.splx -o ./dist-spl

# Print the compile-time JSON Schema for any exported type
node dist/cli.js schema examples/06_prompts_and_schemas.splx SecurityAudit

# Start the JSON-RPC 2.0 Language Server (stdio)
node dist/cli.js lsp
```

### VS Code Extension

```bash
npm run vscode:install
# Uninstall later:
npm run vscode:uninstall
```

Reload VS Code (`Developer: Reload Window`) after installing.

---

## Standard Library

| Module | Runtime | Highlights |
|---|---|---|
| `std/llm` | Universal | `Prompt.ask<T>`, `Prompt.agent<T>`, `Prompt.llm_fn<In, Out>`, `ask_raw`, `agent_replay<T>`, `tool<Args, Out>` + `.any()`, `StreamDelta`, `Thinking`, `ToolChoice`, `Decision`, `decide` |
| `std/traces` | Universal / Server | Ordered `TraceEvent` enum, `ExecutionTrace`, JSONL `to_jsonl` / `from_jsonl` / `save_jsonl` / `load_jsonl` |
| `std/codegen` | Universal / VM | Sandboxed `js_fn<In, Out>`, `js_async_fn<In, Out>`, `js_eval<Out>`, `spl_fn<In, Out>`, and LLM-synthesized `llm_fn<In, Out>` |
| `std/collections` | Universal | Pure SPL `HashMap<K, V>`, self-balancing AVL `TreeSet<T>`, and immutable `List<T>` with lazy `.iter()` |
| `std/http` | Universal | `fetch`, `get`, `post_json` |
| `std/clock` & `std/crypto` | Universal | `now_ms`, `sleep`, `random_bytes`, `random_hex` |
| `std/console` | Universal | `log`, `warn`, `error` |
| `std/fs` | Server | `read`, `write`, `stat`, `list_dir`, `mkdir`, `remove`, `join_path`, `ext_name` |
| `std/proc` | Server | Cross-platform `shell(cmd)` and safe argv `exec(cmd, args, opts)` |
| `std/os` | Server | `env`, `args`, `cwd`, `platform`, `exit`, `print_line`, `write` |

---

## Documentation & Examples

- **Astro Documentation Site (`docs/`)**:
  ```bash
  npm run docs:dev    # Start local Astro Starlight docs server
  npm run docs:build  # Build static documentation site into docs/dist/
  ```
- **Language Specification**: see [SPEC.md](./SPEC.md)
- **Runnable Examples**: see [examples/README.md](./examples/README.md) (`examples/01_basics.splx` through `examples/12_files_and_shell.splx`)

---

## Project Layout

```text
src/            TypeScript compiler (lexer, Pratt parser, HM + row typechecker, schema/codec gen, JS codegen, CLI, LSP)
runtime/        Zero-dependency ESM runtime & private stdlib FFI kernels
stdlib/         SPL standard library modules (.splx)
examples/       12 runnable, test-verified language & stdlib examples
tests/          Compiler, runtime, LLM/traces/codegen, and LSP test suites
editors/vscode/ VS Code extension & TextMate grammar (splx.tmLanguage.json)
docs/           Astro + Starlight documentation website
```
