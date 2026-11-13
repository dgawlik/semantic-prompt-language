<img src="icon.png" alt="SPL logo" width="128" height="127">

# SPL - Semantic Prompt Language for VS Code

Editing and running executable SPL workflows: Markdown files whose `js` and `ts` fences are
native JavaScript with the `spl-lang` library in scope, and whose blockquotes are agent commands.
Language features turn on when a Markdown file's frontmatter declares
`extension: semantic-prompt-language`; other Markdown files keep their normal behavior.
[`.spl` files](#spl-files) hold the same workflows as blocks and get the same features, with
coloring for the whole file.

## Features

* **JavaScript IntelliSense inside fences.** Completions, hover, signature help, **Go to
  Definition**, **Find All References**, reference highlighting, **Rename Symbol** and document
  symbols come from the TypeScript language service, the same engine VS Code uses for `.js` and
  `.ts` files. The library (`ask`, `agent`, `restrict`, `struct`, ...) is declared as globals with
  its documentation, so nothing needs to be imported.
* **One scope across fences.** A name declared at the top level of one fence completes, resolves
  and renames in every other fence of the document, and in blockquote `@name` references.
* **Imports.** `node:` modules, local `.js`/`.ts` files and packages complete and navigate.
  Relative imports resolve against the workspace folder, like running `spl` from its root.
* **Diagnostics** as you type: frontmatter and `@CTL`/`@CODEGEN` errors, JavaScript syntax
  errors exactly as the runtime compiles them, relative imports that do not exist, and
  TypeScript errors inside `ts` fences.
* **Blockquotes.** `@` completes shared variables and functions declared above the blockquote,
  names saved by earlier blockquotes, library functions an agent can call, and the markers
  `@CTL`, `@CODEGEN`, `@validate`, `@success`, `@fail`, `@env.NAME` and `@args`.
  `@validate[` completes declared types. Inside `@CTL(...)`, settings, restriction keys and
  reasoning values complete; `model=` offers the document's frontmatter model. Hover explains
  markers and settings; definition, references and rename work from a `@name`.
* **Agent outputs become variables.** Names an instruction saves, written as `save to @invoice`,
  `save it to @summary`, `-> @result`, `into @plan` or `@joke = ...`, are declared for later
  fences. With `@validate[Invoice] save to @invoice`, `invoice` has the type parsed by `Invoice`,
  so `invoice.` completes its fields; otherwise the type is `any`.
* **Highlighting.** Fence code is colored by VS Code's built-in JavaScript and TypeScript
  grammars. The extension colors blockquote instructions, `@name` references, and the settings,
  keys and strings of `@CTL(...)` and `@CODEGEN`. Blockquote coloring also applies to ordinary
  Markdown files.
* **`.spl` files.** Whole-file coloring, JavaScript IntelliSense in `{js}` and `{ts}` blocks,
  `@name` completion in `{agent}` blocks and completion of tag settings; see [.spl files](#spl-files).
* **Snippets**: `splworkflow` for a new document and `splctl` for blockquote controls; in `.spl`
  files, `splworkflow` and `splagent`.
* **Native notebooks** for workflow Markdown: run fences and blockquotes as cells in one
  session, with streamed model responses, results, brief live logs and errors in cell outputs.
* **Copilot inline context** for notebook code cells: the library's functions and a checked
  example are supplied to Copilot's inline suggestions, so ghost text uses `await ask(...)`,
  the type builder and `success(...)` correctly. Requires a Copilot version exposing context
  provider API v1; registration status appears in **Output > SPL Language Server**. Copilot
  decides whether to use the context, and no additional model calls are made.

The language server only reads source: it never runs workflows, calls tools or contacts models.
Notebook execution is explicit and requires a trusted workspace. Language server errors appear
in **Output > SPL Language Server**; execution logs appear in **Output > SPL Notebook**.

## How fences get JavaScript IntelliSense

For each workflow document the language server builds a virtual module: the document's text with
everything except fence code blanked out, so every position in a fence is the same position in
the module. The module is given to a TypeScript language service whose program also contains
`globals.d.ts` from `spl-lang`, the declarations of every library function as ambient globals.

* The virtual module lives in the working directory, so relative imports and `node_modules`
  resolve the way the runtime resolves them. The working directory is the workspace folder that
  contains the file, or the file's folder when there is none.
* `spl-lang`, `spl-lang/markdown` and `spl-lang/globals` resolve to declarations bundled with the
  extension. TypeScript's standard library and Node.js typings are bundled too, and a
  workspace's own `@types/node` takes precedence.
* A document with only `js` fences is analyzed as JavaScript: full completions and navigation,
  no type errors. When any fence is `ts`, the document is analyzed as TypeScript and type errors
  are reported inside the `ts` fences.
* Names saved by blockquote agents are appended to the module as declarations, which is how a
  later fence knows `invoice` exists and what type `@validate[Invoice]` gives it.

| Action | Default VS Code shortcut |
| --- | --- |
| Go to Definition | F12 |
| Find All References | Shift+F12 |
| Rename Symbol | F2 |
| Parameter hints | Ctrl+Shift+Space |
| Document symbols | Ctrl+Shift+O |

macOS uses Cmd instead of Ctrl for the shortcuts above. Rename changes names declared in the
workflow itself, including their `@name` markers; library names, imported names and names in
other files are not renamed. Ranges use UTF-16 positions and preserve CRLF documents.

### Analysis limits

* Editing does not execute code, read runtime values, inspect the environment, invoke tools or
  contact model providers.
* The runtime lets a later fence declare a top-level name again. The analysis sees one module,
  so in `ts` fences TypeScript reports such a redeclaration; `js` fences are not type-checked.
* Blockquote output inference recognizes the explicit save and arrow conventions above, not
  arbitrary prose, and cannot guarantee that the agent creates the value. `@validate[Type]`
  types an output only when `Type` is declared in a fence.
* In a blockquote, `@` offers fence declarations above it; fences below have not run yet.
* References and rename stay inside the document.
* Fences marked `ignore` or `no-run`, and fences in other languages, are not analyzed.

## .spl files

A `.spl` file is a workflow written as blocks instead of Markdown: `{js}` and `{ts}` for code,
`{agent ...}` for agent commands with their settings in the tag, `{codegen}` for generated
functions and `{comment}` for commentary. The [language guide](../docs-template/Language.md#dedicated-spl-files)
describes the format. The extension registers the `spl` language for these files; no
frontmatter is needed to turn the features on.

* **Coloring for the whole file.** Frontmatter is colored as YAML and `{js}` and `{ts}` blocks
  by VS Code's JavaScript and TypeScript grammars, so comment toggling, bracket matching and
  snippets inside them are those of the embedded language. Tags, the settings of `{agent}` and
  `{codegen}` tags, instructions, `@name` references and `@validate[Type]` have their own
  colors, `{comment}` blocks are comments and a `{lock}` journal is JSON. A block ends at its
  closing tag even while the code inside it is unfinished.
* **Code blocks** behave like fences: completions, hover, signature help, definition,
  references, rename and document symbols across all blocks, JavaScript syntax errors as the
  runtime reports them, missing relative imports, and type errors in `{ts}` blocks.
* **Agent blocks.** `@` completes shared variables and functions declared above, names saved
  by earlier agents, library functions an agent can call and the markers `@validate`,
  `@success`, `@fail`, `@env.NAME` and `@args`; `@validate[` completes declared types. Names an
  instruction saves are declared for later blocks, typed through `@validate[Type]`.
* **Tags.** Inside `{agent ...}` and `{codegen ...}`, settings, restriction kinds and reasoning
  values complete, and `model=` offers the frontmatter model. Hover explains tags and settings.
  Between blocks, typing `{` offers the blocks with their closing tags.
* **Diagnostics** cover the structure as well: text outside blocks, unknown or unterminated
  blocks, invalid tag settings, and `@CTL` or `@CODEGEN` markers, which a `.spl` file writes as
  tags.
* **Folding** follows the blocks.

A tag that is still being typed ends before the next closing tag, so the blocks below it stay
analyzed. `{js ignore}` and `{ts no-run}` blocks are colored but not analyzed. Notebooks open
Markdown workflows only.

## Notebook workflows

1. Open a workflow `.md` file and run **SPL: Open as Notebook**, or use **Reopen Editor With... >
   SPL Workflow Notebook**. Ordinary Markdown stays in its normal editor by default.
2. Select **SPL Runtime** as the kernel. `js` fences become JavaScript code cells and `ts`
   fences TypeScript code cells; top-level blockquotes become executable code cells with the
   **Markdown** language. Instruction cells show plain text without the outer `>` markers; those
   markers are restored on save. Commentary remains rendered, editable Markdown.
3. Use the cell Run button or VS Code's notebook shortcuts to execute any cell. A final expression
   or `success(value)` displays its value; objects and arrays are indented. `log(...)`
   messages and model replies appear beneath the cell. Model replies update live in place, including
   available reasoning by default (`hide: true` suppresses reasoning); completion replaces the
   preview with the authoritative response. Interrupted previews are marked explicitly and do not
   become successful results. A separate live log output shows cell progress, runtime information,
   warnings and errors, keeping the last 20 lines and at most 4,000 characters, with a truncation
   notice when older content is omitted. Full logs stay in **Output > SPL Notebook**.
4. To add an instruction cell, insert a **code** cell, switch its language to **Markdown**, and
   enter an instruction such as `Double @count.`. Blank lines and Markdown inside the instruction
   are supported; the whole cell is saved as a blockquote automatically. Use a normal **Markdown**
   cell for non-executable notes. Instructions such as `Invoke @factorial with 15 as argument -> @fact15`
   belong in these Markdown-language code cells; in a JavaScript cell write
   `const fact15 = factorial(15);` instead.
5. Save normally: the file remains executable Markdown, not `.ipynb`. Frontmatter, commentary,
   and unchanged fences are preserved, including CRLF/BOM. Edit document `model` and `preamble`
   settings by reopening the saved file in the text editor.

Each open notebook has an isolated worker process holding its variables, objects and function
closures. Cells run sequentially in the order you request, **not** document order; reruns
use the current state without replaying earlier cells. A name that no executed cell has defined
is a `ReferenceError`, reported as `runtime_error`. A failure retains assignments already
performed, as in Jupyter. Changing or deleting source does not undo its previous execution;
rerun the cell or reset the session. Natural-language cells execute tool calls one at a time and
return their real results to the same model conversation; no new action starts after a failure.
Syntax errors are highlighted while editing, and runtime failures point to the responsible cell,
including the cell that defined a failing function. Rerun an edited function definition before
its failure location can be highlighted again.

Code cells are ordinary JavaScript and TypeScript cells, so VS Code's own language support
provides completions inside them; the extension adds completions and hover for the library
names. Each code cell is analyzed on its own: names from other cells are not known to the
editor, although they exist at run time. Instruction cells complete `@` with names declared by
earlier code cells, names saved by earlier instruction cells (`save ... to @x`, `-> @x`,
`@x =`), markers and `@CTL` settings. For navigation and rename across fences, use the
Markdown text editor.

**SPL: Reset Notebook Session** (also in the notebook toolbar), closing the notebook, reloading
VS Code, or stopping a running cell clears shared state. Stop terminates the worker, including
endless loops; rerun prerequisite cells afterward. Existing outputs may describe the old
session and are not saved to the Markdown file. Sessions never run automatically on open.

The working directory of a notebook session is the workspace folder that contains the notebook
(the notebook's own folder for a loose file), the same base the editor uses for imports: imports
and relative tool paths resolve against it. As on the CLI, `spl-lang` and `spl-lang/markdown`
imported by a cell or by a helper module resolve to the running runtime, so helpers need no
local install. Workflows can modify files, run commands
and contact external services when explicitly executed; only run trusted workflows.
Human input (`human` and an agent's `ask_human`), script arguments, `--trace`, `--pin` and MCP
configuration remain CLI features.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `spl.notebook.nodePath` | `node` | Node.js executable used for notebook sessions. Set an absolute path when `node` on `PATH` is older than 24.15.0 |

Workflow cells run as native JavaScript and need Node.js >=24.15.0; cells without model calls
run offline. Model calls use the CLI's provider configuration: `spl login openai`,
`spl login anthropic` or `spl login google`, or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY` (`GOOGLE_API_KEY` / `GEMINI_API_KEY` also work). With multiple
providers, use the saved login default, `SPL_PROVIDER`, or a document model such as
`anthropic/claude-sonnet-4-5`. Environment keys override saved keys. Restart VS Code after
changing its inherited environment.

## Removed in 2.0

SPL 2.0 replaced the custom SPL language with JavaScript, and the extension followed:

* The 1.x `.spl` language, its TextMate grammar, language configuration and snippets are gone.
  `spl` fences are reported as errors with a migration hint. The `.spl` extension now names the
  [block format](#spl-files) for JavaScript workflows.
* The custom parser and type checker behind diagnostics, completions, semantic highlighting and
  folding were replaced by the TypeScript language service; fence coloring is VS Code's own.
* The Markdown preview highlighter for SPL fences was removed; the preview highlights `js`
  fences itself.
* Notebook code cells are JavaScript or TypeScript cells rather than SPL cells.

See the [migration guide](../docs-template/Migration.md) for the language changes.

## Install

Requires VS Code 1.82+. To build from a checkout, install the `lang` dependencies first, then run
in `vscode/`:

```sh
npm install
npm run package
code --install-extension spl-lang-vscode-2.0.0.vsix
```

For development, open this folder and press F5 to start an Extension Development Host.

## Develop

```sh
npm run build
npm run typecheck
npm test
```

* `src/extension.ts` starts the client and registers notebooks; `src/server.ts` is the language
  server.
* `src/workflow.ts` analyzes a document: fences, blockquote markers, names saved by agents and
  the virtual module text. It reuses `compileCell`, `parseNatural`, `extractMarkdown` and, for
  `.spl` files, `scanSpl` from `../lang/src`, bundled into `out/` by `build.mjs`.
* `src/typescriptService.ts` keeps one TypeScript language service per working directory and
  resolves `spl-lang` to the bundled declarations.
* `src/languageFeatures.ts` maps editor requests to the TypeScript service and to blockquote
  features; `src/blockquoteFeatures.ts` scans and completes `@CTL(...)` and the settings of
  `.spl` tags.
* `src/catalog.ts` holds the library names and help shown in blockquotes and notebook cells; it
  must match `library()` in `../lang/src/library.ts`.
* `src/copilotContext.ts` supplies the notebook library context to Copilot inline completions.
* `src/notebook.ts` registers the serializer, controller, diagnostics and session lifecycle;
  `src/notebookFormat.ts` round-trips Markdown and compiles individual cells;
  `src/notebookKernel.ts` manages isolated processes; `src/notebookWorker.ts` runs cells with
  `ExecutionSession`; `src/notebookLanguageFeatures.ts` adds completions and hover in cells.
* `build.mjs` also copies the declarations the server gives to TypeScript into `out/spl-types`,
  `out/ts-lib` and `out/types`.
* `syntaxes/markdown.tmLanguage.json` is the blockquote injection grammar and
  `syntaxes/spl.tmLanguage.json` the grammar of `.spl` files, whose brackets and folding are in
  `language-configuration.json`; `test/` covers the language server, the notebook format and UI,
  and both grammars against every example.
