# SPL - Semantic Prompt Language for VS Code

Language support for executable SPL Markdown workflows. Features turn on for `.md` files whose
frontmatter declares `extension: semantic-prompt-language`; other Markdown is left alone.

## Features

* **Diagnostics** from the interpreter's own parser, updated as you type.
* **Completions** for keywords, built-ins, tools, modifiers, `$env`/`$args`, visible bindings, and
  `@name` references in blockquotes.
* **Hover**, **Go to Definition** and **document symbols** that follow SPL's lexical scopes.
* **Highlighting** for `spl` fences, `@name` markers in blockquotes, and `spl` fences in the Markdown preview.
* **Snippets**: `splworkflow` for a new document, plus `ask`, `askschema`, `agent`, `restrict`, `try`,
  `retry`, tools and control flow inside fences.

The language server only reads source: it never runs workflows, calls tools or contacts models.
Errors appear in **Output > SPL Language Server**.

## Install

Requires VS Code 1.82+. To build from a checkout (Node.js 20+), run in `vscode/`:

```
npm install
npm run package
code --install-extension spl-lang-vscode-1.0.0.vsix
```

For development, open this folder and press F5 to start an Extension Development Host.

## Develop

```
npm run build
npm run typecheck
npm test
```

* `src/extension.ts` starts the client; `src/server.ts` is the language server (IPC or `--stdio`).
* `src/features.ts` uses the parser from `../lang/src`, bundled into `out/` by `build.mjs`.
* `src/markdownPreview.ts` highlights `spl` fences in the Markdown preview.
* Tests cover the language server, TextMate scope assertions in `test/*.spl`, and tokenizing every
  file in `../lang/examples`.

When the language changes, update `syntaxes/spl.tmLanguage.json` together with the
[grammar](https://github.com/dgawlik/semantic-prompt-language/blob/HEAD/docs-template/Grammar.md).
Keep links outside this folder absolute so they work on the Marketplace.