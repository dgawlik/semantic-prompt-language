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

## Universal Reifiable Types & `typeof`

All generic functions in SPL are **automatically reifiable** — type parameters are never erased when inspected at runtime. You can use `typeof(expr)`, `typeof<T>()`, `type_schema<T>()`, and `decode<T>(json)` inside any generic function (whether or not you write the optional `reified` modifier, and even with inferred Hindley-Milner polymorphism):

```splx
pub enum Priority { Low, Normal, Urgent }

pub type Task = struct {
    id: Int            '' Unique numeric task ID
    title: Str         '' Short task summary
    priority: Priority '' Task priority
    assignee: Str?     '' Optional owner handle
}

// Works in ANY generic function — no `reified` keyword required!
pub fn describe<T>(x: T) -> Str {
    let info = typeof(x)
    "${info.name} (${info.kind}) = ${to_str(x)}"
}

pub fn parse_json<T>(raw: Str) -> Result<T, Str> {
    let parsed = json_parse(raw)?
    match decode<T>(parsed) {
        Ok(val) => Ok(val)
        Err(e) => Err("Decode error at " + e.path + ": " + e.message)
    }
}

// Type-level `typeof` derives static types from existing bindings
let default_cfg = { host: "localhost", port: 8080 }
type Config = typeof default_cfg
```

`typeof(expr)` and `typeof<T>()` return a first-class `TypeInfo` record with `.name`, `.kind`, `.spl_type`, `.schema`, `.doc`, `.hint`, `.underlying`, `.type_args`, `.fields`, `.variants`, `.params`, and `.return_type`.

## Nominal `newtype` Declarations

While `type Alias = Int` creates a transparent structural alias, `newtype` creates a **completely distinct nominal type** with zero runtime overhead:

```splx
pub newtype UserId = Int
pub newtype OrderId = Int

'' Validated customer email address
pub newtype Email = Str

pub newtype Point = struct {
    x: Int '' Horizontal coordinate
    y: Int '' Vertical coordinate
}

let uid = UserId(42)         // Construct via newtype constructor (or `42 as UserId`)
let raw = uid.value          // Unwrap via `.value` (or `uid as Int`)
let UserId(n) = uid          // Pattern match / destructure

let mut p = Point { x: 1, y: 2 } // Struct newtypes support transparent field access
p.x = p.x + 10

print(typeof(uid).name)      // "UserId" (distinct from Int and OrderId!)
print(typeof(uid) == typeof(OrderId(42))) // false
```

- `UserId` never unifies with `Int` or `OrderId`, preventing accidental mix-ups and enabling distinct `impl Trait for UserId` implementations and extension methods.
- `newtype` preserves its name and `''` LLM hint in `type_schema<T>()`, `decode<T>()`, and `typeof(...)`.
