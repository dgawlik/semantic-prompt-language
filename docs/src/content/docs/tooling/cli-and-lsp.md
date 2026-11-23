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
| `spl login [provider] [token]` | Save `openai`, `google`, and `anthropic` API tokens in `~/.spl/credentials.json` (also supports `--from-env`, `--status`, `--clear`) |
| `spl schema <file.splx> <Type>` | Print the compile-time JSON Schema for exported type `<Type>` |
| `spl lsp` | Start the JSON-RPC 2.0 Language Server over stdio |

## Language Server (`spl lsp`) Features

The built-in zero-dependency Language Server powers VS Code (`npm run vscode:install`) with:

- **Live Diagnostics**: Real-time lex, parse, module, and Hindley-Milner type errors.
- **Error-Tolerant Member Completions**: Struct fields, row-polymorphic preserved fields, built-in methods (`Array`, `Str`, `Dict`, `Iter`, `Option`, `Result`, `Prompt`), stdlib namespaces, traits, and extension methods — even when lines below the cursor are incomplete.
- **Named-Argument Completions & Signature Help**: Typing `(` or `,` inside calls like `@{ ... }.ask<Person>(...)` or `llm.ask<Person>(...)` suggests remaining named parameters (`provider:`, `api_key:`, `model:`, `temperature:`, ...) sorted with required arguments first, and highlights the active parameter in Signature Help.
- **Rich Hover Documentation**: Type signatures and `///` / `''` docs on locals, builtins, primitive types, stdlib functions, and live JSON Schema previews when hovering over `type_schema<T>()`.
- **Go to Definition & Document Symbols**: Jump directly into local or stdlib `.splx` definitions and browse types, fields, enums, and functions in the Outline view.
