---
title: Prompts, Schemas & Reified Types
description: First-class @{ ... } prompts, '' LLM hints, type_schema<T>(), decode<T>(), universal reified generics, typeof, and nominal newtype.
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

## Universal Reified Types

All generic functions in SPL are **universally reifiable** — type parameters are never erased when inspected at runtime. Whenever a function uses `typeof(expr)`, `typeof<T>()`, `type_schema<T>()`, `decode<T>(json)`, or forwards a type parameter into `std/llm` / `std/codegen`, the compiler automatically passes the resolved compile-time `TypeInfo` descriptor at every call site:

- **No `reified` keyword required**: works in any plain `fn foo<T>(...)` (the optional `reified fn` modifier is still accepted for explicit documentation).
- **Works with implicit Hindley-Milner polymorphism**: even functions without an explicit `<T>` parameter list (such as `fn inspect_kind(x)`) automatically reify when they call `typeof(x)`.
- **Works across higher-order calls & compound types**: passing a reified function to combinators like `[1, 2].map(describe)` and inspecting compound types like `typeof<Array<T>>()`, `typeof<Box<T>>()`, or `typeof<T?>()` all resolve accurately at runtime.

```splx
pub enum Priority { Low, Normal, Urgent }

pub type Task = struct {
    id: Int            '' Unique numeric task ID
    title: Str         '' Short task summary
    priority: Priority '' Task priority
    assignee: Str?     '' Optional owner handle
}

// Works in ANY generic function — no `reified` keyword required!
pub fn describe<T>(val: T) -> Str {
    let info = typeof(val)
    "${info.name} [${info.kind}] = ${to_str(val)}"
}

// Generic JSON parser using universal reification for decode<T> and typeof<T>
pub fn parse_json<T>(raw: Str) -> Result<T, Str> {
    let parsed = json_parse(raw)?
    match decode<T>(parsed) {
        Ok(val) => Ok(val)
        Err(e) => Err("Invalid ${typeof<T>().name} at '${e.path}': ${e.message}")
    }
}

// Higher-order use: automatically supplies TypeInfo for `Int`
print([1, 2].map(describe)) // ["Int [primitive] = 1", "Int [primitive] = 2"]
```

## Type-Level & Runtime `typeof` (`TypeInfo`)

`typeof` works in **two positions**:

1. **Type position (`typeof expr`)**: extracts the static type of an existing value at compile time — useful for deriving config aliases or parameter types without duplicating struct definitions:
   ```splx
   let default_cfg = { host: "localhost", port: 8080, strict: true }
   type Config = typeof default_cfg

   fn format_endpoint(c: typeof default_cfg) -> Str {
       "${c.host}:${c.port}"
   }
   ```
2. **Value position (`typeof(expr)` or `typeof<T>()`)**: returns a first-class runtime `TypeInfo` record with full structural, nominal, and schema metadata:

| `TypeInfo` Field | Type | Description |
|---|---|---|
| `name` | `Str` | Short display name (e.g. `"UserId"`, `"Point"`, `"Array<UserId>"`) |
| `kind` | `Str` | Category (`"primitive"`, `"struct"`, `"record"`, `"enum"`, `"newtype"`, `"array"`, `"tuple"`, `"option"`, `"result"`, `"dict"`, `"function"`, …) |
| `spl_type` | `Str` | Canonical SPL type signature |
| `schema` | `Json` | Compile-time JSON Schema (including `''` LLM hints) |
| `doc` / `hint` | `Str?` | Attached `///` doc-comment and `''` LLM schema hint |
| `underlying` | `Str?` | Underlying type name when `kind == "newtype"` |
| `type_args` | `Array<TypeInfo>` | Reified type arguments for generic/compound types |
| `fields` | `Array<FieldInfo>` | Struct/record fields (`name`, `type_name`, `optional`, `doc`, `hint`) |
| `variants` | `Array<VariantInfo>` | Enum variants and payload types |
| `params` / `return_type` | `Array<TypeInfo>` / `TypeInfo?` | Parameter and return types for function types |

## Nominal `newtype` Declarations & Complete Example

While `type Alias = Int` creates a transparent structural alias, `newtype` creates a **completely distinct nominal type** with zero runtime wrapper overhead:

- `UserId` never unifies with `Int` or `OrderId`, preventing accidental mix-ups and enabling distinct `impl Trait` blocks and extension methods.
- Construct via `UserId(42)` or `42 as UserId`, unwrap via `.value`, `uid as Int`, or pattern matching (`let UserId(raw) = uid`).
- Struct-backed newtypes (`newtype Point = struct { ... }`) support transparent field access and mutation (`pt.x = pt.x + 5`).
- `newtype` preserves its nominal name and `''` LLM hint in `type_schema<T>()`, `decode<T>()`, and `typeof(...)`.

Here is the complete runnable example from [`examples/13_typeof_and_newtype.splx`](https://github.com/dgawlik/semantic-prompt-language/blob/main/examples/13_typeof_and_newtype.splx) — try it live in the [Playground](/playground/?example=typeof-newtype):

```splx
// 1. Nominal `newtype` declarations (zero runtime overhead)
pub newtype UserId = Int
pub newtype OrderId = Int

'' Validated customer email address
pub newtype Email = Str

// Struct-backed newtype with transparent field access & mutation
pub newtype Point = struct {
    x: Int '' Horizontal coordinate
    y: Int '' Vertical coordinate
}

pub newtype Box<T> = struct { item: T }

impl Show for UserId {
    fn show(self) -> Str { "User#" + to_str(self.value) }
}

impl Show for OrderId {
    fn show(self) -> Str { "Order#" + to_str(self.value) }
}

fn UserId.is_admin(self) -> Bool { self.value == 0 }

// 2. Type-level `typeof`
let default_cfg = { host: "localhost", port: 8080, strict: true }
type Config = typeof default_cfg

// 3. Universal auto-reification (explicit `<T>` and implicit HM polymorphism)
fn describe<T>(val: T) -> Str {
    let info = typeof(val)
    "${info.name} [${info.kind}] = ${to_str(val)}"
}

fn inspect_kind(x) -> Str {
    let info = typeof(x)
    match info.underlying {
        Some(u) => "${info.name} (newtype over ${u})"
        None => "${info.name} (${info.kind})"
    }
}

fn compound_names<T>() -> Str {
    "${typeof<Array<T>>().name}, ${typeof<Box<T>>().name}, ${typeof<T?>().name}"
}

let uid = UserId(42)
let oid = OrderId(42)
let UserId(raw_id) = uid

let mut pt = Point { x: 10, y: 20 }
pt.x = pt.x + 5

print(uid.show() + " vs " + oid.show())             // User#42 vs Order#42
print("Point(${pt.x}, ${pt.y})")                    // Point(15, 20)
print(typeof(uid) == typeof(oid))                   // false
print(inspect_kind(uid))                            // UserId (newtype over Int)
print(compound_names<UserId>())                     // Array<UserId>, Box<UserId>, UserId?
print(typeof<Point>().fields.map { f -> f.name })   // ["x", "y"]
print(json_stringify(typeof<Email>().schema))       // {"type":"string","description":"Validated customer email address"}
```
