# SPL - Semantic Prompt Language for VS Code

Language support for executable SPL Markdown workflows. Features turn on for `.md` files whose
frontmatter declares `extension: semantic-prompt-language`. Syntax highlighting for SPL fences
and blockquotes is also available in other Markdown files.

## Features

* **Diagnostics** from the interpreter's own parser, updated as you type.
* **Completions** for keywords, built-ins, tools, modifiers, `$env`/`$args`, visible bindings, and
  `@name` references in blockquotes.
* **Copilot inline context** for SPL notebook code cells: native syntax rules and parser-checked
  examples guide AI ghost-text suggestions toward SPL colon-and-indentation blocks, `let`
  declarations and model calls
  instead of Python. Requires a Copilot version exposing context provider API v1; registration
  status appears in **Output > SPL Language Server**. Copilot decides whether to use the supplied
  context, so AI suggestions can still need correction. This does not replace Copilot, make
  additional model calls, or change suggestions in Python or Markdown instruction cells.
* **Hover**, **Go to Definition** and **document symbols** that follow SPL's lexical scopes.
* **Highlighting** for `spl` fences, colored blockquote instructions, and contrasting `@name`
  references only inside blockquotes. Instructions use the theme's string color; references use
  its variable color (or the default text color for themes without a variable color). Ordinary
  prose and fenced examples do not receive blockquote/reference highlighting. `spl` fences are
  also highlighted in the Markdown preview.
* **Snippets**: `splworkflow` for a new document, plus `ask`, `askschema`, `agent`, `restrict`, `try`,
  `retry`, tools and control flow inside fences.

* **Native notebooks** for existing workflow Markdown: edit SPL fences and natural-language
  blockquotes as runnable cells, with rendered commentary, execution counts, formatted results,
  brief live runtime logs, and errors in cell outputs and the Problems panel.

The language server only reads source: it never runs workflows, calls tools or contacts models.
Notebook execution is explicit and requires a trusted workspace. Language server errors appear
in **Output > SPL Language Server**; execution logs appear in **Output > SPL Notebook**.

## Block syntax migration

**Breaking change:** replace block braces with `:` followed by a newline and an indented nonempty
body. Use spaces (4 recommended); indentation tabs, inline suites, unexpected indentation and
dedents that do not match a prior level are syntax errors. Use `pass` for an otherwise empty body.
Blank and comment-only lines are ignored for indentation. Semicolons separate simple statements
only. Dictionaries `{...}` and interpolation `{expr}` are unchanged; newlines inside `()`, `[]`
and dictionaries remain insignificant, and explicit `\` continuation still works.

Despite the Python-like layout, every block remains a lexical child scope: `let` declares locally,
and assignment updates the nearest existing declaration. Anonymous value blocks begin with a bare
colon. See the [language reference](https://github.com/dgawlik/semantic-prompt-language/blob/HEAD/docs-template/Language.md#block-syntax-and-migration).

## Notebook workflows

1. Open a workflow `.md` file and run **SPL: Open as Notebook**, or use **Reopen Editor With... >
   SPL Workflow Notebook**. Ordinary Markdown stays in its normal editor by default.
2. Select **SPL Runtime** as the kernel. Existing `spl` fences become SPL code cells;
   top-level blockquotes become executable code cells with the **Markdown** language. Instruction
   cells show plain text without the outer `>` markers; those markers are restored on save.
   Commentary remains rendered, editable Markdown.
3. Use the cell Run button or VS Code's notebook shortcuts to execute any cell. A final expression,
   `return`, or `success` displays its value; objects and lists are indented. Explicit `log(...)`
   messages and final natural-language replies appear beneath the cell. A separate live log output
   shows cell progress, runtime information, warnings and errors, keeping the last 20 lines and
   at most 4,000 characters, including a truncation notice when older content is omitted.
   AI transcripts, reasoning and per-statement traces stay in **Output > SPL Notebook**.
   Explicit `log(...)` messages, final replies, results and error outputs are not subject to
   this brief-log limit. Full runtime logs remain in the output channel.
4. To add an instruction cell, insert a **code** cell, switch its language to **Markdown**, and
   enter an instruction such as `Double @count.`. Blank lines and Markdown inside the instruction
   are supported; the whole cell is saved as a blockquote automatically. Use a normal **Markdown**
   cell for non-executable notes.
   Instructions such as `Invoke @factorial with 15 as argument -> @fact15` belong in these
   Markdown-language code cells, not SPL cells. In an SPL cell, use exact syntax instead:
   `let fact15 = factorial(15)`. An `unexpected '@' at end of statement` error can mean an
   instruction was entered in an SPL cell; switch its language to **Markdown**.
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
The SDK's abort notification for an intentional action handoff is not an execution failure;
unexpected aborts, failed handoffs and other backend errors are still reported.
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
* `src/copilotContext.ts` supplies SPL notebook syntax context to Copilot inline completions.
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