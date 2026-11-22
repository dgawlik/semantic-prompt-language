---
title: Prompts, Schemas & Reified Types
description: First-class @{ ... } prompts, '' LLM hints, type_schema<T>(), decode<T>(), and reified fn<T>.
---

## First-Class `Prompt` Blocks (`@{ ... }`)

Prompt blocks evaluate to a first-class `Prompt` value (with `.text`, `.parts`, and `.render()`) and can be passed as a trailing argument outside parentheses to any function expecting a `Prompt`:

```splx
let target_file = "src/auth.splx"

let p: Prompt = @{
    Audit `${target_file}` for security bugs.
    Respond strictly as JSON matching:
    {"file": "${target_file}", "issue_count": 1}
}

print(p.render())
```

- **Auto-dedented**: common leading indentation is stripped at compile time.
- **Brace-balanced**: matched `{ ... }` pairs (such as JSON examples) require zero escaping; `${expr}` interpolates any typed SPL expression.
- **Zero ambiguity**: `{ ... }` is always SPL code (blocks, lambdas, records), while `@{ ... }` is always a `Prompt`.

## Compile-Time `type_schema<T>()` & `decode<T>(json)`

SPL derives full JSON Schemas and strict runtime validation codecs directly from static types at compile time:

```splx
/// Developer doc-comment (excluded from JSON Schema).
'' Security audit report returned by an LLM.
pub type SecurityAudit = struct {
    file: Str        '' Relative path of the audited file
    issue_count: Int '' Total findings (emits `"type": "integer"`)
    confidence: Float '' Score between 0.0 and 1.0 (emits `"type": "number"`)
    notes: Str?      '' Optional notes (omitted from JSON Schema `required`)
}

let schema: Json = type_schema<SecurityAudit>()

fn parse_audit(raw: Str) -> Result<SecurityAudit, Str> {
    let parsed = json_parse(raw)?
    match decode<SecurityAudit>(parsed) {
        Ok(audit) => Ok(audit)
        Err(e) => Err(e.path + ": " + e.message)
    }
}
```

## User-Defined Reifiable Generics (`reified fn`)

Regular generic functions erase their type parameters at runtime. Marking a function `reified fn` causes the compiler to inject runtime type descriptors (JSON Schema + decoder codec) at every call site — so `type_schema<T>()`, `decode<T>(json)`, compound types like `Array<T>` / `Envelope<Array<T>>`, and forwarding to `std/llm` or `std/codegen` all work generically!

```splx
pub type Envelope<T> = struct {
    ok: Bool '' Whether the request succeeded
    data: T  '' Typed payload
}

pub reified fn parse_json<T>(raw: Str) -> Result<T, Str> {
    let parsed = json_parse(raw)?
    match decode<T>(parsed) {
        Ok(val) => Ok(val)
        Err(e) => Err("Decode error at " + e.path + ": " + e.message)
    }
}

// Compound reified types compose automatically!
pub reified fn parse_batch<T>(raw: Str) -> Result<Array<T>, Str> {
    parse_json<Array<T>>(raw)
}

pub reified fn batch_schema<T>() -> Json {
    type_schema<Envelope<Array<T>>>()
}
```

Attempting to call `type_schema<T>()` or `decode<T>()` on an erased type parameter inside a non-`reified fn` produces a clear compile-time error.
