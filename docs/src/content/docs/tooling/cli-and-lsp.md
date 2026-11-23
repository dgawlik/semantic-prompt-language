---
title: CLI & LSP / VS Code
description: Command-line subcommands and IDE Language Server capabilities for SPL (.splx).
---

## CLI Reference

Run the SPL CLI via `node dist/cli.js <command>` or `npm run spl -- <command>`:

| Command | Description |
|---|---|
| `spl check <file.splx>` | Parse and type-check `<file.splx>` and all transitive imports |
| `spl build <file.splx> [-o dir]` | Compile `<file.splx>` and its imports into standalone `.mjs` ES Modules (default `./dist-spl`) |
| `spl run <file.splx>` | Compile to a temporary directory and execute immediately |
| `spl debug <file.splx>` | Step interactively through every LLM request and response with pretty-printed results (reusing `spl trace` views, live JSON edit, mock injection, and `.jsonl` export; supports `--after-only`, `--no-pause`, `--format pretty\|json\|js\|spl`, `--save <path>`) |
| `spl login [provider] [token]` | Save `openai`, `google`, and `anthropic` API tokens in `~/.spl/credentials.json` (also supports `--from-env`, `--status`, `--clear`) |
| `spl trace [file.jsonl]` | Launch the zero-dependency interactive trace viewer & JSON editor with pretty JSON / JS / SPL syntax highlighting (`--view --format pretty\|json\|js\|spl` for non-interactive output) |
| `spl schema <file.splx> <Type>` | Print the compile-time JSON Schema for exported type `<Type>` |
| `spl lsp` | Start the JSON-RPC 2.0 Language Server over stdio |

## Interactive LLM Step Debugger (`spl debug`)

`spl debug <file.splx>` compiles and runs your SPL program while intercepting every `std/llm` call (`Prompt.ask<T>`, `Prompt.agent<T>`, `Prompt.llm_fn<In, Out>`, `llm.ask_raw`, `llm.decide`) inside a split-pane terminal UI built on the `spl trace` inspector:

- **Step & Breakpoints**: Press `n`, `Space`, or `Enter` to send a paused request or advance after a response, `c` to continue all remaining calls, or `b` to cycle breakpoints (`BEFORE+AFTER`, `AFTER-ONLY`, `BEFORE-ONLY`, `NONE`).
- **Pretty Printing**: Press `v` (or `1`–`4`) to switch between **Pretty** (expanded embedded JSON and syntax-highlighted JS/SPL code blocks), **JSON**, **JS**, and **SPL** views, and `p` to toggle embedded expansion.
- **Live Request/Response Editing & Mocking**: Press `e` to edit the active request or response JSON in-place before continuing, `m` when paused before a call to inject a mock response without hitting the network, or `x` to abort a single call.
- **Trace Export & Non-Interactive Mode**: Press `s` / `W` (or pass `--save out.jsonl`) to save the session for `spl trace`, or pass `--no-pause` to run end-to-end and pretty-print every LLM call and result to stdout.

## Language Server (`spl lsp`) Features

The built-in zero-dependency Language Server powers VS Code (`npm run vscode:install`) with:

- **Live Diagnostics**: Real-time lex, parse, module, and Hindley-Milner type errors.
- **Error-Tolerant Member Completions**: Struct fields, row-polymorphic preserved fields, built-in methods (`Array`, `Str`, `Dict`, `Iter`, `Option`, `Result`, `Prompt`), stdlib namespaces, traits, and extension methods — even when lines below the cursor are incomplete.
- **Named-Argument Completions & Signature Help**: Typing `(` or `,` inside calls like `@{ ... }.ask<Person>(...)` or `llm.ask<Person>(...)` suggests remaining named parameters (`provider:`, `api_key:`, `model:`, `temperature:`, ...) sorted with required arguments first, and highlights the active parameter in Signature Help.
- **Rich Hover Documentation**: Type signatures and `///` / `''` docs on locals, builtins, primitive types, stdlib functions, and live JSON Schema previews when hovering over `type_schema<T>()`.
- **Go to Definition & Document Symbols**: Jump directly into local or stdlib `.splx` definitions and browse types, fields, enums, and functions in the Outline view.
