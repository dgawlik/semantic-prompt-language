# Getting started

Install the CLI, configure OpenAI, Anthropic or Google credentials, then write and refine a workflow in a short edit-run loop.

## Install

Use Node.js >=24.15.0. Native BetterTUI packages support Windows, macOS and Linux on x64/arm64.
If native rendering cannot start, the CLI diagnoses the problem and keeps complete plain logs.

```bash
npm install -g spl-lang
spl login openai           # or anthropic / google
```

`spl login <provider>` prompts for an API key without echoing it and saves a separate key for each
provider in `~/.spl/credentials.json` (override the folder with `SPL_HOME`). It also selects that
provider as the default. If the provider's environment key is already set, login selects the
provider without prompting or copying the environment secret into the file.
Keys are configured locally; login does not make a billable request or verify account access.

Alternatively, set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`.
Google also accepts `GOOGLE_API_KEY` and `GEMINI_API_KEY`, in that order after the canonical name.
Environment keys take precedence over saved keys. A single configured provider is detected
automatically. With multiple providers, select one with `--provider`, `SPL_PROVIDER`, a model
such as `--model google/gemini-2.5-flash`, or a saved login default.
See [Models and authentication](CLI.md#models-and-authentication) for precedence and defaults.


## Write a workflow

`greet.md`

````markdown
---
extension: semantic-prompt-language
version: 1
---

# Greeting

```spl
let name = $args[0]
if name == None:
    name = 'world'
```

> Write a one-line greeting for @name and return it with @success
````

```bash
spl greet.md --arg Ada
```

## Document structure

* **Frontmatter** must declare `extension: semantic-prompt-language` and `version: 1`.
  Optional `model` sets the default model; optional `preamble` is added to every model request.
  Unknown fields are errors.
* **`spl` fences** are complete SPL units; a block or statement cannot span two fences.
* **Blockquotes** are natural-language steps; see [Natural language & models](LLM-commands.md#blockquotes).
* **Everything else** (headings, prose, other code fences) is commentary.

Fences and blockquotes run in document order in one shared scope. Indented SPL blocks create
lexical child scopes. Blocks use `:` plus a newline and exactly four spaces per level, with `pass` for
an empty body. Use `object:` for dictionaries (`object()` when empty); old braces and inline suites
are no longer accepted. See the [typing migration guide](Migration.md) and
[block syntax and migration](Language.md#block-syntax-and-migration).
`success`, `fail` and a top-level `return`
end the whole document.

## The iteration loop

```bash
spl flow.md --check               # frontmatter and syntax, no model
spl flow.md --trace run.jsonl     # record an append-only execution history
spl flow.md --trace run.jsonl     # resume automatically, or replay the completed run
spl flow.md --trace next.jsonl    # start a fresh run
```

Replay needs the same model requests in the same order. After changing a prompt, record a new
trace. Explicit tool calls still run during replay; see [traces and replay](CLI.md#traces-and-replay).


## VS Code extension

Install from Marketplace: **[SPL](https://marketplace.visualstudio.com/items?itemName=spl-lang.spl-lang-vscode)**

The extension in `vscode/` adds parser/type-checker diagnostics, completions, hover, go to
definition (F12), references (Shift+F12), safe rename (F2), signature help, document symbols,
open-document workspace symbol search, folding and semantic highlighting. It supports workflow
Markdown, standalone `.spl` editor files and SPL notebook cells; ordinary Markdown keeps its
normal language behavior. Type `splworkflow` for a new workflow document. SPL fences and `@name`
markers are highlighted in the editor, and SPL fences also receive Markdown preview highlighting.

In the Markdown text editor, navigation and rename share top-level declarations across SPL
fences and blockquote references, while respecting inner lexical scopes. Raw strings, escaped
interpolations and commentary are not rewritten. Rename rejects identifier conflicts and
reference capture. The language server only analyzes source and never calls models or tools.

Static analysis does not infer names introduced by natural-language actions or dynamic member
types. References and rename stay inside the current document; workspace symbols cover open
documents only. Notebook analysis is per cell, independent of shared runtime execution state.
Use the Markdown text editor for static navigation across fences. The CLI still runs Markdown
workflows, not standalone `.spl` scratch files.
See the [extension guide](../vscode/README.md#language-server) for features, shortcuts,
analysis boundaries and development instructions.

Or install from repository:

```bash
cd vscode
npm install
npm run package
code --install-extension spl-lang-vscode-1.13.1.vsix
```

## Run the tests

```bash
cd lang
npm test
```

Tests are offline. To include authenticated live tests in PowerShell, run
`$env:SPL_LIVE_TESTS='1'; npm test`, then remove the variable.
