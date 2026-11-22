---
title: LLM & Agents (std/llm & std/traces)
description: Parameterized llm.ask<T>, multi-turn llm.agent<T>, typed tools, streaming StreamDelta, Decisions API, and deterministic replay.
---

`std/llm` provides a single strongly-typed, provider-agnostic facade across **OpenAI Responses** (`"openai_responses"` / `"openai-responses"`), **OpenAI Chat** (`"openai_chat"`), **Anthropic** (`"anthropic"`), and **Google Gemini** (`"google"`).

## 1. Single-Turn Structured Outputs (`llm.ask<T>`)

Because `llm.ask<T>` is a `reified fn`, SPL automatically generates and sends `type_schema<T>()` and validates/decodes the model's response into `T` (or returns plain text when `T = Str`):

```splx
import llm from "std/llm"
import os from "std/os"

'' Structured summary returned by the LLM.
type Summary = struct {
    headline: Str   '' One-sentence headline
    risk_score: Int '' Risk score from 1 (low) to 10 (high)
}

let api_key = os.env("OPENAI_API_KEY") ?? panic("Set OPENAI_API_KEY")

let summary = llm.ask<Summary>(
    provider: "openai_responses",
    api_key: api_key,
    model: "gpt-6-luna",
    thinking: Some(llm.ThinkLow)
) @{
    Summarize why strong static typing reduces AI agent tool-call failures.
}?

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

## 3. Multi-Turn Agents & Streaming (`llm.agent<T>` & `StreamDelta`)

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
let (answer, trace) = llm.agent<Str>(
    provider: "openai_responses",
    api_key: api_key,
    model: "gpt-6-luna",
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
) @{
    Inspect ./src/cli.ts and summarize all CLI subcommands.
}?
```

### Standard Parameters & Capabilities

`Thinking` (`ThinkOff`, `ThinkLow`, `ThinkMedium`, `ThinkHigh`, `ThinkMax`, `ThinkBudget(Int)`) and `ToolChoice` (`ToolAuto`, `ToolRequired`, `ToolNone`, `ToolForce(Str)`) are translated natively per provider and model family (including `reasoning: { effort, summary: "auto" }` on OpenAI Responses and `includeThoughts: true` on Gemini). Any unsupported parameter is gracefully adapted and recorded in `warnings`.

## 4. Traces & Deterministic Replay (`std/traces` & `llm.agent_replay<T>`)

Every `llm.agent<T>` run returns an `ExecutionTrace` with an ordered `events: Array<traces.TraceEvent>` (`UserPrompt`, `ThinkingStep`, `AssistantText`, `ToolCallStep`, `ToolDecisionStep`, `ToolResultStep`, `TurnCompleted`, `WarningStep`):

```splx
import traces from "std/traces"

// Save & reload as JSONL
traces.save_jsonl("trace.jsonl", trace)?
let loaded = traces.load_jsonl("trace.jsonl")?

// Deterministically replay up to step N (0 live calls if full) and continue live
let (replayed, replay_trace) = llm.agent_replay<Str>(
    trace: loaded,
    up_to_step: 4,
    provider: "openai_responses",
    api_key: api_key,
    model: "gpt-6-luna",
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

let resp = llm.decide(
    provider: "openai",
    api_key: api_key,
    model: "gpt-6-luna",
    questions: qs
) @{
    Customer message: My package arrived damaged and I want a refund.
}?
```
