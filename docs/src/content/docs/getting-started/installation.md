---
title: Installation & CLI
description: Build the SPL compiler, run .splx programs, and install the VS Code extension.
---

## Requirements

- **Node.js 22+** (or Bun / Deno for executing compiled `.mjs` output)
- TypeScript compiler (`tsc`) for building the compiler from source

The core SPL compiler and runtime have **zero external npm dependencies**.

## Building from Source

Clone the repository and build the compiler and test suite:

```bash
npm run build
npm test
```

## Running `.splx` Files

Use the CLI via `node dist/cli.js` (or `npm run spl -- ...`):

```bash
# Save OpenAI / Google / Anthropic API tokens in ~/.spl/credentials.json
node dist/cli.js login

# Type-check a file and all imported modules
node dist/cli.js check examples/01_basics.splx

# Compile and run immediately
node dist/cli.js run examples/01_basics.splx

# Compile to standalone ES Modules (.mjs)
node dist/cli.js build examples/06_prompts_and_schemas.splx -o ./dist-spl

# Inspect & edit execution traces (JSON / JS / SPL pretty printing)
node dist/cli.js trace trace.jsonl

# Extract and print the compile-time JSON Schema for any exported type
node dist/cli.js schema examples/06_prompts_and_schemas.splx SecurityAudit
```

## VS Code Extension & Language Server

SPL ships with a zero-dependency JSON-RPC 2.0 Language Server (`spl lsp`) and a VS Code extension providing `.splx` syntax highlighting, live diagnostics, hover docs (including live JSON Schema previews), named-argument completions, signature help, go-to-definition, and document symbols.

```bash
# Install the VS Code extension into ~/.vscode/extensions
npm run vscode:install

# Uninstall later if needed
npm run vscode:uninstall
```

Reload your VS Code window after installing (`Developer: Reload Window`).
