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
for line in data.lines {
    sum += line.amount
}
assert abs(sum - data.total) < 0.01 'line items do not add up'
success data
```
````

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

Requires Node.js 20+ and GitHub Copilot for model calls. From a checkout: `cd lang`, `npm install`,
then `node dist/cli.js examples/hi.md`.

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

```sh
npm install
npm run docs:build
npm run docs:check
```

Preview with `python -m http.server 8765 --directory docs`.