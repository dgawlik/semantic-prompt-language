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

* **Native notebooks** for existing workflow Markdown: edit SPL fences and natural-language
  blockquotes as runnable cells, with rendered commentary, execution counts, formatted results,
  and errors in cell outputs and the Problems panel.

The language server only reads source: it never runs workflows, calls tools or contacts models.
Notebook execution is explicit and requires a trusted workspace. Language server errors appear
in **Output > SPL Language Server**; execution logs appear in **Output > SPL Notebook**.

## Notebook workflows

1. Open a workflow `.md` file and run **SPL: Open as Notebook**, or use **Reopen Editor With... >
   SPL Workflow Notebook**. Ordinary Markdown stays in its normal editor by default.
2. Select **SPL Runtime** as the kernel. Existing `spl` fences become SPL code cells;
   top-level blockquotes become executable code cells with the **Markdown** language. Commentary
   remains rendered, editable Markdown.
3. Use the cell Run button or VS Code's notebook shortcuts to execute any cell. A final expression,
   `return`, or `success` displays its value; objects and lists are indented. Explicit `log(...)`
   messages and final natural-language replies appear beneath the cell. Full runtime logs are
   kept in the output channel, not mixed into the result.
4. To add an instruction cell, insert a **code** cell, switch its language to **Markdown**, and
   enter a blockquote such as `> Double @count.`. Unquoted text in such a cell is also saved as a
   blockquote. Use a normal **Markdown** cell for non-executable notes.
5. Save normally: the file remains executable Markdown, not `.ipynb`. Frontmatter, commentary,
   and unchanged fences are preserved, including CRLF/BOM. Edit document `model` and `preamble`
   settings by reopening the saved file in the text editor.

Each open notebook has an isolated worker process holding its variables, mutable objects, and
function closures. Cells run sequentially in the order you request, **not** document order; reruns
use the current state without replaying earlier cells. Undefined dependencies are reported as
runtime errors. A failure retains assignments already performed, as in Jupyter. Changing or
deleting source does not undo its previous execution; rerun the cell or reset the session.
Natural-language cells hand queued runtime actions back immediately instead of waiting for a
post-tool model reply. When MCP tools are configured, the turn finishes normally so external
calls can complete and their results are retained.
Syntax errors are highlighted while editing, and runtime failures point to the responsible cell
(including previously defined functions). Edited function definitions must be rerun before their
old failure location can be highlighted again.

**SPL: Reset Notebook Session** (also in the notebook toolbar), closing the notebook, reloading
VS Code, or stopping a running cell clears shared state. Stop terminates the worker, including
infinite SPL loops; rerun prerequisite cells afterward. Existing outputs may describe the old
session and are not saved to the Markdown file. Sessions never automatically run on open.

The worker uses `node` from PATH; set **spl.notebook.nodePath** to an absolute Node.js executable
if needed. Deterministic cells run offline. Copilot model calls require Node.js 20.19+ or 22.12+,
and the same Copilot credentials as the CLI (`spl login` or supported environment credentials).
Relative tool paths resolve beside the notebook file. Workflows can modify files, run commands,
and contact external services when explicitly executed; only run trusted workflows. Checkpointed
`human` input, record/replay, and custom MCP configuration remain CLI features.

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
* `src/notebook.ts` registers the native serializer, controller, diagnostics and session lifecycle.
* `src/notebookFormat.ts` roundtrips Markdown and parses individual executable cells.
* `src/notebookKernel.ts` manages isolated processes; `src/notebookWorker.ts` runs the interpreter.
* Tests cover the language server, TextMate scope assertions in `test/*.spl`, and tokenizing every
  file in `../lang/examples`, plus notebook Markdown roundtrips, shared state, formatted outputs,
  error locations and cancellation of infinite loops.

When the language changes, update `syntaxes/spl.tmLanguage.json` together with the
[grammar](https://github.com/dgawlik/semantic-prompt-language/blob/HEAD/docs-template/Grammar.md).
Keep links outside this folder absolute so they work on the Marketplace.