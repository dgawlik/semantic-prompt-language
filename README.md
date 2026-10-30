<img src="vscode/icon.png" alt="SPL logo" width="128" height="127">

# SPL: Semantic Prompt Language

Executable Markdown for AI workflows. `spl` fences hold exact, Python-like code; blockquotes hold
natural-language agent commands. Both share variables, tools and guards; blockquotes are never compiled into SPL.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
[Examples](docs-template/Examples.md) | [Grammar](docs-template/Grammar.md) |
[Specification](LANG-PRD.md)

````markdown
---
extension: semantic-prompt-language
version: 1
---

```spl
let invoice = read_file('invoice.txt')
```

> Extract the line items and total from @invoice as JSON and save it to @data

```spl
let sum = 0
for line in data.lines:
    sum += line.amount
assert abs(sum - data.total) < 0.01 'line items do not add up'
success data
```
````

## Block syntax migration

**Breaking change:** blocks now use `:` followed by a newline and an indented, nonempty body,
not braces. Use spaces (4 recommended), never tabs for indentation. Replace empty bodies with
`pass`; inline suites are not supported. Dedents must match a previous indentation level;
unexpected indentation or a missing body is a syntax error. Blank and comment-only lines do
not affect indentation. Semicolons separate simple statements only.

Dictionaries `{...}` and string interpolation `{expr}` are unchanged. Newlines inside `()`, `[]`
and dictionaries are insignificant; explicit `\` continuation still works. Each block remains
a lexical child scope: `let` declares locally, while assignment updates the nearest declaration,
unlike Python. Anonymous value-producing blocks use a bare colon; see
[Language](docs-template/Language.md#bindings-and-scopes) and the [grammar](docs-template/Grammar.md).

## Why SPL?

* **Short loops.** One file, run directly. `--check` needs no model; `--trace`/`--replay` rerun
  code and guards against recorded answers.
* **Exact code where it matters.** Control flow and I/O never call a model. `ask`/`think` generate
  values without tools; `agent` expressions and blockquotes can act.
* **Guards you can see.** `fmt`, `schema` and `assert` check data; `restrict` limits files, network,
  commands and MCP tools. Prompt guidance (`enforce`, `forbid`) is kept separate from validation.

## Install

```sh
npm install -g spl-lang
spl login
spl examples/hi.md
```

Requires Node.js >=24.15.0 and GitHub Copilot for model calls. From a checkout: `cd lang`, `npm install`,
then `node dist/cli.js examples/hi.md`.

Logs use one compact header: `->` model input (magenta), `<-` output/action (cyan),
`~` variable state (yellow), `x` error (red), `!` warning (yellow), `i` info (blue),
and `.` debug (gray). Explicit script logs keep their `[info|error|debug] log:` prefix.
Automatic logs show committed variable changes in their defining scopes, not executed source.
Same-value writes, no-op mutations and initial runtime/store state are omitted.

With terminal stdin and stderr, BetterTUI starts JSON objects/arrays folded. Up/Down selects,
Enter/Space toggles, Page Up/Down scrolls, and Home/End reaches the ends. Completion restores the
terminal and retains one complete expanded transcript without waiting for a key. Redirected logs
and embedded sinks are expanded and non-interactive; stdout remains the workflow result.
Terminals that cannot report restorable modes, or already use an alternate screen, get
diagnosed append-only output instead of risking their existing terminal state.
`--silent` suppresses execution logs; `--log-level` keeps severity filtering, with model/state
events at every non-silent level. `NO_COLOR` takes precedence over `FORCE_COLOR`;
`FORCE_COLOR=0` disables color, and forcing color never enables keyboard input.

## Repository

| Folder | Contents |
| --- | --- |
| [lang/](lang/README.md) | Interpreter, CLI, tests and [examples](lang/examples/) |
| [vscode/](vscode/README.md) | VS Code language server and runnable Markdown notebooks |
| [docs-template/](docs-template/Introduction.md) | Documentation sources |
| [docs/](docs/) | Generated documentation site (GitHub Pages) |

## Development

```sh
npm --prefix lang install
npm test                 # offline interpreter tests
npm --prefix vscode test # extension tests
```

Live tests are opt-in: in PowerShell, `$env:SPL_LIVE_TESTS='1'; npm test`.

To change the documentation, edit [docs-template/](docs-template/Introduction.md), then regenerate
and verify the site. Commit the generated `docs/` files with the sources.
The build-time syntax rules live in [docs/highlight.mjs](docs/highlight.mjs); keep them aligned with
SPL syntax and the [VS Code grammar](vscode/syntaxes/spl.tmLanguage.json).
The shared logo is [vscode/icon.png](vscode/icon.png); the docs build copies it into
`docs/assets/` for the site header and favicon.

```sh
npm install
npm run docs:build
npm run docs:check
```

Preview with `python -m http.server 8765 --directory docs`.