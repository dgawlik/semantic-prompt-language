# Getting started

Install the CLI, sign in to GitHub Copilot, then write and refine a workflow in a short edit-run loop.

## Install

```bash
npm install -g spl-lang
spl login
```

`spl login` reuses existing credentials (Copilot CLI, `gh`, or `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
`GITHUB_TOKEN`). Otherwise it runs GitHub's device flow and saves a token in `~/.spl`
(override with `SPL_HOME`). `spl logout` deletes it. Workflows that never call a model,
`--check` and replay need no login.

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
if name == None {
    name = 'world'
}
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

Blocks run in document order in one shared scope. `success`, `fail` and a top-level `return`
end the whole document.

## The iteration loop

```bash
spl flow.md --check               # frontmatter and syntax, no model
spl flow.md --trace run.jsonl     # live run that records every model call
spl flow.md --replay run.jsonl    # rerun code and guards with the recorded answers
```

Replay needs the same model requests in the same order. After changing a prompt, record a new
trace. Explicit tool calls still run during replay; see [traces and replay](CLI.md#traces-and-replay).

## VS Code extension

Install from Marketplace: [spl](https://marketplace.visualstudio.com/items?itemName=spl-lang.spl-lang-vscode)

The extension in `vscode/` adds parser-backed diagnostics, completions, hover, go to definition,
document symbols, highlighting for `spl` fences and `@name` markers, and Markdown preview
highlighting. Type `splworkflow` for a new document.

Or install from repository:

```bash
cd vscode
npm install
npm run package
code --install-extension spl-lang-vscode-1.5.0.vsix
```

## Run the tests

```bash
cd lang
npm test
```

Tests are offline. To include authenticated live tests in PowerShell, run
`$env:SPL_LIVE_TESTS='1'; npm test`, then remove the variable.
