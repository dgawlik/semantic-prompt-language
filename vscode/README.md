# SPL - Semantic Prompt Language for VS Code

Language server, syntax highlighting, snippets and editing support for `.spl` scripts run by the `spl` interpreter (the `lang/` folder of
this repository).

## Features

* **Live syntax diagnostics** from the interpreter's actual lexer and parser, including invalid escapes,
  misplaced control flow, and unknown/duplicate generation modifiers.
* **Completions** for language keywords, all built-in functions and raw tools, visible function/script bindings,
  generation modifiers, and the `model` header directive.
* **Hover documentation** for keywords, built-ins, generation modifiers, and local declarations.
* **Go to Definition** for bindings in the current document, including function parameters, nested functions,
  loop variables, caught failures, and references inside string interpolation.
* **Document symbols** for functions and bindings, with nested function outlines.
* **Highlighting** for the whole language: keywords, `let`/`def` declarations, numbers, comments, the `@{model=...}`
  directive, and strings with `{expr}` interpolation, `{{ }}` and `\{ \}` brace escapes, raw `r'...'` strings and
  triple-quoted strings. Illegal escapes and stray `}` in strings are flagged with the `invalid` scope.
* **Generation and agency**: generation-only `?` and `think`, explicit `agent`, and expression-valued modifiers
  (`len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`, `model`). Raw tools are ordinary function calls.
* **Guidance and failures**: `enforce`/`forbid`,
  `restrict [fs|net|exec|mcp]` (including comma-separated clauses), `try`/`except`, `assert`, `fail`, `success`.
* **Snippets** (type the prefix): `def`, `if`, `ifelse`, `for`, `while`, `let`, `ask`, `askobj`, `think`, `try`,
  `askschema`, `retry` (bounded schema repair), `agent`, `enforce`, `forbid`, `restrict`, `restrictnet`, `restrictexec`, `restrictmcp`, `restrictmulti`, `read_file`, `write_file`, `web_fetch`,
  `web_search`, `shell`, `assert`, `fail`, `success`, `model`.
* **Editing**: `#` line comments (Ctrl+/), bracket matching and auto-closing for `{}` `[]` `()` and quotes
  (including `'''`), auto-indent after `{`, `#region` / `#endregion` folding.

Highlighting is lexical (TextMate); the language server separately checks syntax on open and after edits.
Expression values, schemas, and whether a name exists on a particular execution path are validated at runtime,
not by the language server. Navigation is document-local and follows lexical function/script scopes; ordinary
blocks do not introduce scopes. While source is incomplete, available tokens still provide bindings and
static completions remain available even if lexing fails.
`let` declares/redeclares names; compound and member/index assignments do not use `let`.

The server only analyzes source: it never runs SPL, accesses runtime tools, authenticates Copilot, or calls models.
The VSIX bundles the parser and LSP dependencies, so users do not need a separate `spl` installation.
Server startup/analysis errors are reported in **Output > SPL Language Server** and editor notifications.

## Install

Requires VS Code 1.82+. Building from this checkout requires Node.js 20+ and the sibling `lang/src` sources.
Run these commands in `vscode/`:

```
npm install
npm run package                                  # creates spl-lang-vscode-0.3.0.vsix
code --install-extension spl-lang-vscode-0.3.0.vsix
```

For development open this folder in VS Code, run `npm install`, and press F5 (Extension Development Host).
The launch configuration builds the client and server first. Open any `.spl` file to activate the server.

## Develop

```
npm run build
npm run typecheck
npm test
```

* `src/extension.ts` starts the Node IPC language client. `src/server.ts` also supports `--stdio` for other LSP clients.
* `src/features.ts` imports the parser directly from `../lang/src` at build time. `build.mjs` bundles the extension
  and server into `out/`; no interpreter runtime or Copilot SDK is loaded.
* `test/language-server.test.ts` tests diagnostics, completions, documentation, scope-aware navigation, interpolation,
  document symbols, every shipped example, and real server lifecycle/incremental edits over both stdio and IPC.
* `test/*.spl` contain scope assertions: a line `#   ^^^ scope.name` asserts the scope of the columns under the
  carets on the line above (`- scope` asserts absence). `test/run-assertions.mjs` runs them with `vscode-textmate`.
* `test/check-examples.mjs` tokenizes every script in `../lang/examples` and fails on `invalid` scopes or on
  strings/blocks that are left open at the end of a file.

Keep `syntaxes/spl.tmLanguage.json` in sync with `../lang/docs/syntax.ebnf` when the language changes.
