# VS Code extension

Syntax highlighting, snippets and editing support for `.spl` scripts. The extension lives in the `vscode/` folder of the repository.

## Features

### Highlighting

Keywords, `let`/`def` declarations, numbers, comments, the `@{model=…}` directive and strings with `{expr}` interpolation.

### Generation & agents

`?`, `think`, explicit `agent`, and shared modifiers: `len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`, `model`. Raw tools use ordinary calls.

### Runtime inputs

Read-only `$env` and `$args` have highlighting, hover documentation and completions,
including inside interpolation. Typing `$` triggers completion; accepting `$env` or
`$args` replaces the whole partial special-variable name without duplicating `$`.
Diagnostics reject unknown special names and attempts to declare/rebind them.
The editor never reads the process environment or script arguments.
See [runtime inputs](Language.md#runtime-inputs-env-and-args).

### Scopes & failures

`enforce`/`forbid`, `restrict [fs|net|exec|mcp]` with comma-separated clauses, `try`/`except`, `assert`, `fail`, `success`.

### Snippets

Type a prefix and press Tab. Covers control flow, LLM commands, tools and scopes.

### Editing

`#` comments (Ctrl+/), bracket matching and auto-closing for `{}` `[]` `()` and quotes (including `'''`), auto-indent after `{`, `#region` folding.

### Escape checking

Illegal escapes and stray `}` in strings are flagged with the `invalid` scope.

String highlighting understands interpolation `{expr}`, the `{{ }}` and `\{ \}` brace escapes, raw `r'…'` strings and triple-quoted strings.

**Lexical only**

The grammar is lexical (TextMate). `spl --check` rejects unknown/duplicate modifier names; expression values and schemas are validated at runtime. Navigation and completion respect lexical block scopes, including loop and exception bindings. Leveled log modifiers are highlighted and completed separately from generation modifiers.

## Install

```bash
cd vscode
npm install
npm run package                                  # creates spl-lang-vscode-0.3.0.vsix
code --install-extension spl-lang-vscode-0.3.0.vsix
```

For development, open the `vscode/` folder in VS Code and press `F5` to launch an Extension Development Host.

## Snippets

Type the prefix, then `Tab`.

| Area | Prefixes |
| --- | --- |
| Control flow | `def` `if` `ifelse` `for` `while` `let` |
| LLM | `ask` `askobj` `askschema` `think` `agent` `model` |
| Failures | `try` `retry` (bounded schema repair) `assert` `fail` `success` |
| Scopes | `enforce` `forbid` `restrict` `restrictnet` `restrictexec` `restrictmcp` `restrictmulti` |
| Tools | `read_file` `write_file` `web_fetch` `web_search` `shell` |

## Develop & test

```bash
npm test
```

* `test/*.spl` contain **scope assertions**: a line `#   ^^^ scope.name` asserts the scope of the columns under the carets on the line above (`- scope` asserts absence). `test/run-assertions.mjs` runs them with `vscode-textmate`.

* `test/check-examples.mjs` tokenizes every script in `../lang/examples` and fails on `invalid` scopes or on strings/blocks that are left open at the end of a file.

**Keep the grammar in sync**

When the language changes, update `syntaxes/spl.tmLanguage.json` together with `lang/docs/syntax.ebnf`.
