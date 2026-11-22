---
title: Quick Tour
description: A 5-minute walkthrough of SPL syntax, types, prompts, and agents.
---

SPL (`.splx`) combines ML-style type inference and Rust-style safety with ergonomic scripting for AI agents and web/server runtimes.

## 1. Bindings, Records & Row Polymorphism

Bindings are immutable by default (`let`); local rebinding uses `let mut`. Records are structural — you can create them without declaring a type upfront and extend them with spread:

```splx
let user = { firstName: "Ada", age: 36 }

// Row-polymorphic: accepts any record with `firstName: Str`
fn greet(x: { firstName: Str, .. }) -> Str {
    "Hello, " + x.firstName + "!"
}

// Preserves all extra fields on `x`
fn with_role(x, role: Str) {
    { ...x, role: role }
}

let admin = with_role(user, "architect")
print(greet(admin) + " (" + admin.role + ")")
```

## 2. Safe Nullability & Errors

There is no `null` or `undefined`. Optional values use `Option<T>` (`T?`), and fallible operations return `Result<T, E>`:

```splx
import fs from "std/fs"

fn read_first_line(path: Str) -> Result<Str, Str> {
    let text = fs.read(path)?
    let first = text.split("\n").get(0) ?? "<empty>"
    Ok(first)
}
```

- `?.` safely chains property access through `Option<T>`
- `??` unwraps `Some(v)` / `Ok(v)` or lazily evaluates a fallback
- `?` unwraps `Ok(v)` / `Some(v)` or early-returns `Err(e)` / `None`

## 3. Prompts & Compile-Time Schemas

Attach `''` LLM hints to fields, pass `@{ ... }` prompt blocks as trailing arguments, and derive JSON Schemas with zero runtime reflection:

```splx
'' Security finding returned by an automated reviewer.
type Finding = struct {
    file: Str      '' Relative file path
    severity: Str  '' Low, Medium, or High
    summary: Str   '' Concise explanation of the issue
}

let schema = type_schema<Finding>()
print(json_stringify(schema))
```

## 4. Typed Multi-Turn Agents

Define strongly-typed tools with `llm.tool<Args, Out>` and pass them to `llm.agent<T>`:

```splx
import llm from "std/llm"
import fs from "std/fs"
import os from "std/os"

type FilePath = Str '' Relative file path to inspect

let read_file = llm.tool<FilePath, Str>(
    name: "read_file",
    description: "Reads a UTF-8 file from disk"
) { path ->
    fs.read(path)
}

let api_key = os.env("OPENAI_API_KEY") ?? panic("Set OPENAI_API_KEY")

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
            _ => ()
        }
    })
) @{
    Read package.json and summarize its scripts.
}?

print("\nTurns: " + to_str(trace.turns))
print(answer)
```

Continue to the [Language Guide](/language/basics/) for full details on every feature.
