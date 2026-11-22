# SPL (`.splx`) VS Code Extension

Provides full IDE support for **Semantic Prompt Language (`.splx`)** files powered by the SPL Language Server (`dist/lsp.js`):

- **Syntax highlighting** for `.splx` including `@{ ... }` brace-balanced prompt blocks with `${expr}` interpolation and `//` Markdown doc-comments
- **Live diagnostics** (lexer, parser, type-checker, row polymorphism, trait coherence, exhaustiveness, private FFI)
- **Type-aware property & method completion**:
  - Structural records, named `struct`s, and fields preserved across **row-polymorphic** transforms
  - Hybrid open records (`..extra: Dict<Str, V>`) with `//` field doc-comments
  - Optional chaining (`?.`), extension methods, trait methods, built-in methods, module namespaces (`fs.`, `agent.`, ...), and `std/*` imports
- **Rich Hover tooltips** showing inferred types, `//` Markdown docs, and **live JSON Schema previews** on `type_schema<T>()`
- **Go to Definition** (including cross-file imports & `std/*` modules) and **Document Outline Symbols**

## Setup

From the repository root, run:

```bash
npm run vscode:install
```

(Or from `editors/vscode`, run `npm run install-ext`.)

This builds the SPL compiler & LSP server (`dist/lsp.js`), installs extension dependencies if needed, and links the extension into `~/.vscode/extensions/`. Reload VS Code (`Developer: Reload Window`) to activate `.splx` support.

To uninstall:

```bash
npm run vscode:uninstall
```
