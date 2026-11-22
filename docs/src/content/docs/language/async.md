---
title: Colorless Async & Concurrency
description: Transparent async inference, sequential map by default, opt-in par_map, async_all, and async_race.
---

SPL eliminates function coloring — there are **no `async` or `await` keywords** in user code.

## How Colorless Async Works

The compiler performs fixed-point effect inference across the call graph:
- Pure functions compile to plain synchronous JavaScript functions with zero `Promise` overhead.
- Any function that transitively calls a suspending operation (`http.fetch`, `fs.read`, `clock.sleep`, `llm.ask`, etc.) automatically compiles to a JS `async function` with `await` inserted at call sites.

```splx
import clock from "std/clock"

// Pure -> compiled to synchronous JS
fn double(n: Int) -> Int {
    n * 2
}

// Calls `clock.sleep` -> compiler infers async automatically!
fn slow_double(n: Int) -> Int {
    clock.sleep(25)
    double(n)
}
```

## Sequential by Default, Concurrent by Choice

To prevent agentic code from accidentally spawning unbounded parallel LLM or tool requests, `Array.map` runs **sequentially** by default. Concurrency is always explicit and opt-in:

```splx
// Sequential (~75ms): runs one item after another
let seq = [1, 2, 3].map { x -> slow_double(x) }

// Concurrent (~25ms): runs all items via `Promise.all`
let par = [1, 2, 3].par_map { x -> slow_double(x) }

// Explicit combinators
let both = async_all([
    { -> slow_double(10) },
    { -> slow_double(20) }
])

let fastest = async_race([
    { -> clock.sleep(50); "slow" },
    { -> clock.sleep(5); "fast" }
])
```
