# Semantic Prompt Language (SPL)

General-purpose, agent-first programming language compiled to standard ES Module JavaScript (`.mjs`), targeting **Browser** and **Node / Bun / Deno**.

---

## Design Choices

1. **Strong static typing with type inference** (Hindley-Milner + row polymorphism).
2. **Functional, no OOP**: immutable `let` bindings by default with Rust-style local `let mut` rebinding; records, arrays, and dicts are immutable (copy-on-write).
3. **First-class functions & closures**: functions as values, Kotlin-style trailing lambda syntax (`list.map { i -> 2 * i }`), and expression-oriented blocks (last expression is the return value).
4. **Structural equivalence with row polymorphism**: Rust-like `enum`s and `struct`s, anonymous structural records `{ ... }`, open records (`..r`), hybrid dynamic records (`..extra: Dict<Str, V>`), and exhaustive `match` pattern matching.
5. **Built-in primitive types**: `Int`, `Float`, `Str`, `Bool`, `Char`, `Byte`, `Json`, `Array<T>`, `Dict<K, V>`, and `Prompt`.
6. **Tuples & named parameters**: `(a, b)` for extractable tuples, `[a, b]` for arrays; functions support named parameters (`agent(model: "gpt-6-luna", tokens: 1024)`) alongside first-class structural record arguments.
7. **No `null` or `undefined`**: absence is modeled with `Option<T>` (`Some(T) | None`), with `T?` type sugar and `?.` / `??` operators.
8. **Explicit error handling**: recoverable errors return `Result<T, E>` with Rust-style postfix `?` propagation.
9. **Transparent (colorless) async**: no `async`/`await` keywords; the compiler performs effect/async inference and lowers suspending functions to JS `async`/`await` automatically.
10. **Three comment layers (`//`, `///`, `''`)**:
    - `//` — regular code comments (stripped; ignored by docs and schemas).
    - `///` — Markdown **doc comments** (retained for IDE hover, completions, and docs; excluded from LLM schemas).
    - `''` — **LLM hints** (Markdown hints retained at compile time for `type_schema<T>()` JSON Schema `"description"` metadata).
11. **First-class `Prompt` blocks (`@{ ... }`)**: auto-dedented, brace-balanced template blocks with `${expr}` interpolation, passable as a trailing argument to any function.
12. **Lightweight traits & extension methods**: `trait` / `impl` for operator overloading (`Add`, `Ord`, `Show`, ...) and generic constraints, plus import-scoped extension methods on types.
13. **Minimal compiler builtins + private JS FFI**: only irreducible primitives and compile-time intrinsics live in the compiler; host I/O is bound via a stdlib-only JS FFI, and everything else is written in pure SPL.
14. **1 file = 1 module**: explicit `pub` exports and `import` statements, compiling to standard ESM (`.mjs`).

---

## Syntax & Core Semantics

### Comments, Doc-Comments & LLM Hints

SPL separates regular comments (`//`), developer doc-comments (`///`), and compile-time LLM schema hints (`''`). String literals use `"..."`, and `Char` literals use `'a'` (no ambiguity with `''` because an empty `Char` is invalid):

```spl
// Internal comment (ignored by IDE docs and LLM schemas)
/// Restaurant customer record used by booking & billing modules.
'' This is a user
'' of a restaurant
type Person = struct {
    /// Legal given name
    firstName: Str '' Starting with letter A
    lastName: Str  '' Ending with letter z
    age: Int       '' Greater than zero
}
```

### First-Class Prompt Blocks (`@{ ... }`)

Prompt blocks use `@{ ... }` and evaluate to a first-class `Prompt` value (carrying text segments, interpolated values, roles, and attached schemas). They can be passed as a normal trailing argument to any function:

```spl
let (response, trace) = agent(model: "gpt-6-luna", tokens: 1024) @{
    Analyze `${dir}` for vulnerabilities.
    List them as a JSON array of strings.
}?
```

- **Auto-dedented**: common leading indentation is stripped at compile time.
- **Brace-balanced**: inner matched `{ ... }` pairs (e.g., JSON examples inside prompts) are treated as literal prompt text without escaping; `${expr}` performs typed SPL interpolation.
- **No parser ambiguity**: `{ ... }` is always SPL code (blocks, trailing lambdas, or records), while `@{ ... }` is always a `Prompt` template.

### Trailing Lambdas, Tuples & Expression Returns

The last expression in any function or lambda body is its return value. When a function's final parameter is a lambda, it may be written outside the parentheses:

```spl
let doubled = list.map { i ->
    2 * i
}

let (head, tail) = split_first(doubled)?
```

### Bindings, Nullability, Errors & Colorless Async

- **Bindings**: `let x = 1` is immutable; `let mut count = 0` allows local rebinding within its lexical scope while keeping compound values immutable.
- **Nullability**: `T?` is sugar for `Option<T>`. Use `match`, `?.`, and `??` to handle missing values safely.
- **Errors**: Functions that can fail return `Result<T, E>`; postfix `?` unwraps `Ok(v)` or early-returns `Err(e)`.
- **Operator Precedence** (highest to lowest):
  1. Postfix: `.`, `?.`, `[]`, `()`, `@{ ... }`, `?` (left)
  2. Exponentiation: `**` (right; `-2 ** 2` = `-(2 ** 2)`, `2 ** -3` = `2 ** (-3)`)
  3. Prefix unary: `-`, `!`, `~` (right)
  4. Type conversion: `expr as Type` (left; supports numeric/Byte/Char/Bool/Str/Bytes/Json and `Iter<T>` ↔ `Array<T>` conversions, binding tighter than `??`, arithmetic, and bitwise ops)
  5. Null coalescing: `??` (right; binds tighter than arithmetic & comparisons so `arr.get(i) ?? 0 - 1` = `(arr.get(i) ?? 0) - 1` and `arr.get(j) ?? 0 <= pivot` = `(arr.get(j) ?? 0) <= pivot`)
  5. Multiplicative: `*`, `/`, `%` (left)
  6. Additive: `+`, `-` (left)
  7. Bitwise shift: `<<`, `>>` (left)
  8. Bitwise AND: `&` (left)
  9. Bitwise XOR: `^` (left)
  10. Bitwise OR: `|` (left; bitwise ops bind tighter than comparisons so `x & 1 == 0` = `(x & 1) == 0`)
  11. Relational: `<`, `<=`, `>`, `>=` (left)
  12. Equality: `==`, `!=` (left)
  13. Logical AND: `&&` (left)
  14. Logical OR: `||` (left)
  15. Ranges: `..`, `..=` with optional `..step` (non-associative)
- **Transparent Async**: Any function that transitively calls a suspending primitive (`http.fetch`, `fs.read`, `clock.sleep`, etc.) is inferred as async by the compiler and emitted as a JS `async function` with `await` inserted at call sites.
  - Collection combinators like `list.map { item -> agent(...) }` execute **sequentially by default** so agents do not accidentally spawn unbounded concurrent calls.
  - Explicit concurrency is opt-in via `list.par_map { ... }`, `async.all(...)`, and `async.race(...)`.

---

## Types, Objects, Traits & Pattern Matching

SPL combines structural typing with **row polymorphism** so ad-hoc and extensible objects feel as lightweight as JavaScript while preserving full static type safety and IDE property completion.

### 1. Structs & Anonymous Structural Records

- **Named `struct`**: closed record type by default; retains `///` Markdown doc-comments for IDE tooling and `''` LLM hints for `type_schema<T>()` at the type call site (runtime values remain plain JS objects with zero metadata overhead).
- **Anonymous records (`{ ... }`)**: can be created without declaring a `struct` first; the compiler infers the exact field set and types, giving full property completion.
- **Functional spread (`{ ...obj, field: val }`)**: extends or updates records immutably (compiled to JS object spread) while statically computing the resulting type and preserving completion.

```spl
let user = { firstName: "Ada", age: 30 }
// inferred: { firstName: Str, age: Int }

let admin = { ...user, role: "admin" }
// inferred: { firstName: Str, age: Int, role: Str }
```

Because SPL uses **structural equivalence**, an anonymous record matching `Person`'s fields is compatible with `Person`.

### 2. Row Polymorphism (`..r`)

Functions can require a subset of fields without losing type information about extra properties:

```spl
fn greet(x: { firstName: Str, .. }) -> Str {
    "Hi " + x.firstName
}

// Inferred: fn({ ..r }) -> { ts: Int, ..r }
fn withTimestamp(x) {
    { ...x, ts: clock.now_ms() }
}

let tagged = withTimestamp(user)
// inferred: { firstName: Str, age: Int, ts: Int }
```

### 3. Hybrid Open Records (`..extra: Dict<Str, V>`)

For objects with both statically known fields and arbitrary runtime-dynamic keys (e.g., JSON payloads, headers, LLM tool metadata):

```spl
type ToolEvent = struct {
    id: Str   '' Unique event id
    kind: Str '' Event category
    ..extra: Dict<Str, Json> '' Any additional runtime keys
}
```

- **Dot access (`ev.id`)**: only for statically known fields; gives IDE property completion and compile-time typo checking.
- **Index access (`ev["foo"]` / `ev.extra["foo"]`)**: for dynamic runtime keys; returns `Option<V>` (`V?`) so missing keys must be handled safely.

### 4. Enums (ADTs) & Pattern Matching

Rust-style tagged enums (`enum`) and exhaustive `match` expressions work uniformly across enums, structs, tuples, anonymous records, and open objects (`..`):

```spl
enum ToolResult {
    Ok(Json)
    Err(Str)
}

match event {
    { kind: "call", name, args, .. } => run_tool(name, args)
    { kind: "done", result, .. }     => Ok(result)
    _                                => Err("unknown event")
}
```

### 5. Traits & Extension Methods

- **Extension methods**: scoped by module `import` and resolved on structurally matching shapes (e.g., an extension on `{ firstName: Str, lastName: Str, .. }` works on `Person` and any matching anonymous record). Methods that mutate receiver fields in place declare `mut self` (e.g., `fn Stack<T>.push(mut self, item: T)`), requiring a mutable binding (`let mut` or `mut self`) at call sites; field (`obj.field = val`) and array index (`arr[i] = val`) assignment are supported statements.
- **Lightweight traits**: `trait Show`, `trait Ord`, `trait Add`, etc. power operator overloading and generic bounds (`fn max<T: Ord>(a: T, b: T) -> T`).
  - **Coherence under structural equivalence**: trait implementations on records are checked per structural shape (overlapping impls for identical shapes in the same scope are a compile error). When distinct trait behavior is needed for the same underlying shape, wrap it in a nominal single-variant `enum` (`newtype`).

### 6. Mapping to `type_schema<T>()`

- `''` LLM hints on types, fields, and enum variants emit JSON Schema `"description"` metadata (resolved from the static type `T` at the call site). `//` comments and `///` doc-comments are excluded from generated LLM schemas to save tokens.
- `Int` emits `"integer"`; `Float` emits `"number"`.
- `Option<T>` (`T?`) marks a field optional / nullable in the schema.
- Closed `struct { ... }` emits `"additionalProperties": false`.
- Open `struct { ..., ..extra: Dict<Str, V> }` emits `"additionalProperties": <schema of V>`.

---

## Modules & Compilation Target

- **File extension**: `.splx`
- **1 file = 1 module**: declarations are module-private by default and exported with `pub`.
- **Output**: standard ES Modules (`.mjs`) targeting **Browser** and **Node 22+ / Bun / Deno**.
- **Runtime split**: universal stdlib modules (`http`, `clock`, `crypto`, `console`) work in both Browser and server runtimes; server-only I/O modules (`fs`, `proc`, `os`) target Node/Bun/Deno.

---

## Builtins & JavaScript Boundary

SPL keeps its compiler and runtime surface minimal by using a **private JS FFI** (e.g., `extern` / `@js` bindings restricted to the standard library). Only irreducible language primitives and compile-time intrinsics live in the compiler; all host/I/O capabilities are thin typed FFI wrappers in the stdlib kernel, and everything else is written in pure SPL.

### 1. Core Compiler Primitives (Lowered Directly to JS)

- **Numbers (`Int`, `Float`)**: arithmetic (`+`, `-`, `*`, `/`, `%`, `**`), comparisons, bitwise ops, `Int`/`Float` conversions, and core `Math` ops (`floor`, `ceil`, `round`, `sqrt`, `abs`, `log`, `exp`, `isFinite`).
- **Booleans (`Bool`)**: short-circuiting `&&`, `||`, `!`.
- **Strings (`Str`) & `Char`**: `len`, `slice`, `concat`, `indexOf`, `codePointAt`, `fromCodePoint`, and JS `RegExp` (`match`, `test`, `replace`).
- **Bytes (`Byte` / `Uint8Array`)**: `len`, `get`, `slice`, `concat`, `toUtf8`, `fromUtf8`.
- **Array (`Array<T>`), Ranges & Iterators (`Iter<T>`)**: mutable dynamic arrays (`len`, `get`, `set`, `push`, `pop`, `swap`, `clear`, `slice`, `concat`, `iter()`), `iter_from_fn`, first-class ranges (`start..end`, `start..end..step`, inclusive `start..=end`, `start..=end..step` as `Iter<Int>`), lazy pull combinators (`next`, `map`, `filter`, `flat_map`, `take`, `skip`, `enumerate`, `zip`, `chain`, `collect`, `fold`, `for_each`, `find`, `any`, `all`, `count`), `for pat in iterable { ... }` loops over `Array`, `Dict`, `Iter`, ranges, `Str`, and any type providing `.iter() -> Iter<T>` (including `List`, `TreeSet`, `HashMap`).
- **Dict (`Dict<K, V>`)**: opaque JS `Map` backing (`empty`, `get`, `set`, `delete`, `entries`).
- **Records, Tuples & ADTs**: compiled directly to plain/tagged JS objects, JS arrays (for tuples), and `switch` pattern matching, with a tiny structural equality helper (`eq`).
- **Prompt (`Prompt`)**: compiled representation of `@{ ... }` template parts and interpolated values.
- **JSON (`Json`)**: `json_parse`, `json_stringify`.
- **Async & Control Flow**: transparent async lowering to JS `async`/`await` + `Promise.all` / `Promise.race`, `panic(msg)`, and compiler-lowered self-tail-call optimization (`while` loops) since JS engines lack TCO.

### 2. Compile-Time Type Intrinsics

Compiler-generated metadata derived from static types (impossible to write cleanly in pure stdlib without runtime reflection):

- **`type_schema<T>()`**: emits a JSON Schema descriptor for any static type `T` (records, ADTs, primitives, arrays, including `//` doc-comments).
- **`decode<T>(json)`**: type-safe runtime validation/decoding of parsed `Json` into `Result<T, DecodeError>`.

These enable structured LLM outputs, tool/function definitions, and validated HTTP responses with zero boilerplate.

### 3. Minimal Stdlib FFI Kernel (Host & I/O)

Bound via the private JS FFI; all higher-level utilities are implemented in pure SPL on top of these primitives:

| Module | Runtime | Minimal FFI Primitives | Pure SPL Stdlib Layer |
|---|---|---|---|
| **`http`** (`fetch`) | Universal | `fetch({ method, url, headers, body }) -> Result<Response, Error>` | Retries, query builders, JSON codecs, auth helpers, LLM API clients |
| **`clock` & `crypto`** | Universal | `now_ms()`, `sleep(ms)`, `random_bytes(n)` | ISO dates, durations, UUIDs, backoff timers, seeded PRNG |
| **`console`** | Universal | `log`, `warn`, `error` | Structured logging, formatting |
| **`llm`** | Universal | `raw_turn` (OpenAI Responses/Chat, Anthropic, Google Gemini) + `raw_decide` (OpenAI `/v1/decisions` & Google `/v1beta/decisions`) | `Prompt` extension methods (`Prompt.ask<T>`, `Prompt.agent<T>`, `Prompt.llm_fn<In, Out>`), parameterized `llm.ask<T>`, `llm.agent<T>`, `llm.llm_fn<In, Out>`, `llm.agent_replay<T>` (deterministic replay up to step N + live continuation), and `llm.AgentTool<Args, Out>` / `llm.tool<Args, Out>`, `llm.ask_raw`, closed-set `llm.decide` (`predicate`/`choice`/`score`), standard parameter translation & streaming `on_delta` |
| **`traces`** | Universal / Server (`save_jsonl` / `load_jsonl`) | Pure SPL on `std/fs` + `json` | Ordered `TraceEvent` enum (`UserPrompt`, `ThinkingStep`, `AssistantText`, `ToolCallStep`, `ToolDecisionStep`, `ToolResultStep`, `TurnCompleted`, `WarningStep`), `ExecutionTrace`, and JSONL serialization (`to_jsonl`, `from_jsonl`, `save_jsonl`, `load_jsonl`) |
| **`codegen`** | Universal / VM | `reified` `js_fn<In, Out>`, `js_async_fn<In, Out>`, `js_eval<Out>`, `spl_fn<In, Out>` | Typed dynamic JS/SPL codegen + LLM-synthesized `llm_fn<In, Out>` (generating sandboxed JS from description + `In`/`Out` schemas with compile-time signature checking & runtime `decode<Out>` validation) |
| **`fs`** (`file`) | Server | `read`, `write`, `stat`, `list_dir`, `mkdir`, `remove` | Path joining/normalization, globs, recursive walk, atomic writes, JSON/CSV file helpers |
| **`proc`** (`shell`) | Server | `exec(cmd, args, { cwd, env, stdin, timeout }) -> Result<{ code, stdout, stderr }, Error>` | `shell(str)` helper (via `sh -c` / `cmd`), pipelines, escaping |
| **`os`** | Server | `env(key)`, `args()`, `cwd()`, `platform()`, `exit(code)`, `stdio` (`print` / `read_line`) | CLI flag parsing, ANSI formatting |

### 4. Pure Standard Library

Built entirely in SPL on top of sections 1–3:

- `Option<T>`, `Result<T, E>` (ADTs) and core traits (`Show`, `Ord`, `Eq`, `Add`, ...)
- Immutable collections (`std/collections`): `HashMap<K, V>`, self-balancing AVL `TreeSet<T>`, and `List<T>` implemented as types + extension methods
- Collection combinators (sequential `map`, `filter`, `flatMap`, `zip`, `sort`, `groupBy`, plus concurrent `par_map` / `async.all`)
- String utilities (`trim`, `split`, `startsWith`, `pad`, formatting)
- Path, URL, CLI parsing, logging, and testing utilities
- Prompt builders, LLM provider clients, tool registries, and agent loops (built on `Prompt`, `http.fetch`, `json`, `type_schema<T>()`, and `decode<T>()`)
