# SPL - Semantic Prompt Language for VS Code

Language tooling for executable `.md` workflows run by the `spl` interpreter.
Markdown remains the document language. Diagnostics, completion, navigation, and
symbols activate only when initial YAML frontmatter declares
`extension: semantic-prompt-language`; the runtime and server require `version: 1`.
Ordinary Markdown is not diagnosed as SPL. `.spl` file association has been removed.

## Features

* **Live syntax diagnostics** from the interpreter's actual lexer and parser, including invalid escapes,
  misplaced control flow, and unknown/duplicate generation modifiers.
* **Completions** for language keywords, all built-in functions and raw tools, visible lexical bindings,
  generation modifiers, log `level`, and `@name` references in blockquotes.
* **Hover documentation** for keywords, built-ins, generation modifiers, and local declarations.
* **Go to Definition** for bindings in the current document, including function parameters, nested functions,
  loop variables, caught failures, and references inside string interpolation.
* **Document symbols** for functions and bindings, with nested function outlines.
* **Highlighting** inside Markdown `spl` fences, plus `@name` markers in blockquotes.
  Embedded SPL includes keywords, declarations, numbers, comments,
  and strings with `{expr}` interpolation, `{{ }}` and `\{ \}` brace escapes, raw `r'...'` strings and
  triple-quoted strings. Illegal escapes and stray `}` in strings are flagged with the `invalid` scope.
* **Generation and agency**: generation-only `ask` and `think`, explicit `agent`, and expression-valued modifiers
  (`len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`, `model`). Raw tools are ordinary function calls.
* **Block expressions and logging**: expression-valued blocks and conditionals, and
  `log(level=debug)(value)` with separate log modifier completion, hover and highlighting.
* **Runtime inputs**: completion, hover and highlighting for read-only `$env` and `$args`,
  including inside interpolation. Typing `$` triggers special-variable completion.
* **Guidance and failures**: `enforce`/`forbid`,
  `restrict [fs|net|exec|mcp]` (including comma-separated clauses), `try`/`except`, `assert`, `fail`, `success`.
* **Snippets** (type the prefix): `def`, `if`, `ifelse`, `ifexpr`, `loglevel`, `for`, `while`, `let`, `ask`, `askobj`, `think`, `try`,
  `askschema`, `retry` (bounded schema repair), `agent`, `enforce`, `forbid`, `restrict`, `restrictnet`, `restrictexec`, `restrictmcp`, `restrictmulti`, `read_file`, `write_file`, `web_fetch`,
  `web_search`, `shell`, `assert`, `fail`, `success`, `model`.
* **Workflow snippet**: `splworkflow` creates version-1 frontmatter and mixed execution blocks.
  Embedded SPL uses its language configuration; prose retains normal Markdown editing.

Highlighting is lexical (TextMate); the language server separately checks syntax on open and after edits.
Expression values, schemas, and whether a name exists on a particular execution path are validated at runtime,
not by the language server. Navigation is document-local and follows lexical block/function scopes;
child declarations, loop variables and caught failures do not leak into parents. While source is incomplete, available tokens still provide bindings and
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
The launch configuration builds the client and server first. Open an opted-in `.md` file to use the server.

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

Keep `syntaxes/spl.tmLanguage.json` in sync with the
[canonical Markdown grammar](https://github.com/dgawlik/semantic-prompt-language/blob/HEAD/docs-template/Grammar.md) when the language changes.

Use absolute URLs for README links outside the extension folder so they resolve
correctly in the packaged extension and Marketplace.
