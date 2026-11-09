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

This workflow generates a six-slide introduction to SPL, including optional typed contracts.
Run it from the repository root. Generation uses an agent and may write presentation files;
`spl generate-presentation.md --check` checks the document without making model calls.

```spl
let slide1: str = '''
    Semantic Prompt Language is a Python-like language with LLM calls built in;
    mix exact code and natural-language steps in executable Markdown;
    distinguish deterministic checks from probabilistic model output
'''

let slide2: str = '''
    Getting started ->
    1. installation from npm
    2. API-key login and setting up VS Code
    3. running lang/examples/basics.md; run lang/examples/typed-data.md without a model
'''

let slide3: str = '''
    Blocks and code fences -> explain blockquote agent tools and shared variables;
    show colon blocks with exactly four spaces, object: dictionaries, and a compact exact-code example
'''

let slide4: str = '''
    Typed contracts -> primitive annotations, enums, exact structs, list[T], unions and type aliases;
    show type Money = int with integer-cent arithmetic and ask(schema=Invoice);
    distinguish structural data from hydratable class instances and object(instance) projection;
    metadata is model advice, assertions check business rules, annotations do not choose ask schemas
'''

let slide5: str = '''
    Append-only traces and human input -> record a run with --trace run.jsonl;
    human input in the terminal or via repeated --human flags;
    reuse the same --trace path to resume or replay deterministically, choose another file to restart
'''

let slide6: str = '''
    Restrictions and MCP -> enforce and forbid are prompt guidance, restrict is runtime enforcement;
    show filesystem, command and MCP tool restrictions; restrictions are not an OS sandbox
'''

enforce 'Use modern-web-standards skill':
    forbid 'Hallucinating':
        agent '''

            Read the current README, docs-template guides and runnable examples before writing.
            Create a beautiful presentation of this repo for new starters: exactly 6 slides in HTML
            and a matching 6-page PDF. Use valid SPL examples and explain implemented features only.

            Slide1 - {slide1}
            Slide2 - {slide2}
            Slide3 - {slide3}
            Slide4 - {slide4}
            Slide5 - {slide5}
            Slide6 - {slide6}

            Save to folder presentations
'''
```
````

## Why SPL?

* **Short loops.** One file, run directly. `--check` needs no model; `--trace run.jsonl` resumes
  recorded work and replays completed runs deterministically without repeating side effects.
* **Exact code where it matters.** Control flow and I/O never call a model. `ask`/`think` generate
  values without tools; `agent` expressions and blockquotes can act.
* **Guards you can see.** `fmt`, `schema` and `assert` check data; `restrict` limits files, network,
  commands and MCP tools. Prompt guidance (`enforce`, `forbid`) is kept separate from validation.
* **Optional typed contracts.** Primitive annotations, enums, structs, classes, typed lists,
  unions and transparent `type` aliases describe data and enforce consistency.
  `ask(schema=YourType)` selects typed decoding; annotations alone do not configure model output.
  Field metadata is model advice, not a substitute for assertions.

Try [typed-data.md](lang/examples/typed-data.md) without a model or login. See
[Gradual typing](docs-template/Language.md#gradual-typing) for contracts and
[Schemas and repairs](docs-template/LLM-commands.md#schemas-and-repairs) for typed generation.

## Install

```sh
npm install -g spl-lang
spl login openai         # or anthropic / google
spl examples/hi.md
```

Requires Node.js >=24.15.0. Model calls use the official OpenAI, Anthropic and Google clients.
Model logs identify the backend as `native-sdk`; existing recordings remain replayable.
Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` (also
`GOOGLE_API_KEY` / `GEMINI_API_KEY`), or use `spl login <provider>` to save a key and default provider.
Environment keys override saved keys. With multiple providers and no saved default, select one
using `--provider`, `SPL_PROVIDER` or a model such as `--model anthropic/claude-sonnet-4-5`.
Legacy GitHub Copilot credentials are no longer used. Login configures API keys, not subscription OAuth.

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

This revision requires exactly four spaces per block level and `object:` dictionary expressions
(`object()` for an empty dictionary). Brace-based SPL source is no longer accepted; JavaScript,
JSON and interpolation braces are unchanged. See the [manual typing migration guide](docs-template/Migration.md)
for annotations, numeric conversions, persistent contracts, and class versus struct schemas.

```sh
npm --prefix lang install
npm test                 # offline interpreter tests
npm --prefix vscode test # extension tests
```

Live tests are opt-in: in PowerShell, `$env:SPL_LIVE_TESTS='1'; npm test`.

The [VS Code extension](vscode/README.md#language-server) provides parser/type-checker diagnostics,
scope-aware definitions/references/rename, signature help, document and open-document workspace
symbols, folding and semantic highlighting. Workflow Markdown shares declarations across fences
and `@name` references; `.spl` scratch files and notebook code cells are also supported. Editor
analysis is offline and never executes workflows.

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
