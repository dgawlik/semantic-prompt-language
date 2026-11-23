---
title: Runnable Examples
description: Complete catalog of runnable .splx examples shipped with SPL.
---

Every example below lives in `examples/` and is verified automatically by `npm test`. Run any of them with:

```bash
node dist/cli.js run examples/<filename>.splx
```

| File | Topics Covered |
|---|---|
| `01_basics.splx` | Primitives, `let` / `let mut`, arithmetic & bitwise ops, math builtins, `if`/`else`/`while`, `Str` methods, regex builtins |
| `02_functions_and_tco.splx` | Closures, trailing lambdas, named parameters & defaults, tuples vs arrays, `Array` combinators, `Dict<K, V>`, extension methods, self-tail-call optimization (`sum_to(100_000)`) |
| `03_records_and_rows.splx` | Structs with `///` docs & `''` hints, anonymous records, structural equivalence, spread (`{ ...x, k: v }`), row polymorphism (`..r`), hybrid open records (`..extra: Dict<Str, Json>`) |
| `04_enums_matching_errors.splx` | Tagged `enum`s, exhaustive `match` with guards, `Option<T>` (`T?`, `?.`, `??`), `Result<T, E>` + `?` propagation |
| `05_traits_extensions_modules.splx` | Multi-file modules (`pub`, `import`), custom `trait` & `impl`, generic bounds, newtype enums for structural coherence, import-scoped extension methods |
| `06_prompts_and_schemas.splx` | `@{ ... }` prompt blocks, `///` docs vs `''` LLM hints, `type_schema<T>()`, and `decode<T>(json)` validation |
| `07_async_and_stdlib.splx` | Colorless async, sequential `map` vs `par_map`, `async_all` / `async_race`, `std/clock`, `std/crypto`, `std/console`, `std/fs`, `std/proc`, `std/os` |
| `08_dynamic_codegen.splx` | LLM-synthesized typed dynamic code generation (`Prompt.llm_fn<Int, Array<Int>>` from `std/llm`) |
| `09_collections.splx` | Pure SPL `std/collections`: `HashMap<K, V>`, AVL `TreeSet<T>`, and immutable `List<T>` |
| `10_llm_and_agent.splx` | Unified `std/llm`: `Prompt.ask<T>`, `Prompt.agent<T>`, `Prompt.llm_fn<In, Out>`, `llm.tool<Args, Out>`, `StreamDelta` matching, `Decision` hooks, `std/traces` JSONL, `llm.agent_replay<T>`, and `llm.decide` |
| `11_reified_types.splx` | User-defined `reified fn<T>`: generic `type_schema<T>()` & `decode<T>()`, compound types (`Array<T>`, `Envelope<Array<T>>`), and forwarding to `std/codegen` |
| `12_files_and_shell.splx` | Practical `std/fs`, `std/proc`, and `std/os`: nested directories, typed JSON persistence, recursive directory walking, `proc.shell`, `proc.exec` with `cwd` & `timeout_ms`, and non-zero exit codes |
