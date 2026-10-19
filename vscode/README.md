# SPL - Semantic Prompt Language for VS Code

Syntax highlighting, snippets and editing support for `.spl` scripts run by the `spl` interpreter (the `lang/` folder of
this repository).

## Features

* **Highlighting** for the whole language: keywords, `let`/`def` declarations, numbers, comments, the `@{model=...}`
  directive, and strings with `{expr}` interpolation, `{{ }}` and `\{ \}` brace escapes, raw `r'...'` strings and
  triple-quoted strings. Illegal escapes and stray `}` in strings are flagged with the `invalid` scope.
* **Generation and agency**: generation-only `?` and `think`, explicit `agent`, and expression-valued modifiers
  (`len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`, `model`). Raw tools are ordinary function calls.
* **Guidance and failures**: `enforce`/`forbid` and their `instruct`/`avoid` aliases,
  `restrict [fs|net|exec|mcp]` (including comma-separated clauses), `try`/`except`, `assert`, `fail`, `success`.
* **Snippets** (type the prefix): `def`, `if`, `ifelse`, `for`, `while`, `let`, `ask`, `askobj`, `think`, `try`,
  `askschema`, `retry` (bounded schema repair), `agent`, `enforce`, `forbid`, `instruct`, `avoid`, `restrict`, `restrictnet`, `restrictexec`, `restrictmcp`, `restrictmulti`, `read_file`, `write_file`, `web_fetch`,
  `web_search`, `shell`, `assert`, `fail`, `success`, `model`.
* **Editing**: `#` line comments (Ctrl+/), bracket matching and auto-closing for `{}` `[]` `()` and quotes
  (including `'''`), auto-indent after `{`, `#region` / `#endregion` folding.

The grammar is purely lexical (TextMate). Unknown/duplicate modifier names are checked by `spl --check`;
expression values and schemas are validated at runtime. All blocks now share their function/script scope.
`let` declares/redeclares names; compound and member/index assignments do not use `let`.

## Install

```
npm install
npm run package                                  # creates spl-lang-vscode-0.3.0.vsix
code --install-extension spl-lang-vscode-0.3.0.vsix
```

For development open this folder in VS Code and press F5 (Extension Development Host).

## Develop

```
npm test
```

* `test/*.spl` contain scope assertions: a line `#   ^^^ scope.name` asserts the scope of the columns under the
  carets on the line above (`- scope` asserts absence). `test/run-assertions.mjs` runs them with `vscode-textmate`.
* `test/check-examples.mjs` tokenizes every script in `../lang/examples` and fails on `invalid` scopes or on
  strings/blocks that are left open at the end of a file.

Keep `syntaxes/spl.tmLanguage.json` in sync with `../lang/docs/syntax.ebnf` when the language changes.
