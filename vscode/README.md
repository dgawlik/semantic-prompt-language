<img src="icon.png" alt="SPL logo" width="128" height="127">

# SPL - Semantic Prompt Language for VS Code

Language support for executable SPL Markdown workflows, standalone `.spl` editor documents, and
SPL notebook code cells. Markdown language features turn on only when frontmatter declares
`extension: semantic-prompt-language`. Syntax highlighting for SPL fences and blockquotes is also
available in other Markdown files.

## Features

* **Diagnostics** from the interpreter's own parser and static type checker, updated as you type.
* **Completions** for keywords, built-ins, tools, modifiers, `$env`/`$args`, visible bindings, and
  `@name` references in blockquotes.
  `ask(...)` includes sampling modifier help for `seed`, `temperature`, and `top_p`;
  `think` and `agent` keep their existing modifiers.
* **Copilot inline context** for SPL notebook code cells: native syntax rules and parser-checked
  examples guide AI ghost-text suggestions toward SPL colon-and-indentation blocks, `let`
  declarations and model calls
  instead of Python. Requires a Copilot version exposing context provider API v1; registration
  status appears in **Output > SPL Language Server**. Copilot decides whether to use the supplied
  context, so AI suggestions can still need correction. This does not replace Copilot, make
  additional model calls, or change suggestions in Python or Markdown instruction cells.
* **Hover**, **Go to Definition**, **Find All References**, **reference highlighting** and
  **Rename Symbol** that follow SPL's lexical scopes, including function parameters, loop and
  exception bindings, string interpolations, and blockquote `@name` references.
* **Signature help** for declared functions, annotated parameters, built-in overloads and
  model-call modifiers; nested calls and collection arguments keep their own argument positions.
* **Document symbols** for variables, functions, enums, structs, classes and declared fields,
  plus **workspace symbol search** across documents currently open in the language server.
* **Folding** for indentation suites, `object:` blocks, multiline strings and parenthesized/list
  expressions, SPL fences and natural-language blockquotes.
* **Semantic highlighting** distinguishes declarations, parameters, functions, named types,
  modifier names and read-only special variables. TextMate highlighting still supplies strings,
  numbers, comments and ordinary Markdown.
* **Highlighting** for `spl` fences, colored blockquote instructions, and contrasting `@name`
  references only inside blockquotes. Instructions use the theme's string color; references use
  its variable color (or the default text color for themes without a variable color). Ordinary
  prose and fenced examples do not receive blockquote/reference highlighting. `spl` fences are
  also highlighted in the Markdown preview.
* **Snippets**: `splworkflow` for a new document, plus `ask`, `askschema`, `agent`, `restrict`, `try`,
  `retry`, tools and control flow inside fences.

* **Native notebooks** for existing workflow Markdown: edit SPL fences and natural-language
  blockquotes as runnable cells, with rendered commentary, execution counts, formatted results,
  streamed model responses, brief live runtime logs, and errors in cell outputs and the Problems panel.

The language server only reads source: it never runs workflows, calls tools or contacts models.
Notebook execution is explicit and requires a trusted workspace. Language server errors appear
in **Output > SPL Language Server**; execution logs appear in **Output > SPL Notebook**.

## Language server

In a workflow text editor, all SPL fences share top-level declarations in document order.
For example, in `lang/examples/extract-invoice.md`, **Go to Definition** on `@document` reaches
`let document = read_file(path)` in the preceding fence. Renaming `document` updates that
declaration and its blockquote reference, without changing prose or dictionary string keys.
Inner `let` declarations shadow outer ones only inside their indentation suite; a fence closes
its inner scopes before the next instruction or fence.

| Action | Default VS Code shortcut |
| --- | --- |
| Go to Definition | F12 |
| Find All References | Shift+F12 |
| Rename Symbol | F2 |
| Parameter hints | Ctrl+Shift+Space |
| Document symbols | Ctrl+Shift+O |
| Open-document workspace symbols | Ctrl+T |

macOS uses Cmd instead of Ctrl for the shortcuts above.
Reference highlights distinguish declarations/assignments from reads. Rename edits include the
document version when supported by the client and reject invalid identifiers, keywords, built-ins,
same-scope conflicts, and changes that would capture or shadow another reference. Members,
built-ins, special variables and unresolved names are not lexical rename targets. Escaped
interpolation braces, raw strings, ordinary prose, escaped `@@name` and email addresses are not
rewritten. Ranges use UTF-16 positions and preserve CRLF documents.

### Static-analysis boundaries

* Editing does not execute source, read runtime variable values, inspect environment contents,
  invoke tools, or contact model providers. Diagnostics report the first parser/type-checker
  failure; unknown untyped values do not acquire speculative runtime errors.
* Natural-language steps can create or mutate values at runtime. Names introduced only by those
  steps (such as `@invoice` in the invoice example) are not inferred as static declarations.
  Member access, dynamic dictionary keys and callable values do not have inferred navigation or
  signatures; fields and methods still appear in the outline.
* References and rename are document-local. Workspace symbol search indexes open documents only;
  it does not scan files on disk or invent cross-file imports.
* Notebook language analysis is per code cell, not a model of the kernel's execution history.
  Shared cross-cell state is available when running the notebook, but static cross-fence
  navigation is available in the Markdown text editor. Markdown instruction cells without
  workflow frontmatter remain outside the Markdown language-server analysis.
* Standalone `.spl` files are editor/scratch documents. The CLI and notebook workflow format
  remains executable Markdown with frontmatter. Incomplete lexical input can limit navigation;
  parser diagnostics and static keyword/tool completions remain available.

## Block syntax migration

**Breaking change:** replace block braces with `:` followed by a newline and an indented nonempty
body. Use exactly four spaces per level; indentation tabs, inline suites, unexpected indentation and
dedents that do not match a prior level are syntax errors. Use `pass` for an otherwise empty body.
Blank and comment-only lines are ignored for indentation. Semicolons separate simple statements
only. Dictionary braces are removed: use `object:` entries or `object()` when empty.
Interpolation `{expr}` and JSON wire braces are unchanged; newlines inside `()` and `[]` suspend
ordinary indentation, while explicit object blocks delimit entries. Explicit `\` continuation still works.
Highlighting, snippets and navigation support enum/struct/class declarations, typed bindings,
annotated functions, `fn(T) -> R`, `list[T]` and unions. See the
[manual typing migration guide](../docs-template/Migration.md).

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
   messages and model replies appear beneath the cell. Model replies update live in place, including
   available reasoning by default (`hide=True` suppresses reasoning); completion replaces the preview with the authoritative response.
   Different requests and response/reasoning channels are kept separate, and an identical final cell result
   is not appended again. Interrupted previews are marked explicitly and do not become successful results.
   A separate live log output
   shows cell progress, runtime information, warnings and errors, keeping the last 20 lines and
   at most 4,000 characters, including a truncation notice when older content is omitted.
   Full AI transcripts and variable-state changes stay in **Output > SPL Notebook**.
   Automatic executed-source traces are not emitted.
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
Natural-language cells execute runtime actions sequentially and return their real results to the
same model conversation. Actions can finish without final prose; unexpected aborts and backend
errors are still reported, and no new action starts after a failure.
Syntax errors are highlighted while editing, and runtime failures point to the responsible cell
(including previously defined functions). Edited function definitions must be rerun before their
old failure location can be highlighted again.

**SPL: Reset Notebook Session** (also in the notebook toolbar), closing the notebook, reloading
VS Code, or stopping a running cell clears shared state. Stop terminates the worker, including
infinite SPL loops; rerun prerequisite cells afterward. Existing outputs may describe the old
session and are not saved to the Markdown file. Sessions never automatically run on open.

The worker uses `node` from PATH; set **spl.notebook.nodePath** to an absolute Node.js executable
if needed. The external SPL runtime requires Node.js >=24.15.0; deterministic cells run offline.
Model calls use the CLI's official OpenAI, Anthropic and Google clients and provider configuration: `spl login openai`, `spl login anthropic`
or `spl login google`, or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
(`GOOGLE_API_KEY` / `GEMINI_API_KEY` also work). With multiple providers, use the saved login default,
`SPL_PROVIDER`, or a document model such as `anthropic/claude-sonnet-4-5`. Environment keys override
saved keys. Restart VS Code after changing its inherited environment.
The notebook worker does not load BetterTUI or acquire terminal input; this does not change the
VS Code extension-host requirement.
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
* `src/languageFeatures.ts` reuses the same lexical binding resolution for references, safe rename,
  highlights, signatures, folding, semantic tokens and open-document workspace symbols.
* `src/markdownPreview.ts` highlights `spl` fences in the Markdown preview.
* `src/notebook.ts` registers the native serializer, controller, diagnostics and session lifecycle.
* `src/notebookFormat.ts` roundtrips Markdown and parses individual executable cells.
* `src/notebookKernel.ts` manages isolated processes; `src/notebookWorker.ts` runs the interpreter.
* Tests cover language features and the actual server over IPC and stdio, including incremental
  edits, versioned/unversioned rename, rejected captures, Markdown gating, UTF-16/CRLF positions,
  capability registration, close cleanup and shutdown. They also cover TextMate scope assertions in `test/*.spl`, and tokenizing every
  file in `../lang/examples`, plus notebook Markdown roundtrips, shared state, formatted outputs,
  error locations and cancellation of infinite loops.

When the language changes, update `syntaxes/spl.tmLanguage.json` together with the
[grammar](https://github.com/dgawlik/semantic-prompt-language/blob/HEAD/docs-template/Grammar.md).
Keep links outside this folder absolute so they work on the Marketplace.