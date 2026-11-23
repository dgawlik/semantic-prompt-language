---
title: LLM & Agents (std/llm & std/traces)
description: Prompt extension methods (Prompt.ask<T>, Prompt.agent<T>, Prompt.llm_fn<In, Out>), typed tools, streaming StreamDelta, Decisions API, and deterministic replay.
---

`std/llm` provides a single strongly-typed, provider-agnostic facade across **OpenAI Responses** (`"openai_responses"` / `"openai-responses"`), **OpenAI Chat** (`"openai_chat"`), **Anthropic** (`"anthropic"`), and **Google Gemini** (`"google"`), exposing reified extension methods directly on `Prompt` (`@{ ... }.ask<T>(...)`, `@{ ... }.agent<T>(...)`, and `@{ ... }.llm_fn<In, Out>(...)`).

### Defaults & Authentication (`spl login`)

All `std/llm` calls default to `provider: "openai_responses"` and `model: "gpt-6-luna"`, and `api_key` is optional. When `api_key` is omitted, SPL automatically resolves credentials in order:
1. Provider environment variables (`OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`).
2. Saved tokens in `~/.spl/credentials.json` (configured via `spl login`, `spl login openai`, or `spl login --from-env`).
3. In the web playground, the server-side `/api/llm/*` proxy backed by Vercel Environment Variables.

## 1. Single-Turn Structured Outputs (`Prompt.ask<T>`)

Because `Prompt.ask<T>` is a `reified` extension method, SPL automatically generates and sends `type_schema<T>()` and validates/decodes the model's response into `T` (or returns plain text when `T = Str`):

```splx
import llm from "std/llm"

'' Structured summary returned by the LLM.
type Summary = struct {
    headline: Str   '' One-sentence headline
    risk_score: Int '' Risk score from 1 (low) to 10 (high)
}

let summary = @{
    Summarize why strong static typing reduces AI agent tool-call failures.
}.ask<Summary>(thinking: Some(llm.ThinkLow))?

print("${summary.headline} (risk=${summary.risk_score})")
```

Use `llm.ask_raw(...)` when you want the full `LlmResponse` (`text`, `thinking`, `tool_calls`, `blocks`, `usage`, `warnings`, `raw`).

## 2. Strongly-Typed Tools (`llm.tool<Args, Out>`)

`llm.tool<Args, Out>` derives the tool's JSON Schema from `Args`, validates incoming tool arguments into `Args`, and serializes `Out` back to the model:

```splx
import fs from "std/fs"

type FilePath = Str '' Path to a file

let read_file = llm.tool<FilePath, Str>(
    name: "read_file",
    description: "Reads the UTF-8 contents of a file"
) { path ->
    fs.read(path)
}
```

When combining tools with different `<Args, Out>` types in one `tools: [...]` array, call `.any()` on each tool to erase them into `llm.AnyTool`:

```splx
tools: [read_file.any(), list_files.any()]
```

## 3. Multi-Turn Agents & Streaming (`Prompt.agent<T>` & `StreamDelta`)

Passing `on_delta: Some(...)` automatically enables SSE streaming. `StreamDelta` is a tagged enum so you can exhaustively `match` on text, raw thinking, reasoning summaries, tool call chunks, and turn completion:

```splx
pub enum StreamDelta {
    TextDelta(Str)
    ThinkingDelta(Str)
    SummaryDelta(Str)
    ToolCallDelta(Str, Str, Str) // (tool_name, tool_call_id, args_delta)
    DoneDelta
}
```

```splx
let (answer, trace) = @{
    Inspect ./src/cli.ts and summarize all CLI subcommands.
}.agent<Str>(
    thinking: Some(llm.ThinkLow),
    tools: [read_file.any()],
    on_delta: Some({ delta ->
        match delta {
            llm.SummaryDelta(s) => print_inline(s)
            llm.ThinkingDelta(t) => print_inline(t)
            llm.TextDelta(t) => print_inline(t)
            llm.ToolCallDelta(_, _, _) => ()
            llm.DoneDelta => print("")
        }
    }),
    on_decision: Some({ req ->
        if req.tool_call.name == "read_file" { llm.Approve }
        else { llm.Reject("Tool not permitted") }
    })
)?
```

### Standard Parameters & Capabilities

`Thinking` (`ThinkOff`, `ThinkLow`, `ThinkMedium`, `ThinkHigh`, `ThinkMax`, `ThinkBudget(Int)`) and `ToolChoice` (`ToolAuto`, `ToolRequired`, `ToolNone`, `ToolForce(Str)`) are translated natively per provider and model family (including `reasoning: { effort, summary: "auto" }` on OpenAI Responses and `includeThoughts: true` on Gemini). Any unsupported parameter is gracefully adapted and recorded in `warnings`.

## 4. Traces & Deterministic Replay (`std/traces` & `llm.agent_replay<T>`)

Every `Prompt.agent<T>` run returns an `ExecutionTrace` with an ordered `events: Array<traces.TraceEvent>` (`UserPrompt`, `ThinkingStep`, `AssistantText`, `ToolCallStep`, `ToolDecisionStep`, `ToolResultStep`, `TurnCompleted`, `WarningStep`):

```splx
import traces from "std/traces"

// Save & reload as JSONL
traces.save_jsonl("trace.jsonl", trace)?
let loaded = traces.load_jsonl("trace.jsonl")?

// Deterministically replay up to step N (0 live calls if full) and continue live
let (replayed, replay_trace) = llm.agent_replay<Str>(
    trace: loaded,
    up_to_step: 4,
    tools: [read_file.any()]
)?
```

## 5. Closed-Set Decisions API (`llm.decide`)

Evaluate calibrated binary predicates, multiple-choice questions, and rubric scores via OpenAI `/v1/decisions` or Google `/v1beta/decisions`:

```splx
let qs = [
    llm.predicate("needs_refund", "Is the customer requesting a refund?"),
    llm.choice("team", "Which team should handle this?", [
        ("billing", Some("Payments or invoices")),
        ("shipping", Some("Delivery issues")),
        ("other", None)
    ]),
    llm.score("urgency", "Rate urgency from 0 to 2", ["low", "medium", "high"])
]

let resp = llm.decide(questions: qs) @{
    Customer message: My package arrived damaged and I want a refund.
}?
```

## 6. LLM-Synthesized Typed Functions (`Prompt.llm_fn<In, Out>`)

Synthesize a strongly-typed, sandboxed JS function directly from a `@{ ... }` prompt specification plus the compile-time JSON Schemas of `In` and `Out` (with automatic syntax-error retries and runtime `Out` validation):

```splx
import llm from "std/llm"

let sieve = @{
    Create sieve of Eratosthenes function sieve(n: Int) -> Array<Int>
}.llm_fn<Int, Array<Int>>()?

print(sieve(1000))
```

`Prompt.llm_fn<In, Out>` returns `Result<fn(In) -> Result<Out, Str>, Str>` — unwrap the outer `Result` with `?` to get a typed callable `fn(In) -> Result<Out, Str>`. See [Dynamic Codegen (`std/codegen`)](/stdlib/codegen/) or run it live in the [Playground](/playground/?example=live-llm-fn).

## 7. Interactive Step Debugging (`spl debug`)

Step through any SPL program's LLM calls (`Prompt.ask<T>`, `Prompt.agent<T>`, `Prompt.llm_fn<In, Out>`, `llm.ask_raw`, `llm.decide`) in a split-pane terminal debugger with scrollable pretty-printed results, live request/response JSON editing, mock response injection, and `.jsonl` trace export:

```bash
# Interactive step-through debugger (scroll results with ↑/↓, PgDn, or mouse wheel)
node dist/cli.js debug examples/agents/agent.splx

# Only pause after responses, or run non-interactively and save a trace
node dist/cli.js debug examples/agents/agent.splx --after-only
node dist/cli.js debug examples/agents/agent.splx --no-pause --save debug.jsonl
```

See [CLI & LSP / VS Code](/tooling/cli-and-lsp/#interactive-llm-step-debugger-spl-debug) for all debugger shortcuts and flags.
