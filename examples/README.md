# SPL (`.splx`) Language Examples

Runnable, documented examples covering 100% of the features specified in [SPEC.md](../SPEC.md).

| File | Topics Covered |
|---|---|
| [`01_basics.splx`](./01_basics.splx) | Primitives (`Int`, `Float`, `Str`, `Bool`, `Char`, `Bytes`), `let` / shadowing / `let mut`, arithmetic & bitwise ops, math builtins, `if`/`else`/`while`, expression blocks, `Str` methods, regex builtins |
| [`02_functions_and_tco.splx`](./02_functions_and_tco.splx) | First-class functions & closures, Kotlin-style trailing lambdas, named parameters & defaults, `(a, b)` tuples vs. `[a, b]` arrays, `Array` combinators, immutable `Dict<K, V>`, self-tail-call optimization (`sum_to(100_000)`) |
| [`03_records_and_rows.splx`](./03_records_and_rows.splx) | Named `struct`s with `///` doc-comments & `''` LLM hints, anonymous records & field shorthand, structural equivalence, functional spread (`{ ...x, k: v }`), row polymorphism (`..r`), hybrid open records (`..extra: Dict<Str, Json>`), deep `==` |
| [`04_enums_matching_errors.splx`](./04_enums_matching_errors.splx) | Rust-like tagged `enum`s (unit + payload variants), exhaustive `match` with guards across enums/open records/arrays/tuples, `Option<T>` (`T?`, `?.`, `??`), `Result<T, E>` + postfix `?` propagation |
| [`05_traits_extensions_modules.splx`](./05_traits_extensions_modules.splx) + [`lib/geometry.splx`](./lib/geometry.splx) | 1-file-per-module (`pub`, named/aliased/namespace `import`), custom `trait` & `impl`, generic trait bounds, nominal `newtype` enums for trait coherence, import-scoped row-polymorphic extension methods |
| [`06_prompts_and_schemas.splx`](./06_prompts_and_schemas.splx) | First-class `@{ ... }` prompt blocks (auto-dedent, brace-balanced JSON, `${expr}` interpolation, trailing prompt calls), `///` docs vs. `''` LLM hints in `type_schema<T>()` (`Int` vs `Float`, `Option`, closed vs. open `additionalProperties`, enums), `decode<T>(json)` validation |
| [`07_async_and_stdlib.splx`](./07_async_and_stdlib.splx) | Transparent (colorless) async, sequential `map` vs. concurrent `par_map`, `async_all` / `async_race`, universal stdlib (`std/clock`, `std/crypto`, `std/console`) & server stdlib (`std/fs`, `std/proc`, `std/os`) |
| [`08_dynamic_codegen.splx`](./08_dynamic_codegen.splx) | Typed dynamic code generation (`std/codegen`): sandboxed `js_fn<In, Out>`, `js_async_fn<In, Out>`, `js_eval<Out>`, and runtime type-checked `spl_fn<In, Out>` |
| [`09_collections.splx`](./09_collections.splx) | Pure SPL standard library collections (`std/collections`): `HashMap<K, V>`, self-balancing AVL `TreeSet<T>`, and `List<T>` via types & extension methods |
| [`10_llm_and_agent.splx`](./10_llm_and_agent.splx) | Unified LLM provider facade (`std/llm`): `Prompt.ask<T>` (single turn), `Prompt.agent<T>` (multi-turn loop with tools, `Decision` hooks, streaming `on_delta`, attachments, thinking effort & `ExecutionTrace`), `Prompt.llm_fn<In, Out>` |
| [`11_reified_types.splx`](./11_reified_types.splx) | Reifiable types (`reified fn<T>`): generic `type_schema<T>()` and `decode<T>(json)`, compound reified types (`Array<T>`, `Envelope<T>`), forwarding reified `T` across functions and into `std/codegen`, and schema-guided validation errors |
| [`12_files_and_shell.splx`](./12_files_and_shell.splx) | Working with files & shell (`std/fs`, `std/proc`, `std/os`): nested `mkdir`/`write`/`read`/`stat`/`list_dir`/`remove`, typed JSON file persistence (`read_json<T>`), recursive directory walking, `proc.shell`, `proc.exec` with `cwd` & `timeout_ms`, and capturing non-zero exit codes & `stderr` |

## Running Examples

```bash
# Build compiler first (if not already built)
npm run build

# Run any example
node dist/cli.js run examples/01_basics.splx
node dist/cli.js run examples/06_prompts_and_schemas.splx

# Inspect a type's generated JSON Schema directly
node dist/cli.js schema examples/06_prompts_and_schemas.splx SecurityAudit
```
