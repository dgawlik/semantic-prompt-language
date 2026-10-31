<img src="vscode/icon.png" alt="SPL logo" width="128" height="127">

# SPL: Semantic Prompt Language

Executable Markdown for AI workflows.
SPL is dual purpose: either natural language or python works.
Both share variables, tools and guards; blockquotes are never compiled into SPL.
Language has LLM and Agent calls built in, support for tools and MCP.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
[Examples](lang/examples) | [Presentation](presentations/SPL-New-Starters.pdf)

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6.1-terra'
---

# Generate Presentation

This example presents how to use the tool to generate presentation for itself.

```spl
let slide1 = '''
    Semantic Prompt Language is a python language with LLM calls built in; 
    forget callback hell of most agentic frameworks;
    run automations with high reliablity
''';

let slide2 = '''
    Getting started -> 
    1. installation from npm
    2. setting up vscode
    3. running examples/basics.md
'''

let slide3 = '''
    Blocks and code fences -> explanation what blockquote does the internal tool it uses;
    most compact and descriptive example of deterministic syntax
'''

let slide4 = '''
    Checkpoints, replay and human input -> when program crashes rereun it with llms responses
    saved; human input with in-terminal input and via flags
'''

let slide5 = '''
    Restrictions and mcps; how restrictions work, enforce and forbid -> soft, restriction -> hard, 
    way to invoke mcp
'''

enforce 'Use modern-web-standards skill':
    forbid 'Hallucinating':
        agent '''

            Create beautiful presentation of this repo for new-starters. Limit output to 5 pages html and pdf.

            Slide1 - {slide1}
            Slide2 - {slide2}
            Slide3 - {slide3}
            Slide4 - {slide4}
            Slide5 - {slide5}

            Save to folder presentations
'''
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

Requires Node.js >=24.15.0 and GitHub Copilot credentials for model calls. 

From a checkout: `cd lang`, `npm install`,
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

## Contributing

Especially in this early phase of development the feedback is very important.

Something does not work -> file an issue.

PRs are welcome, I'm looking for Co-Founders.