---
title: Basics, Operators & Casts
description: Primitive types, comments, bindings, control flow, ranges, operator precedence, and `as` casts.
---

## Primitive Types

| Type | Description | Example |
|---|---|---|
| `Int` | 64-bit integer (`number` in JS, integer JSON Schema) | `42`, `100_000`, `0xff` |
| `Float` | IEEE 754 floating-point number | `3.14`, `1e-4` |
| `Str` (`String`) | UTF-16 string with `${expr}` interpolation | `"Hello, ${name}"` |
| `Bool` | Boolean | `true`, `false` |
| `Char` | Single Unicode character literal | `'A'`, `'\n'` |
| `Byte` | Unsigned 8-bit integer (`0..255`) | `255 as Byte` |
| `Bytes` | Binary byte buffer (`Uint8Array`) | `"hi" as Bytes` |
| `Json` | Dynamic JSON value | `json_parse("{}")?` |
| `Prompt` | First-class prompt template | `@{ Summarize ${doc} }` |
| `Unit` | Empty value (void) | `()` |

`String` is a built-in alias for `Str`.

## Three Comment Layers

SPL distinguishes developer notes from LLM schema metadata:

```splx
// Regular comment: stripped by the compiler (ignored by IDE docs & schemas)

/// Doc-comment: shown in IDE hover & completions, EXCLUDED from LLM JSON Schemas
'' LLM hint: emitted into `type_schema<T>()` `"description"` fields
type User = struct {
    /// Internal database key
    id: Int    '' Positive unique user ID
    name: Str  '' Full display name
}
```

## Bindings & Expression Blocks

```splx
let x = 10            // immutable
let x = x + 5         // lexical shadowing allowed

let mut total = 0     // mutable local binding
total = total + x

// Blocks and `if`/`else` are expressions — the last expression is returned
let label = if total > 10 {
    "large"
} else {
    "small"
}
```

## Loops & Ranges

Ranges (`start..end`, inclusive `start..=end`, and optional `..step`) are first-class `Iter<Int>` values with a zero-allocation native `for`-loop fast path:

```splx
// Half-open: 0, 1, 2, 3, 4
for i in 0..5 {
    print(i)
}

// Stepped range: 0, 2, 4, 6, 8
for j in 0..10..2 {
    print(j)
}

// Inclusive countdown: 10, 8, 6, 4, 2, 0
for k in 10..=0..-2 {
    print(k)
}

// First-class range combinators
let evens = (0..10..2).map { n -> n * 10 }.collect()

// Standard `while` loop
let mut n = 3
while n > 0 {
    n = n - 1
}
```

`for pat in iterable` works over `Array<T>`, `Dict<K, V>`, `Iter<T>`, `Str` (yielding `Char`), ranges, and any type providing `.iter() -> Iter<T>`.

## Operator Precedence

From **highest** to **lowest** precedence (table-driven Pratt parser):

| Level | Operators | Associativity | Notes |
|---|---|---|---|
| 1 | `.`, `?.`, `[]`, `()`, `@{ ... }`, `?` | Left | Postfix member, index, call, try |
| 2 | `**` | Right | `-2 ** 2` parses as `-(2 ** 2)` |
| 3 | `-`, `!`, `~` | Right | Prefix unary negation, logical NOT, bitwise NOT |
| 4 | `as Type` | Left | Explicit type conversion (`c as Int`) |
| 5 | `??` | Right | Tighter than arithmetic & comparisons (`arr[i] ?? 0 <= pivot`) |
| 6 | `*`, `/`, `%` | Left | Multiplicative |
| 7 | `+`, `-` | Left | Additive & string concatenation |
| 8 | `<<`, `>>` | Left | Bitwise shifts |
| 9 | `&` | Left | Bitwise AND |
| 10 | `^` | Left | Bitwise XOR |
| 11 | `\|` | Left | Bitwise OR (tighter than comparisons: `x & 1 == 0`) |
| 12 | `<`, `<=`, `>`, `>=` | Left | Relational |
| 13 | `==`, `!=` | Left | Deep structural equality |
| 14 | `&&` | Left | Short-circuit logical AND |
| 15 | `\|\|` | Left | Short-circuit logical OR |
| 16 | `..`, `..=` (optional `..step`) | Non-assoc | Range literals |

## Explicit Conversions (`as`)

SPL never performs lossy implicit coercions. Use `expr as Type` for explicit conversions:

```splx
let i = 3.9 as Int          // 3 (truncates toward zero)
let f = 42 as Float         // 42.0
let b = 257 as Byte         // 1 (masked to 0..255)
let ch = 65 as Char         // 'A'
let code = 'A' as Int       // 65
let flag = 1 as Bool        // true
let s = 123 as Str          // "123"
let n = "42" as Int         // 42
let raw = "hi" as Bytes     // Uint8Array
let back = raw as Str       // "hi"
let arr = (0..4) as Array<Int> // [0, 1, 2, 3]
```

Invalid conversions (e.g., `person as Int`) are rejected at compile time.
