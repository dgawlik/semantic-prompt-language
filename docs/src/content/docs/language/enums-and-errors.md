---
title: Enums, Matching & Errors
description: Tagged enums (ADTs), exhaustive match expressions, Option<T>, and Result<T, E>.
---

## Tagged Enums (ADTs)

SPL supports Rust-style algebraic data types with unit variants and tuple payload variants:

```splx
enum Action {
    Quit
    Move(Int, Int)
    Say(Str)
}
```

## Exhaustive `match`

`match` is an expression that works uniformly over enums, records, open records (`..`), tuples, arrays, and literals, with optional `if` guards. Missing enum variants are caught at compile time:

```splx
fn describe(act: Action) -> Str {
    match act {
        Quit => "bye"
        Move(x, y) if x == 0 && y == 0 => "stay"
        Move(x, y) => "move (${x}, ${y})"
        Say(msg) => "say: " + msg
    }
}
```

Matching open records and arrays:

```splx
match event {
    { kind: "call", name, .. } => "calling " + name
    { kind: "done", .. }       => "finished"
    _                          => "other"
}
```

Namespace-qualified (`llm.TextDelta(t)`) and contextually-inferred (`TextDelta(t)`) enum patterns both work seamlessly in `match` arms.

## `Option<T>` (`T?`)

There is no `null` or `undefined`. Absence is represented with `Some(v)` and `None`:

```splx
let items = ["alpha", "beta"]
let second: Str? = items.get(1)          // Some("beta")
let missing: Str? = items[99]            // None

// Optional chaining (`?.`) and null coalescing (`??`)
let upper = second?.to_upper() ?? "DEFAULT"
```

## `Result<T, E>` & Postfix `?`

Recoverable failures return `Ok(value)` or `Err(error)`. Use postfix `?` to unwrap `Ok`/`Some` or propagate `Err`/`None` immediately, or `??` to provide a lazy fallback:

```splx
import fs from "std/fs"

fn load_port(path: Str) -> Result<Int, Str> {
    let raw = fs.read(path)?
    let parsed = json_parse(raw)?
    match decode<{ port: Int }>(parsed) {
        Ok(cfg) => Ok(cfg.port)
        Err(e) => Err(e.path + ": " + e.message)
    }
}

// Lazy fallback on Result or Option
let port = load_port("config.json") ?? 8080
```
