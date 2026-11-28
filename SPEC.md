# Semantic Prompt Language (SPL) v5 Specification

> **Status:** Normative Engineering Specification (v5.0)
> **Keywords:** The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHALL`, `SHALL NOT`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

---

## 1. Scope, Architecture, and Reproducibility

SPL v5 turns natural-language instructions into a minimal, statically typed Context-Free Language (CFL) via OpenAI Lark CFG constrained decoding, compiles the resulting AST against a host-supplied Signature Catalog into compact, human-readable canonical UTF-8 textual stack bytecode (`SPLB 5`), and executes that bytecode on a deterministic stack VM.

**Core invariants:**
1. **The VM owns control flow.** Branching, looping, function calls, state updates, and error handling are executed exclusively by the VM.
2. **Models are stateless leaf effects.** A model call (`model.ask` or `model.decide`) is an explicit effect for generation or judgment. Its output is untrusted data validated at the effect boundary—never executable code, dynamic control flow, or ambient authority.
3. **Clean break (v5).** SPL v5 is a clean break from earlier SPL versions. It provides checked 64-bit integer arithmetic and bitwise operations, finite 64-bit floating-point arithmetic, boolean logic, UTF-8 strings and template strings, typed bindings, nullability checks, structural records, lists, maps, literal string unions, durable transactional state, `if`/`else`, `switch`, `while`, array `for`, top-level named functions, `try`/`catch`, leaf model generation and logprob/classifier-backed decisions, web search/fetch, shell profiles, virtual-root file I/O, and host-registered JS and MCP tools.
4. **Reference runtime independence.** The Node.js reference implementation uses the official OpenAI SDK (`openai`). SDK defaults (retries, timeouts, temperature, schema flags, response storage, etc.) MUST NOT define language behavior; every parameter affecting semantics MUST be specified explicitly by this spec or the host catalog/profile.

### 1.1 Pipeline and Reproducibility Contract

```text
Natural-language prose
   │  [Non-deterministic: OpenAI Lark CFG decoding + bounded compile-repair loop]
   ▼
SPL v5 Source ──► Deterministic Parser ──► Typed AST (+ Signature Catalog)
   │  ═══════════════════════ DETERMINISM BOUNDARY ═══════════════════════
   │  [Deterministic compiler]
   ▼
Canonical UTF-8 Textual Stack Bytecode (SPLB 5)
   │  [Deterministic VM]
   ▼
Result + Atomic Durable State Commit + Logical Execution Trace
```

- **Translation (outside determinism guarantee):** Converting prose to SPL source/AST—including Lark-constrained decoding and any compile-repair retries—MAY be non-deterministic.
- **Bytecode determinism:** For a fixed parsed SPL v5 AST and a fixed canonical Signature Catalog, compilation MUST produce **byte-identical** UTF-8 textual bytecode.
- **Canonicality:** Canonical encoding means exactly one encoding per language primitive and AST shape. The compiler MUST NOT perform algebraic equivalence rewrites (e.g., `x + 1` is never rewritten into `1 + x`).
- **Execution determinism:** Given identical bytecode, identical canonical inputs, identical initial durable state snapshot, identical logical limits, and an identical ordered sequence of normalized effect outcomes, the VM MUST produce the identical return value (or trap code), identical durable state commit, and identical normative logical trace.
- **Exclusions:** Live external calls, translation attempts, wall-clock timing, provider request metadata, and host process interruptions are outside the determinism guarantee.

---

## 2. Prose-to-SPL Translation Phase

### 2.1 Constrained Decoding
The translator converts user prose (plus a human-readable summary of available Signature Catalog entries, inputs, and durable state declarations) into SPL v5 source code using OpenAI's Lark CFG constrained decoding feature configured with the normative static grammar in **Section 3**.

The translator prompt MUST instruct the model to push all open-ended reasoning, extraction, and classification into explicit leaf calls (`model.decide` for closed decisions; `model.ask` for text or JSON-schema-constrained generation) rather than attempting to emulate logic inside prompts.

### 2.2 Bounded Compile-Repair Loop
Because a Context-Free Grammar guarantees syntactic well-formedness but cannot enforce static typing, lexical binding resolution, or Signature Catalog validity, the translator executes a bounded repair loop:

1. Generate SPL v5 source under the static Lark CFG (`attempt = 1`).
2. Parse the source and run static type checking and Signature Catalog verification.
3. If compilation succeeds, emit the canonical bytecode and terminate the translation phase.
4. If compilation fails and `attempt < max_attempts` (host-configured, RECOMMENDED default `3`), feed structured compiler diagnostics (`code`, `span`, `message`, `expected`, `found`) back to the translator model and repeat.
5. If `attempt == max_attempts` and compilation still fails, fail translation with the final diagnostics list.

Translation diagnostics and retry counts MAY be logged by the host for observability, but are never part of the compiled bytecode or VM execution trace.

---

## 3. Lexical Structure and Surface Grammar (Lark CFG)

### 3.1 Lexical Rules
- **Encoding:** UTF-8 without BOM. Line endings `\r\n` and `\r` are normalized to `\n` before lexing.
- **Comments:** Line comments `// ...` to end of line; block comments `/* ... */` (non-nesting). Comments are discarded and never appear in the AST or bytecode.
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`, excluding reserved keywords.
- **Reserved Keywords:**
  `as`, `break`, `case`, `catch`, `continue`, `default`, `else`, `false`, `fn`, `for`, `if`, `in`, `input`, `let`, `mut`, `null`, `return`, `state`, `switch`, `true`, `try`, `type`, `while`
- **Reserved Primitive Type Names:**
  `bool`, `int`, `float`, `string`, `json`, `void`, `list`, `map`, `Error`
- **Reserved Effect Namespace Roots:**
  `model`, `web`, `fs`, `shell`, `tool`, `mcp`
- **Integer Literals:** Decimal (`0`, `42`, `1_000`) or hexadecimal (`0xFF`, `0x10_00`). Must fit signed 64-bit two's complement range (`-9223372036854775808` to `9223372036854775807`). Note: `-9223372036854775808` is parsed specially as unary `-` applied to `9223372036854775808` as `INT64_MIN`.
- **Float Literals:** Decimal with fraction and/or exponent (`0.0`, `3.14`, `1e-5`, `2.5E+3`). Must parse to a finite IEEE-754 binary64 value.
- **String Literals:** Double-quoted `"..."` supporting escapes `\"`, `\\`, `\n`, `\r`, `\t`, `\u{HEX}` (valid Unicode scalar value). Raw unescaped newlines inside `"..."` are invalid.
- **Template Strings:** Backtick-delimited `` `...${expr}...` `` supporting escapes `` \` ``, `\\`, `\$`, `\n`, `\r`, `\t`, `\u{HEX}`. Raw newlines are permitted and normalized to `\n`.

### 3.2 Normative Lark CFG

The following `llguidance`-compatible Lark grammar (no regex lookarounds or lazy quantifiers) defines the exact Context-Free Language used for both OpenAI constrained decoding and the reference parser:

```lark
start: program

program: top_decl+ stmt* | stmt+

top_decl: type_decl
        | input_decl
        | state_decl
        | fn_decl

type_decl: "type" IDENT "=" type_expr ";"
input_decl: "input" IDENT ":" type_expr ("=" expr)? ";"
state_decl: "state" IDENT ":" type_expr "=" expr ";"
fn_decl: "fn" IDENT "(" param_list? ")" "->" type_expr block

param_list: param ("," param)*
param: IDENT ":" type_expr

type_expr: union_type
union_type: nullable_type ("|" nullable_type)*
nullable_type: base_type "?"?

base_type: "null"
         | "bool"
         | "int"
         | "float"
         | "string"
         | "json"
         | "void"
         | "Error"
         | "list" "<" type_expr ">"
         | "map" "<" "string" "," type_expr ">"
         | "{" field_type_list? "}"
         | STRING
         | IDENT

field_type_list: field_type ("," field_type)* ","?
field_type: IDENT ":" type_expr

block: "{" stmt* "}"

stmt: let_stmt
    | assign_stmt
    | if_stmt
    | switch_stmt
    | while_stmt
    | for_stmt
    | try_stmt
    | return_stmt
    | break_stmt
    | continue_stmt
    | expr_stmt

let_stmt: "let" "mut"? IDENT (":" type_expr)? "=" expr ";"

assign_stmt: lvalue "=" expr ";"
lvalue: IDENT lvalue_seg*
lvalue_seg: "." IDENT
          | "[" expr "]"

if_stmt: "if" "(" expr ")" block ("else" (if_stmt | block))?

switch_stmt: "switch" "(" expr ")" "{" switch_case* switch_default? "}"
switch_case: "case" case_lit ("," case_lit)* ":" block
switch_default: "default" ":" block
case_lit: STRING | INT | "true" | "false"

while_stmt: "while" "(" expr ")" block
for_stmt: "for" "(" IDENT "in" expr ")" block
try_stmt: "try" block "catch" "(" IDENT ")" block

return_stmt: "return" expr? ";"
break_stmt: "break" ";"
continue_stmt: "continue" ";"
expr_stmt: expr ";"

expr: coalesce_expr

coalesce_expr: or_expr ("??" or_expr)*
or_expr: and_expr ("||" and_expr)*
and_expr: bitor_expr ("&&" bitor_expr)*
bitor_expr: bitxor_expr ("|" bitxor_expr)*
bitxor_expr: bitand_expr ("^" bitand_expr)*
bitand_expr: eq_expr ("&" eq_expr)*
eq_expr: rel_expr (EQ_OP rel_expr)*
rel_expr: shift_expr (REL_OP shift_expr)*
shift_expr: add_expr (SHIFT_OP add_expr)*
add_expr: mul_expr (ADD_OP mul_expr)*
mul_expr: cast_expr (MUL_OP cast_expr)*
cast_expr: unary_expr ("as" type_expr)?

unary_expr: UNARY_OP unary_expr
          | postfix_expr

postfix_expr: primary postfix_op*
postfix_op: "." IDENT
          | "?." IDENT
          | "[" expr "]"
          | "?.[" expr "]"
          | "(" arg_list? ")"

arg_list: expr ("," expr)* ","?

primary: effect_expr
       | literal
       | template_str
       | list_lit
       | record_lit
       | IDENT
       | "(" expr ")"

effect_expr: eff_ask
           | eff_decide
           | eff_web_search
           | eff_web_fetch
           | eff_fs
           | eff_shell
           | eff_js_tool
           | eff_mcp_tool

eff_ask: "model" "." "ask" "<" type_expr ">" "(" arg_list ")"
eff_decide: "model" "." "decide" "(" arg_list ")"
eff_web_search: "web" "." "search" "(" arg_list ")"
eff_web_fetch: "web" "." "fetch" "(" arg_list ")"
eff_fs: "fs" "." FS_OP "(" arg_list ")"
eff_shell: "shell" "." "run" "(" arg_list ")"
eff_js_tool: "tool" "." IDENT "(" expr ")"
eff_mcp_tool: "mcp" "." IDENT "." IDENT "(" expr ")"

FS_OP: "read" | "write" | "append" | "exists" | "list" | "stat"

literal: "null"
       | "true"
       | "false"
       | FLOAT
       | INT
       | STRING

list_lit: "[" arg_list? "]"
record_lit: "{" record_entry_list? "}"
record_entry_list: record_entry ("," record_entry)* ","?
record_entry: (IDENT | STRING) ":" expr

template_str: "`" template_part* "`"
template_part: TEMPLATE_TEXT
             | "${" expr "}"

EQ_OP: "==" | "!="
REL_OP: "<=" | ">=" | "<" | ">"
SHIFT_OP: ">>>" | "<<" | ">>"
ADD_OP: "+" | "-"
MUL_OP: "*" | "/" | "%"
UNARY_OP: "!" | "-" | "~"

IDENT: /[A-Za-z_][A-Za-z0-9_]*/
FLOAT: /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9]+)?|[0-9][0-9_]*[eE][+-]?[0-9]+/
INT: /0[xX][0-9a-fA-F][0-9a-fA-F_]*|[0-9][0-9_]*/
STRING: /"([^"\\\r\n]|\\["\\nrt]|\\u\{[0-9a-fA-F]{1,6}\})*"/
TEMPLATE_TEXT: /([^`\\$]|\\[`\\$nrt]|\\u\{[0-9a-fA-F]{1,6}\})+/

%ignore /[ \t\r\n]+/
```

### 3.3 Module Entry Point Normalization
A program MUST define execution via exactly one of two forms:
1. **Explicit entry point:** Declares `fn main() -> R { ... }` and contains zero top-level executable statements (`stmt`).
2. **Script shorthand:** Contains one or more top-level `stmt`s and declares no `fn main`. The compiler canonically lowers these statements into `fn main() -> R { <stmts> }`, where `R` is the unified type of top-level `return` statements (or `void` if none).

Declaring both `fn main` and top-level statements is a compile-time error (`E_DUPLICATE_ENTRY`). Declaring neither is also a compile-time error (`E_MISSING_ENTRY`).

---

## 4. Type System and Value Model

SPL v5 is **statically typed at compile time** and **schema-validated at every external/effect boundary at runtime**.

### 4.1 Types and Runtime Representation

| Type | Semantics | Canonical Runtime Representation |
|---|---|---|
| `null` | Singleton absence value | `null` |
| `bool` | Boolean truth value | `true` or `false` |
| `int` | Signed 64-bit two's-complement integer | `BigInt` / `i64` in `[-2^63, 2^63 - 1]` |
| `float` | Finite IEEE-754 binary64 floating point | Finite `f64` (`-0.0` normalized to `0.0`); `NaN` and `±Infinity` are forbidden |
| `string` | Valid UTF-8 string | Sequence of Unicode scalar values; `len()` and indexing count Unicode scalar values (code points) |
| `list<T>` | Ordered homogeneous sequence | Value-semantic array of `T` |
| `map<string, T>` | Homogeneous string-keyed dictionary | Value-semantic map with keys in canonical lexicographical Unicode code-point order |
| `{ k1: T1, ... }` | Closed structural record | Value-semantic record; field names stored in canonical lexicographical order |
| `"a" \| "b"` | Closed literal string union (enum) | `string` constrained to the declared literal members |
| `T?` | Nullable type (`T \| null`) | Either a value of `T` or `null` (`T??` flattens to `T?`) |
| `json` | Arbitrary finite JSON data | `null`, `bool`, finite number, `string`, array of `json`, or object with sorted string keys |
| `Error` | Built-in error record | `{ code: string, message: string, retryable: bool, details: json? }` |
| `void` | Absence of a return value (valid only as function return type) | Compiles to `null` return slot; cannot be assigned to variables |

**Type aliases (`type Name = TypeExpr;`):**
- Structural aliases expanded at compile time.
- Recursive type aliases are forbidden in v5 (`E_RECURSIVE_TYPE`) so that every SPL type maps cleanly to a finite, non-recursive OpenAI strict JSON Schema.
- General arbitrary unions (e.g., `int | string`) are NOT supported in v5. The `|` operator in `type_expr` is valid ONLY for:
  1. Closed string literal unions: `"a" | "b" | ...` (at least 2 distinct literals), optionally nullable (`("a" | "b")?` or `"a" | "b" | null`).
  2. Nullable sugar: `T | null` (equivalent to `T?`).

### 4.2 Numeric, Bitwise, String, and Equality Semantics

1. **No implicit numeric coercion:** Mixing `int` and `float` in any arithmetic or comparison operator is a compile-time error (`E_TYPE_MISMATCH`). Explicit casts are required:
   - `int as float`: IEEE-754 round-to-nearest-even conversion to finite `f64`.
   - `float as int`: Truncate toward zero; traps with `NUM_OVERFLOW` if outside `[-2^63, 2^63 - 1]`.
2. **Checked `int` arithmetic:** `+`, `-`, `*`, unary `-` trap with `NUM_OVERFLOW` on signed 64-bit overflow (including `-INT64_MIN`). `/` and `%` truncate toward zero and trap with `DIV_BY_ZERO` on `0` divisor and `NUM_OVERFLOW` on `INT64_MIN / -1`.
3. **Finite `float` arithmetic:** `+`, `-`, `*`, `/`, unary `-`. Any operation producing `NaN` or `±Infinity` (including division by `0.0`) traps with `FLOAT_NON_FINITE`. `-0.0` is canonicalized to `+0.0` immediately after every float operation. `%` is NOT defined on `float`.
4. **Bitwise operations:** `&`, `|`, `^`, `~`, `<<`, `>>` (arithmetic right shift), `>>>` (logical zero-fill right shift) require `int` operands and produce `int`. Shift counts outside `[0, 63]` trap with `SHIFT_OUT_OF_RANGE`.
5. **String operations:**
   - `+` concatenates `string + string -> string`.
   - Ordering `<`, `<=`, `>`, `>=` on `string` compares lexicographically by Unicode scalar value (code point).
   - Indexing `s[i]` returns a 1-code-point `string` (traps with `INDEX_OUT_OF_BOUNDS` if `i < 0 || i >= len(s)`).
   - Template interpolation `` `...${expr}...` `` accepts `string`, `int`, `float`, or `bool` expressions and formats them canonically (`int` base-10, `float` shortest round-trip decimal, `bool` `"true"`/`"false"`). Interpolating `null`, `T?`, `list`, `map`, `record`, or `json` is a compile-time error (`E_TEMPLATE_TYPE`); use `??` or `json.stringify(...)`.
6. **Structural equality (`==`, `!=`):**
   - Operands MUST have compatible types (`T` and `T`, or `T?` and `null`, or `T?` and `T`).
   - Deep structural equality for lists, maps, records, and `json`.
   - For `float`, `-0.0 == 0.0` is `true` (and `NaN` cannot exist).
7. **Short-circuiting:** `&&`, `||`, and `??` MUST evaluate the right-hand operand only when required.

### 4.3 Value Semantics, Mutability, and Scoping
- **Lexical block scoping:** Variables declared with `let` or `let mut` are scoped to their enclosing block. Shadowing an outer-scope binding in an inner block is permitted; redeclaring the same name in the same block is a compile error (`E_DUPLICATE_BINDING`).
- **Immutability by default:** Reassigning a `let` binding, `input` binding, function parameter, or mutating a field/index on an immutable binding is a compile-time error (`E_IMMUTABLE_BINDING`).
- **Value semantics:** Lists, maps, and records have pure value semantics (implementations MAY use copy-on-write internally). Assigning `let mut b = a; b[0] = 9;` MUST NOT modify `a`. Passing values to functions or effects never aliases caller variables.
- **Functions:** Top-level named functions only (`fn name(...) -> R`). Closures, lambdas, and first-class function values are NOT part of v5. Mutual and direct recursion are permitted up to `max_call_depth`. Functions MAY invoke effects.
- **Type inference:** `let x = expr;` infers `x`'s type from `expr` when unambiguous. Empty literals `[]` and `{}` require either an explicit variable type annotation (`let xs: list<int> = [];`) or a contextual expected type (function parameter, return type, or `as` annotation).

### 4.4 Nullability and Control-Flow Narrowing
- Direct property access `x.field` or index access `x[i]` on `T?` is a compile-time error (`E_NULLABLE_ACCESS`).
- Safe access operators:
  - `x ?? fallback`: evaluates to `T` if `x: T?` and `fallback: T` (or `T?` if `fallback: T?`).
  - `x?.field`: if `x: { field: U }?`, evaluates to `U?` (short-circuiting to `null` if `x == null`).
  - `x?.[i]`: if `x: list<U>?` or `map<string, U>?`, evaluates to `U?`.
- **Flow-sensitive narrowing:** Inside `if (x != null) { ... }` (and after an early-exit `if (x == null) { return ...; }` or `break`/`continue`), an immutable identifier `x: T?` is narrowed to `T`. Narrowing does not apply across assignments to a `let mut` variable or `state` variable.

### 4.5 Control Flow and `switch` Rules
- `if` and `while` conditions MUST have type `bool` (no truthiness coercion).
- `for (item in expr)` requires `expr: list<T>`; `item` is an immutable `T` binding scoped to the loop body. The loop iterates over a snapshot of the list evaluated once before the loop starts.
- `switch (expr)` supports `bool`, `int`, `string`, and closed string literal unions (`"a" | "b"`).
  - Cases do NOT fall through; each `case` has an explicit `{ ... }` block.
  - Duplicate case literals are a compile error (`E_DUPLICATE_CASE`).
  - When switching on `bool` or a closed string literal union, the `switch` MUST be exhaustive (either cover every member or include `default`).

### 4.6 Error Handling (`try` / `catch`)
- Recoverable **effect errors** (e.g., network failure, schema validation failure from `model.ask`, file not found, non-existent map key in strict calls, dynamic policy denial, tool error, `json.parse` failure) raise a typed `Error` value:
  ```spl
  type Error = {
    code: string,
    message: string,
    retryable: bool,
    details: json?
  };
  ```
- `try { ... } catch (err) { ... }` catches recoverable `Error`s raised anywhere in the `try` block (including inside nested function calls), binding `err: Error` in the `catch` block.
- **Uncatchable VM traps:** Logical limit violations (`LIMIT_EXCEEDED`), numeric/bounds/invariant runtime faults (`NUM_OVERFLOW`, `DIV_BY_ZERO`, `FLOAT_NON_FINITE`, `SHIFT_OUT_OF_RANGE`, `INDEX_OUT_OF_BOUNDS`), and replay mismatches (`REPLAY_DIVERGENCE`) ALWAYS halt the VM immediately and CANNOT be caught by `try/catch`.
- An uncaught recoverable `Error` that escapes `fn main` halts the VM as an unhandled error trap (`UNHANDLED_ERROR`), rolling back durable state.

### 4.7 Pure Deterministic Built-in Functions
Pure built-ins are compiled to `CALL_BUILTIN` and do NOT produce effect log entries:

- `len(x: string | list<T> | map<string, T>) -> int`
- `str.slice(s: string, start: int, end: int) -> string` (code-point indices; traps on invalid range)
- `str.split(s: string, sep: string) -> list<string>`
- `str.join(parts: list<string>, sep: string) -> string`
- `str.trim(s: string) -> string`
- `str.lower(s: string) -> string` / `str.upper(s: string) -> string` (Unicode simple case folding)
- `str.contains(s: string, sub: string) -> bool`
- `str.starts_with(s: string, prefix: string) -> bool` / `str.ends_with(s: string, suffix: string) -> bool`
- `str.replace(s: string, from: string, to: string) -> string`
- `list.push(xs: list<T>, val: T) -> list<T>`
- `list.slice(xs: list<T>, start: int, end: int) -> list<T>`
- `list.concat(a: list<T>, b: list<T>) -> list<T>`
- `list.contains(xs: list<T>, val: T) -> bool`
- `map.has(m: map<string, T>, key: string) -> bool`
- `map.get(m: map<string, T>, key: string) -> T?`
- `map.set(m: map<string, T>, key: string, val: T) -> map<string, T>`
- `map.delete(m: map<string, T>, key: string) -> map<string, T>`
- `map.keys(m: map<string, T>) -> list<string>` (always in canonical lexicographical order)
- `map.values(m: map<string, T>) -> list<T>` (ordered by canonical key order)
- `math.abs_i(x: int) -> int` / `math.abs_f(x: float) -> float`
- `math.min_i(a: int, b: int) -> int` / `math.max_i(a: int, b: int) -> int`
- `math.min_f(a: float, b: float) -> float` / `math.max_f(a: float, b: float) -> float`
- `math.floor(x: float) -> float` / `math.ceil(x: float) -> float` / `math.round(x: float) -> float`
- `json.stringify(val: AnyValue) -> string` (canonical JSON: sorted object keys, no extra whitespace, finite numbers)
- `json.parse(text: string) -> json` (raises catchable `Error { code: "JSON_PARSE_ERROR", ... }` on invalid JSON)

### 4.8 Deterministic SPL Type to JSON Schema Mapping
When generating JSON Schemas for `model.ask<T>`, `cast_json`, or validating catalog tool schemas, the compiler applies this deterministic mapping (compatible with OpenAI strict structured outputs):

| SPL Type | Canonical JSON Schema |
|---|---|
| `null` | `{"type":"null"}` |
| `bool` | `{"type":"boolean"}` |
| `int` | `{"type":"integer"}` (runtime also enforces 64-bit signed integer bounds) |
| `float` | `{"type":"number"}` (runtime also enforces finite binary64) |
| `string` | `{"type":"string"}` |
| `"a" \| "b"` | `{"enum":["a","b"],"type":"string"}` (enum sorted lexicographically) |
| `T?` | `{"anyOf":[<Schema(T)>,{"type":"null"}]}` |
| `list<T>` | `{"items":<Schema(T)>,"type":"array"}` |
| `map<string, T>` | `{"additionalProperties":<Schema(T)>,"type":"object"}` *(Note: OpenAI strict mode forbids dynamic-key objects at top-level; `model.ask<T>` MUST reject `map<string, T>` or `json` unless wrapped/configured in a profile explicitly permitting non-strict JSON mode, or the compiler rejects them with `E_SCHEMA_NOT_STRICT`.)* |
| `{ b: T2, a: T1 }` | `{"additionalProperties":false,"properties":{"a":<Schema(T1)>,"b":<Schema(T2)>},"required":["a","b"],"type":"object"}` |

Note: If `model.ask<T>` has a non-object, non-string top-level type (e.g., `int`, `list<string>`, `T?`), the host wraps the OpenAI strict JSON Schema in `{"additionalProperties":false,"properties":{"value":<Schema(T)>},"required":["value"],"type":"object"}` and unwraps `value` after validation.

---

## 5. Signature Catalog and Capability Model

The **Signature Catalog** is a host-supplied canonical JSON document provided at compile time and verified at runtime via its SHA-256 digest (`catalog_sha256`).

### 5.1 Canonical JSON Serialization Rule
Whenever this specification requires "canonical JSON" (for `catalog_sha256`, bytecode schemas, `json.stringify`, effect argument normalization, and trace hashing):
- UTF-8 encoded, no insignificant whitespace.
- Object keys sorted strictly by Unicode code-point order (UTF-8 byte order).
- Numbers formatted via ECMAScript shortest round-trip representation; `-0.0` serialized as `0`; `int` serialized as exact base-10 integer without exponent; `NaN`/`±Infinity` forbidden.
- Strings escaped minimally per RFC 8259 (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u00XX` lowercase hex for `U+0000..U+001F`).

### 5.2 Signature Catalog Schema

```json
{
  "spec_version": "5",
  "models": {
    "default": {
      "provider": "openai",
      "model": "gpt-4.1",
      "max_output_tokens": 2048,
      "temperature": 0.0,
      "strict_schema": true
    }
  },
  "decisions": {
    "classifier_default": {
      "adapter": "openai_logprobs",
      "model": "gpt-4.1-mini",
      "top_logprobs": 20,
      "temperature": 0.0
    }
  },
  "shell_profiles": {
    "git_status": {
      "executable": "/usr/bin/git",
      "base_argv": ["status", "--porcelain"],
      "cwd_root": "workspace",
      "params_schema": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": [],
        "additionalProperties": false
      },
      "argv_template": ["--", "${path}"],
      "env_allowlist": ["LANG", "LC_ALL"],
      "timeout_ms": 10000,
      "max_stdout_bytes": 65536,
      "max_stderr_bytes": 16384
    }
  },
  "fs_roots": {
    "workspace": {
      "permissions": ["read", "list", "stat"],
      "max_file_bytes": 1048576
    },
    "output": {
      "permissions": ["read", "write", "append", "list", "stat"],
      "max_file_bytes": 1048576
    }
  },
  "web": {
    "search": {
      "enabled": true,
      "max_results_cap": 10
    },
    "fetch": {
      "enabled": true,
      "allowed_methods": ["GET", "HEAD"],
      "allowed_domains": ["example.com", "*.docs.org"],
      "denied_domains": [],
      "block_private_ips": true,
      "max_redirects": 3,
      "max_response_bytes": 524288
    }
  },
  "js_tools": {
    "parse_invoice": {
      "params_schema": { "...": "..." },
      "result_schema": { "...": "..." },
      "timeout_ms": 5000
    }
  },
  "mcp_tools": {
    "github": {
      "get_issue": {
        "params_schema": { "...": "..." },
        "result_schema": { "...": "..." },
        "timeout_ms": 10000
      }
    }
  }
}
```

### 5.3 Static Capability Verification and Manifest
1. Every effect call in SPL MUST reference a profile, root, JS tool, or MCP tool present in the Signature Catalog. Unknown identifiers are compile-time errors (`E_UNKNOWN_CAPABILITY`).
2. `fs.<op>` calls with a constant root string are statically verified against `fs_roots[root].permissions`; dynamic root strings (if allowed) are checked at runtime. (RECOMMENDED: require `fs` root and `shell` profile and `model` profile arguments to be string literals so static capability analysis is exact—**normative in v5**: profile/root arguments to `model.ask`, `model.decide`, `shell.run`, and `fs.*` MUST be string literals.)
3. Arguments and return types of `shell.run`, `tool.<name>`, and `mcp.<server>.<tool>` are statically type-checked against the catalog's `params_schema` and `result_schema`.
4. The compiler embeds `CATALOG <catalog_sha256>` and a sorted `CAPS` manifest listing every exact capability referenced by the bytecode (e.g., `model:default`, `decision:classifier_default`, `fs:workspace:read`, `shell:git_status`, `web:search`, `tool:parse_invoice`, `mcp:github.get_issue`). At load time, the host MUST verify that the runtime environment authorizes every entry in `CAPS`.

---

## 6. Effect Namespaces and Contracts

Every effect invocation:
1. Evaluates all arguments left-to-right.
2. Checks logical effect budgets (`max_effects_total`, per-namespace limit).
3. Serializes canonical `(kind, target, args)`.
4. In **replay mode**, matches against the next effect log entry (trapping with `REPLAY_DIVERGENCE` on any mismatch) and returns the recorded normalized outcome.
5. In **live mode**, dispatches to the host adapter, runtime-validates the returned value against the expected static SPL type, records the normalized outcome to the append-only effect log, and returns the value (or raises a catchable `Error`).

### 6.1 Model Leaves

#### `model.decide` (Decision API)
```spl
// Closed-set decision (returns "yes" | "no", or ("approve" | "reject" | "escalate")? when min_confidence is set)
model.decide("classifier_default", prompt, ["yes", "no"])
model.decide("classifier_default", prompt, ["approve", "reject", "escalate"], { min_confidence: 0.85 })
```
- **Signature:**
  - `profile`: string literal referencing `catalog.decisions`.
  - `prompt`: `string`.
  - `options`: non-empty list literal of `>= 2` distinct string literals (`"a"`, `"b"`, ...), determining the static union type `U = "a" | "b" | ...`.
  - `opts` (optional 4th argument): record literal `{ min_confidence?: float, system?: string, context?: json }`.
- **Static return type:**
  - Without `min_confidence`: `U`.
  - With `min_confidence`: `U?` (returns `null` if the winning option's normalized probability is `< min_confidence`).
- **Host Decision API semantics:**
  - Backed by a pluggable host Decision API adapter.
  - Reference adapter (`openai_logprobs`): maps each option to a canonical single-token or prefix-unambiguous label, queries OpenAI with `logprobs` enabled, extracts log-probabilities across the candidate options, applies softmax normalization so `sum(scores) == 1.0`, and selects the argmax (breaking exact ties deterministically by option list index).
  - If `min_confidence` is out of `[0.0, 1.0]` at runtime, raises `Error { code: "INVALID_ARGUMENT", ... }`.
  - **Trace record:** The effect log MUST record `decision_scores: map<string, float>` (full normalized probability vector over all options) and `confidence: float` alongside `choice: string | null`.

#### `model.ask<T>` (Generation / Structured Extraction)
```spl
let summary: string = model.ask<string>("default", `Summarize: ${doc}`);
let parsed: Invoice = model.ask<Invoice>("default", "Extract invoice fields", { input: raw_text });
```
- **Signature:**
  - Type parameter `<T>`: any valid SPL type supported by strict JSON Schema (or `string` for plain text).
  - `profile`: string literal referencing `catalog.models`.
  - `prompt`: `string`.
  - `opts` (optional 3rd argument): `{ system?: string, input?: json }`.
- **Execution:** Calls OpenAI Responses API with explicit `model`, `max_output_tokens`, `temperature`, and `text.format` (`text` for `string`, strict `json_schema` for all other `T`).
- **Boundary validation:** Runtime MUST parse and validate the response against `T` (including finite floats, int64 bounds, no extra keys). On failure, raises catchable `Error { code: "MODEL_SCHEMA_ERROR", retryable: true, ... }`.

### 6.2 Web Search and Fetch

#### `web.search`
```spl
web.search(query: string, opts?: { max_results?: int, domain?: string }) -> list<WebSearchResult>
```
Where:
```spl
type WebSearchResult = {
  title: string,
  url: string,
  snippet: string
};
```
- Enforces `catalog.web.search.enabled` and caps `max_results` at `max_results_cap`.

#### `web.fetch`
```spl
web.fetch(url: string, opts?: {
  method?: "GET" | "HEAD" | "POST",
  headers?: map<string, string>,
  body?: string
}) -> WebFetchResponse
```
Where:
```spl
type WebFetchResponse = {
  status: int,
  url: string,
  content_type: string,
  headers: map<string, string>,
  body: string,
  truncated: bool
};
```
- Enforces `allowed_methods`, `allowed_domains`/`denied_domains`, `block_private_ips` (SSRF protection including DNS resolution and redirect targets), `max_redirects`, and `max_response_bytes`.
- Response header keys are normalized to lowercase and sorted canonically.
- Policy violation raises catchable `Error { code: "POLICY_DENIED", retryable: false, ... }`.

### 6.3 Virtual-Root File I/O (`fs.*`)
All `fs.*` operations take a string-literal `root` referencing `catalog.fs_roots` and a relative `path: string`:
- `fs.read(root, path) -> string`
- `fs.write(root, path, content: string) -> null`
- `fs.append(root, path, content: string) -> null`
- `fs.exists(root, path) -> bool`
- `fs.list(root, path) -> list<string>` (entries sorted lexicographically by Unicode code point)
- `fs.stat(root, path) -> { exists: bool, is_file: bool, is_dir: bool, size_bytes: int }`

**Path safety rules (normative):**
- `path` MUST use `/` separators, MUST NOT start with `/`, MUST NOT contain `..` segments, null bytes (`\0`), backslashes (`\`), or drive prefixes (`C:`).
- Host MUST resolve symlinks and verify the canonical target remains strictly inside the mounted root directory. Violations raise `Error { code: "POLICY_DENIED", retryable: false, ... }`.
- Reads/writes exceeding `max_file_bytes` raise `Error { code: "FS_LIMIT_EXCEEDED", retryable: false, ... }`.

### 6.4 Shell Profiles (`shell.run`)
```spl
shell.run(profile, args_record) -> ShellResult
```
Where:
```spl
type ShellResult = {
  exit_code: int,
  stdout: string,
  stderr: string,
  truncated: bool
};
```
- `profile` MUST be a string literal referencing `catalog.shell_profiles`.
- `args_record` MUST match the profile's `params_schema`.
- **No shell interpolation:** The host MUST spawn `executable` directly via `execFile`/`posix_spawn` with an explicit `argv` array constructed from `base_argv` + substituted `argv_template` slots. Invoking `/bin/sh -c`, `cmd.exe /c`, or PowerShell string evaluation is FORBIDDEN.
- Non-zero `exit_code` is returned as normal data in `ShellResult` (NOT an exception), allowing SPL control flow to inspect it. Timeout, spawn failure, or missing executable raises catchable `Error { code: "SHELL_ERROR", ... }`.

### 6.5 Host-Registered JS Tools and MCP Tools
- **JS Tools:** `tool.<name>(args_record) -> ResultType`
  - Statically typed via `catalog.js_tools[name]`.
  - Host invokes registered JS handler with deep-cloned canonical JSON `args`, enforces timeout, validates return value against `result_schema`.
- **MCP Tools:** `mcp.<server>.<tool>(args_record) -> ResultType`
  - Statically typed via `catalog.mcp_tools[server][tool]`.
  - Host invokes MCP `tools/call`, extracts structured/JSON payload, validates against `result_schema`.
- Tool failures or schema mismatches raise catchable `Error { code: "TOOL_ERROR" | "TOOL_SCHEMA_ERROR", ... }`.

---

## 7. Durable State and Replay Model

### 7.1 Transactional Durable State (`state`)
1. Module-level `state name: T = init_expr;` declarations define persistent typed state variables.
2. `init_expr` MUST be a pure expression (no effect calls, no references to `input` or other `state` variables) evaluated only when `name` is absent from the host's persisted store.
3. At run start, the host loads the **initial state snapshot** (validating all existing values against their declared types, or evaluating `init_expr` for missing keys) and records it in the run envelope.
4. During execution, `LOAD_STATE` and `STORE_STATE` read and write an in-VM staged copy of the state table.
5. **Atomic commit:**
   - If `fn main` returns normally, the VM emits `final_state` and the host commits it atomically.
   - If the VM halts via any trap (`LIMIT_EXCEEDED`, `UNHANDLED_ERROR`, `NUM_OVERFLOW`, `REPLAY_DIVERGENCE`, etc.), staged state changes MUST be discarded (rolled back).

### 7.2 Append-Only Effect Log and Mid-Run Recovery
1. Every completed effect call is assigned a monotonically increasing 0-based `seq` integer and appended durably to the run's effect log before the VM resumes execution.
2. **Crash recovery / Replay:** If a host process crashes mid-run, the host restarts the VM with the identical `(bytecode, inputs, initial_state, limits)` and supplies the persisted effect log.
3. While `next_seq < effect_log.length`:
   - The VM computes `(kind, target, canonical_args)` for the effect instruction.
   - It compares `(seq, kind, target, canonical_args)` byte-for-byte against `effect_log[next_seq]`.
   - On any difference, the VM MUST immediately trap with `REPLAY_DIVERGENCE` (uncatchable).
   - On exact match, the VM injects the recorded normalized `outcome` without performing live I/O.
4. Once `next_seq == effect_log.length`:
   - In **recovery mode**, the VM seamlessly transitions to live effect execution.
   - In **strict replay mode** (for auditing/testing), emitting any additional effect traps with `REPLAY_DIVERGENCE`.

---

## 8. Canonical Textual Stack Bytecode (`SPLB 5`)

The compiled artifact is a **canonical UTF-8 text file** (`.splb`) with `\n` (LF) line endings, no trailing whitespace on any line, and a single trailing `\n`.

### 8.1 File Layout

Sections MUST appear in this exact order:

```text
SPLB 5
CATALOG <64-char lowercase hex sha256>
CAPS <canonical JSON array of sorted capability strings>
INPUTS
  <name> <canonical_type> <const_idx_or_NONE>
STATE
  <name> <canonical_type> <init_fn_or_const>
CONSTS
  c0 <kind> <canonical_literal>
  c1 <kind> <canonical_literal>
SCHEMAS
  s0 <canonical JSON schema>
FN <name> (<param_types>) -> <ret_type> locals=<N>
  0000: <OPCODE> [operands...]
  0001: <OPCODE> [operands...]
END
```

**Canonicalization Rules:**
- `INPUTS` and `STATE` are listed in declaration order from the AST.
- `CONSTS` are deduplicated and assigned sequential IDs `c0, c1, ...` strictly in order of first encounter during a deterministic left-to-right pre-order AST compilation pass.
  - Kinds: `I` (base-10 `i64`), `F` (canonical finite `f64`), `S` (canonical JSON string literal), `J` (canonical JSON value).
- `SCHEMAS` are deduplicated canonical JSON schemas assigned `s0, s1, ...` in order of first encounter.
- `FN` blocks are emitted in AST declaration order, with `main` emitted last (or in its declared position; **normative:** `FN` blocks are emitted sorted lexicographically by function name, with `main` always emitted last).
- Instruction addresses are 4-digit zero-padded decimal indices (`0000:`, `0001:`, ..., expanding to 5+ digits if `>= 10000`).
- Local slots `0..arity-1` are function parameters in declaration order; remaining local slots are assigned sequentially in deterministic pre-order AST declaration order.
- Canonical type strings use zero extra spaces: `int`, `float`, `bool`, `string`, `null`, `json`, `void`, `Error`, `T?`, `list<T>`, `map<string,T>`, `{a:int,b:string}` (sorted keys), `("a"|"b")` (sorted literals).

### 8.2 Complete Opcode Table

Every instruction operates on the VM operand stack (top of stack = right-hand operand for binary ops).

| Category | Mnemonic | Operands | Stack Effect | Semantics |
|---|---|---|---|---|
| **Constants & Stack** | `PUSH_CONST` | `c<idx>` | `-> v` | Push constant from pool |
| | `PUSH_NULL` | — | `-> null` | Push `null` |
| | `PUSH_TRUE` | — | `-> true` | Push `true` |
| | `PUSH_FALSE` | — | `-> false` | Push `false` |
| | `POP` | — | `v ->` | Discard top value |
| | `DUP` | — | `v -> v, v` | Duplicate top value |
| **Bindings** | `LOAD_LOCAL` | `<slot>` | `-> v` | Push local variable slot |
| | `STORE_LOCAL` | `<slot>` | `v ->` | Store top value into local slot |
| | `LOAD_INPUT` | `<idx>` | `-> v` | Push input value by index |
| | `LOAD_STATE` | `<idx>` | `-> v` | Push staged durable state value |
| | `STORE_STATE` | `<idx>` | `v ->` | Update staged durable state value |
| **Int Math** | `IADD` `ISUB` `IMUL` `IDIV` `IMOD` | — | `a, b -> r` | Checked 64-bit signed integer arithmetic |
| | `INEG` | — | `a -> r` | Checked 64-bit negation |
| **Bitwise** | `BIT_AND` `BIT_OR` `BIT_XOR` | — | `a, b -> r` | 64-bit bitwise op |
| | `BIT_NOT` | — | `a -> r` | 64-bit bitwise NOT |
| | `SHL` `SHR` `USHR` | — | `a, n -> r` | Checked shift (`n` in `0..63`) |
| **Float Math** | `FADD` `FSUB` `FMUL` `FDIV` | — | `a, b -> r` | Finite f64 arithmetic (`-0.0 -> 0.0`) |
| | `FNEG` | — | `a -> r` | Finite f64 negation (`-0.0 -> 0.0`) |
| **Compare & Logic** | `EQ` `NEQ` | — | `a, b -> bool` | Deep structural equality |
| | `ILT` `ILE` `IGT` `IGE` | — | `a, b -> bool` | Signed int64 comparison |
| | `FLT` `FLE` `FGT` `FGE` | — | `a, b -> bool` | Finite f64 comparison |
| | `SLT` `SLE` `SGT` `SGE` | — | `a, b -> bool` | Unicode code-point string comparison |
| | `NOT` | — | `a -> bool` | Boolean negation |
| | `IS_NULL` | — | `a -> bool` | Push `a == null` |
| **Casts & Strings** | `CAST_I2F` | — | `int -> float` | Explicit `int as float` |
| | `CAST_F2I` | — | `float -> int` | Explicit `float as int` (checked) |
| | `CAST_JSON` | `s<idx>` | `json -> T` | Runtime-validate `json` against schema `s<idx>` (raises catchable `CAST_ERROR`) |
| | `STR_CONCAT` | `<n>` | `s1..sn -> s` | Concatenate `n` strings |
| | `FMT_VAL` | — | `v -> string` | Canonical string formatting for template interpolation |
| **Containers** | `MAKE_LIST` | `<n>` | `v1..vn -> list` | Construct list of `n` items |
| | `MAKE_REC` | `<n>` | `k1,v1..kn,vn -> rec` | Construct record (compiler emits keys in sorted order) |
| | `MAKE_MAP` | `<n>` | `k1,v1..kn,vn -> map` | Construct map (VM inserts in canonical sorted key order) |
| | `GET_FIELD` | `c<key>` | `rec -> v` | Read record field |
| | `GET_FIELD_OPT` | `c<key>` | `rec? -> v?` | If `null`, push `null`; else read field |
| | `SET_FIELD` | `c<key>` | `rec, v -> rec'` | Value-semantic record field update |
| | `GET_INDEX` | — | `col, idx -> v` | Index `list`, `string`, or `map` (traps on OOB; `map` missing key raises catchable `KEY_NOT_FOUND` or use `map.get`) |
| | `GET_INDEX_OPT` | — | `col?, idx -> v?` | Safe optional index (`null` propagates) |
| | `SET_INDEX` | — | `col, idx, v -> col'` | Value-semantic list/map index update |
| | `LIST_LEN` | — | `list -> int` | Push list length (used for `for` loop lowering) |
| **Control Flow** | `JMP` | `<pc>` | — | Unconditional jump |
| | `JMP_IF_FALSE` | `<pc>` | `bool ->` | Jump if top is `false` |
| | `JMP_IF_TRUE` | `<pc>` | `bool ->` | Jump if top is `true` |
| | `JMP_IF_NULL` | `<pc>` | `v -> v` | Peek top; jump if `null` (does NOT pop, for `??` / `?.`) |
| | `JMP_IF_NOT_NULL` | `<pc>` | `v -> v` | Peek top; jump if non-null (does NOT pop) |
| | `CALL_FN` | `<name> <arity>` | `a1..an -> r` | Call top-level SPL function |
| | `CALL_BUILTIN` | `<id> <arity>` | `a1..an -> r` | Call pure deterministic built-in |
| | `RET` | — | `v ->` | Return top value to caller frame |
| **Exceptions** | `TRY_PUSH` | `<catch_pc>` | — | Push exception handler frame `(catch_pc, stack_depth)` |
| | `TRY_POP` | — | — | Pop innermost exception handler frame |
| **Effects** | `EFF_ASK` | `c<prof> s<idx> <has_opts>` | `prompt, [opts] -> T` | Invoke `model.ask<T>` |
| | `EFF_DECIDE` | `c<prof> c<opts_list> <has_cfg>` | `prompt, [cfg] -> U \| U?` | Invoke `model.decide` |
| | `EFF_WEB_SEARCH` | `<has_opts>` | `query, [opts] -> list` | Invoke `web.search` |
| | `EFF_WEB_FETCH` | `<has_opts>` | `url, [opts] -> rec` | Invoke `web.fetch` |
| | `EFF_FS` | `<op> c<root>` | `path, [content] -> r` | Invoke `fs.<op>` |
| | `EFF_SHELL` | `c<prof> s<res_idx>` | `args -> ShellResult` | Invoke `shell.run` |
| | `EFF_JS_TOOL` | `c<name> s<res_idx>` | `args -> T` | Invoke `tool.<name>` |
| | `EFF_MCP_TOOL` | `c<srv> c<tool> s<res_idx>` | `args -> T` | Invoke `mcp.<srv>.<tool>` |

When a recoverable `Error` is raised:
- If an active `TRY` handler exists in the current or any enclosing call frame, the VM unwinds call frames and operand stack to the handler's saved depth, pushes the `Error` record onto the operand stack, and jumps to `catch_pc` (where `STORE_LOCAL` binds `err`).
- If no handler exists, the VM traps with `UNHANDLED_ERROR`.

---

## 9. VM Execution Semantics, Logical Limits, and Trace Format

### 9.1 Evaluation Order
All sub-expressions MUST be evaluated strictly left-to-right:
- Binary operands: LHS before RHS (respecting short-circuiting for `&&`, `||`, `??`).
- Function/effect arguments: argument 0, 1, ..., N-1.
- List literals: element 0, 1, ..., N-1.
- Record literals: entries evaluated in source order, then assembled into canonical sorted key order by `MAKE_REC`.

### 9.2 Deterministic Logical Limits
The host supplies a `Limits` object (all non-negative integers). All accounting MUST be deterministic and independent of wall-clock time or host GC:

```json
{
  "max_steps": 100000,
  "max_call_depth": 64,
  "max_operand_stack": 1024,
  "max_memory_bytes": 16777216,
  "max_state_bytes": 1048576,
  "max_effects_total": 64,
  "max_effects_by_kind": {
    "model.ask": 16,
    "model.decide": 32,
    "web.search": 8,
    "web.fetch": 16,
    "fs": 32,
    "shell": 8,
    "js_tool": 32,
    "mcp_tool": 32
  }
}
```

- **Step accounting:** Every executed opcode increments `steps` by `1`. Variable-length operations (`STR_CONCAT`, `MAKE_LIST`, `MAKE_MAP`, `CALL_BUILTIN`, `EQ`/`NEQ` deep comparisons) additionally charge `1` step per 64 elements/code-points processed.
- **Logical memory accounting:** Deterministic size formula:
  - `null`, `bool`, `int`, `float`: `8` bytes
  - `string`: `16 + utf8_byte_length` bytes
  - `list<T>`: `24 + sum(size(item))` bytes
  - `record` / `map`: `24 + sum(size(key) + size(val))` bytes
- Exceeding any limit traps immediately with `LIMIT_EXCEEDED` (uncatchable) before executing the offending instruction.

### 9.3 Normative Logical Trace Schema
Every VM run produces a canonical trace document:

```json
{
  "spec_version": "5",
  "bytecode_sha256": "<hex>",
  "catalog_sha256": "<hex>",
  "inputs": { "...": "..." },
  "initial_state": { "...": "..." },
  "limits": { "...": "..." },
  "effects": [
    {
      "seq": 0,
      "kind": "model.decide",
      "target": "classifier_default",
      "args": {
        "options": ["approve", "reject"],
        "prompt": "Approve refund of $12?",
        "min_confidence": 0.8
      },
      "outcome": {
        "status": "ok",
        "value": "approve",
        "decision_scores": {
          "approve": 0.9412,
          "reject": 0.0588
        },
        "confidence": 0.9412
      },
      "non_normative_meta": {
        "provider_request_id": "req_...",
        "latency_ms": 214,
        "usage": { "input_tokens": 38, "output_tokens": 1 }
      }
    }
  ],
  "result": {
    "status": "ok",
    "value": "approved",
    "final_state": { "processed_count": 1 },
    "metrics": {
      "steps": 47,
      "peak_call_depth": 1,
      "peak_operand_stack": 4,
      "peak_memory_bytes": 512,
      "effects_count": 1
    }
  }
}
```

- **Normative trace equality:** Two traces are equivalent iff they are byte-identical in canonical JSON after stripping every `non_normative_meta` field.
- On trap, `result` has `"status": "trap"`, `"trap_code"`, `"trap_message"`, `"trap_pc"`, `"trap_fn"`, and `"final_state": null` (state rolled back).

---

## 10. End-to-End Example

### 10.1 SPL v5 Source
```spl
type Ticket = { id: int, text: string };
input ticket: Ticket;
state approved_count: int = 0;

fn main() -> string {
  let verdict = model.decide(
    "classifier_default",
    `Classify refund ticket #${ticket.id}: ${ticket.text}`,
    ["approve", "reject"],
    { min_confidence: 0.8 }
  );

  if (verdict == null) {
    return "manual_review";
  }

  switch (verdict) {
    case "approve": {
      approved_count = approved_count + 1;
      return model.ask<string>("default", `Write brief approval reply for #${ticket.id}`);
    }
    case "reject": {
      return "rejected";
    }
  }
}
```

### 10.2 Corresponding Canonical Bytecode (`SPLB 5`)
```text
SPLB 5
CATALOG e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
CAPS ["decision:classifier_default","model:default"]
INPUTS
  ticket {id:int,text:string} NONE
STATE
  approved_count int c0
CONSTS
  c0 I 0
  c1 S "classifier_default"
  c2 S "Classify refund ticket #"
  c3 S "id"
  c4 S ": "
  c5 S "text"
  c6 J ["approve","reject"]
  c7 S "min_confidence"
  c8 F 0.8
  c9 S "manual_review"
  c10 S "approve"
  c11 I 1
  c12 S "default"
  c13 S "Write brief approval reply for #"
  c14 S "reject"
  c15 S "rejected"
SCHEMAS
  s0 {"type":"string"}
FN main () -> string locals=1
  0000: PUSH_CONST c2
  0001: LOAD_INPUT 0
  0002: GET_FIELD c3
  0003: FMT_VAL
  0004: PUSH_CONST c4
  0005: LOAD_INPUT 0
  0006: GET_FIELD c5
  0007: FMT_VAL
  0008: STR_CONCAT 4
  0009: PUSH_CONST c7
  0010: PUSH_CONST c8
  0011: MAKE_REC 1
  0012: EFF_DECIDE c1 c6 1
  0013: STORE_LOCAL 0
  0014: LOAD_LOCAL 0
  0015: IS_NULL
  0016: JMP_IF_FALSE 0019
  0017: PUSH_CONST c9
  0018: RET
  0019: LOAD_LOCAL 0
  0020: PUSH_CONST c10
  0021: EQ
  0022: JMP_IF_FALSE 0034
  0023: LOAD_STATE 0
  0024: PUSH_CONST c11
  0025: IADD
  0026: STORE_STATE 0
  0027: PUSH_CONST c13
  0028: LOAD_INPUT 0
  0029: GET_FIELD c3
  0030: FMT_VAL
  0031: STR_CONCAT 2
  0032: EFF_ASK c12 s0 0
  0033: RET
  0034: LOAD_LOCAL 0
  0035: PUSH_CONST c14
  0036: EQ
  0037: JMP_IF_FALSE 0040
  0038: PUSH_CONST c15
  0039: RET
  0040: PUSH_NULL
  0041: RET
END
```

---

## 11. Node.js + OpenAI SDK Reference Implementation Conformance

Any conforming Node.js reference implementation MUST satisfy:

1. **Explicit SDK configuration:** Every call via `openai` (`responses.create` or the Decision API adapter) MUST explicitly pass `model`, `temperature`, `max_output_tokens`, `store: false` (unless overridden by host profile), and explicit timeout/retry policy from the catalog profile. Relying on implicit SDK defaults is non-conforming.
2. **Exact integer arithmetic:** All `int` values MUST use JavaScript `BigInt` clamped and range-checked to signed 64-bit (`[-2n**63n, 2n**63n - 1n]`) rather than IEEE-754 `number`.
3. **Code-point strings:** `len(s)` and `s[i]` / `str.slice` MUST operate on Unicode scalar values (e.g., `[...s]` / code-point iteration), NOT UTF-16 `String.prototype.length`.
4. **Canonical JSON:** Implementation MUST provide a dedicated canonical JSON serializer/parser rather than raw `JSON.stringify` (which preserves insertion order and cannot serialize `BigInt`).
5. **Required Conformance Test Suites:**
   - **Grammar & Parser:** Positive/negative Lark CFG conformance and precedence tests.
   - **Type & Catalog Checker:** Exhaustive checks for strict `int`/`float`, nullability narrowing, recursive type rejection, schema strictness, and unknown/unauthorized capabilities.
   - **Canonical Bytecode Golden Tests:** Byte-for-byte identity across repeated compilations and across different catalog key orderings (after canonicalization).
   - **VM Determinism & Traps:** Checked overflow, finite floats, shift bounds, value semantics isolation, logical limit traps, and `try`/`catch` unwinding.
   - **Durable State & Replay:** Atomic rollback on trap, crash recovery mid-run, and mandatory `REPLAY_DIVERGENCE` trap on mutated effect args or order.
   - **Effect Boundary Security:** Path traversal / symlink escape rejection on `fs.*`, SSRF / domain denial on `web.fetch`, no-shell-interpolation verification on `shell.run`, and invalid-JSON/schema rejection on `model.ask`, `tool.*`, and `mcp.*`.
