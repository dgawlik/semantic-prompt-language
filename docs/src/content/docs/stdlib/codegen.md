---
title: Dynamic Codegen (std/codegen)
description: Sandboxed typed JS/SPL compilation and LLM-synthesized functions with runtime decode<Out> validation.
---

`std/codegen` lets SPL programs compile and run JavaScript or SPL code dynamically at runtime with **compile-time input/output type contracts** and **automatic runtime validation** against `Out`'s reified codec.

Every function in `std/codegen` accepts either a string argument or a direct brace-balanced `@{ ... }` block.

## Sandboxed JS Functions (`js_fn`, `js_async_fn`, `js_eval`)

On Node/Bun/Deno, synchronous JS functions execute inside an isolated `node:vm` sandbox with configurable `timeout_ms`:

```splx
import codegen from "std/codegen"

type Pair = struct { a: Int, b: Int }
type Stats = struct { sum: Int, product: Int }

// Synchronous sandboxed JS receiving `input: Pair`, validated as `Stats`
let compute = codegen.js_fn<Pair, Stats> @{
    return { sum: input.a + input.b, product: input.a * input.b };
}?

let s = compute({ a: 6, b: 7 })? // { sum: 13, product: 42 }

// Async JS function participating in colorless async
let fetch_double = codegen.js_async_fn<Int, Int> @{
    return await Promise.resolve(input * 2);
}?

// Single-expression sandboxed JS evaluation
let total = codegen.js_eval<Int> @{
    [1, 2, 3, 4, 5].reduce((a, b) => a + b, 0)
}?
```

If the generated JS returns a value that does not match `Out` (or exceeds `timeout_ms`), calling the returned function yields `Err(...)` instead of corrupting typed SPL state.

## Runtime SPL Compilation (`spl_fn<In, Out>`)

Dynamically parse, type-check (against `fn(In) -> Out`), and compile `.splx` source code at runtime:

```splx
let spl_compute = codegen.spl_fn<Pair, Stats> @{
    pub fn run(p) {
        { sum: p.a + p.b, product: p.a * p.b }
    }
}?

let r = spl_compute({ a: 10, b: 20 })?
```

Type errors in the generated SPL source are caught by the SPL typechecker *before* execution.

## LLM-Synthesized Typed Functions (`Prompt.llm_fn<In, Out>`)

Synthesize a sandboxed JS function directly from a `@{ ... }` prompt specification plus the compile-time JSON Schemas and `''` hints of `In` and `Out`, with automatic syntax-error retries (exposed from `std/llm`):

```splx
import llm from "std/llm"

let normalize = @{
    Return the sum and product of input.a and input.b.
}.llm_fn<Pair, Stats>(
    provider: "openai_responses",
    api_key: api_key,
    model: "gpt-6-luna",
    max_retries: 2
)?

let out = normalize({ a: 9, b: 5 })?
```
