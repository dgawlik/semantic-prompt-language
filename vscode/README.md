<img src="icon.png" alt="SPL logo" width="128" height="127">

# SPL - Semantic Prompt Language for VS Code

Language support for SPL 3.0 workflows: `.spl` files that interleave natural-language instructions
for models and agents with TypeScript.

```spl
//*
# A joke, checked
*//

---
model: gpt-6-luna
---

const Joke = Struct('Joke', { setup: Str, punchline: Str });
const topic = args[0] ?? 'programmers';

---
outputVar: joke
outputType: Joke

A joke about @topic with a setup and a punchline.
---

success(joke.punchline);
```

A `.spl` file is TypeScript with two extensions: Markdown comments between `//*` and `*//`, and
blocks between two `---` lines, which hold an optional YAML header and an instruction for a model.

## Features

* **Syntax coloring.** Code is colored as TypeScript and the content of `//* ... *//` as Markdown.
  In a block, the header is colored as YAML with the known keys set apart, and in the instruction
  `@name` references, `@@`, outputs (`-> @name`, `->[Type] @name`, `@=name`) and the signatures
  of generated functions stand out; type expressions are colored as TypeScript. A `---` or `//*`
  inside a string, a template literal or a comment is not syntax.
* **TypeScript IntelliSense.** Diagnostics, completions, hover, signature help, **Go to
  Definition**, **Find All References**, reference highlighting, **Rename Symbol**, document
  symbols and folding come from the TypeScript language service. The library (`ask`, `agent`,
  `restrict`, `Struct`, ...) is declared as globals with its documentation, so nothing needs to
  be imported. Files are checked the way `spl check` checks them.
* **Blocks are part of the program.** An unknown `@name`, a wrong type in `->[Type]` or
  `outputType`, and an output that redeclares a variable are reported where they are written.
  Outputs are typed variables in the code below the block: after `->[Int] @count`, `count` is a
  `number`. Definition, references and rename connect code, `@name` references and outputs.
* **Completion inside blocks.** `@` completes the variables and functions in scope at the block,
  and the library; `@=` completes variables that can be assigned. In the header, keys valid for
  the block's mode complete, as do the values of `mode`, `reasoning` and `hide`. After `->[` and
  `outputType:`, the library types and the types declared by the workflow complete.
* **Hover inside blocks** shows the type of an `@name` reference and of a declared output, and
  explains header keys.
* **Problems of the format** are reported as you type: an unmatched `---`, a misspelled or
  misplaced header key, an ask block without `outputVar`, a Markdown comment below the top
  level, 2.x syntax, and TypeScript syntax that cannot be erased (`enum`, `namespace`, ...).
* **Imports.** `node:` modules, packages, JavaScript and TypeScript files and other `.spl` files
  resolve from the importing file. An imported `.spl` file gives its exported declarations and its
  workflow as the default export, also when it is not open in an editor.
* **Run and Debug** start the `spl` command line in a terminal.
* **Snippets**: `ask`, `agent` and `codegen` blocks, `defaults` for the file defaults and `doc`
  for a Markdown comment.

The language server only reads source: it never runs workflows, calls tools or contacts models.
Its errors appear in **Output > SPL Language Server**.

## Commands

| Command | Effect |
| --- | --- |
| **SPL: Run Workflow** | Saves the active `.spl` file and runs `spl run <file>` in the **SPL** terminal |
| **SPL: Debug Workflow** | The same with `--debug`: stops before each block and each top-level statement; `n` runs the next step, `v` shows the variables, `c` continues and `e` exits |

Both are in the Command Palette, in the run button of the editor title, and in the context menus
of the editor and the Explorer for `.spl` files. The terminal is created in the workspace folder
of the file and reused by later runs. Running requires a trusted workspace.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `spl.executablePath` | `spl` | The `spl` executable the commands start: a name on the `PATH`, a full path, or a command such as `npx spl`. Quote a path with spaces the way your shell needs it |

## Requirements

* VS Code 1.82 or later.
* For **Run** and **Debug**: the `spl-lang` package, which needs Node.js 24.15 or later
  (`npm install -g spl-lang`, or a local install with `spl.executablePath` set to `npx spl`).
  Model calls use the configuration of the command line: `spl login openai`,
  `spl login anthropic` or `spl login google`, or the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and
  `GOOGLE_GENERATIVE_AI_API_KEY` environment variables.
* Editing needs nothing else: the scanner, TypeScript and the declarations of the library and of
  Node.js are bundled. A workspace with its own `node_modules/@types/node` uses that version.

## How it works

The front scanner of `spl-lang` turns a `.spl` file into TypeScript that keeps every construct on
its line: code is copied as written, Markdown comments become blank lines, and each block becomes a
call that declares its outputs. The language server gives that TypeScript to a TypeScript language
service as a virtual module beside the file, `flow.spl.ts` for `flow.spl`, together with the
declarations of the library. Positions in code are the same in both; positions inside blocks map
through the spans the scanner records for `@name` references, type expressions and signatures. A
TypeScript error in generated code that has no counterpart in the source is shown on its source
line.

Limits of the analysis:

* Files are type-checked with the options of `spl check`. Imported JavaScript files are typed by
  inference and are not checked themselves.
* `@env.NAME` is checked as a string that may be missing; the names of environment variables are
  not known.
* A relative import that did not resolve is looked up again when the importing file changes.

## Removed in 3.0

SPL 3.0 has one file format, and the extension follows it:

* Markdown workflows are no longer executable: the notebooks for `.md` files, their kernel and
  commands, the Markdown blockquote coloring and the Markdown snippets are gone.
* The 2.x block tags of `.spl` files (`{js}`, `{agent}`, `{codegen}`, `{comment}`) are reported
  with a pointer to the migration guide.

See the [migration guide](../docs-template/Migration.md) for the language changes.

## Install

To build from a checkout, install the `lang` dependencies first, then run in `vscode/`:

```sh
npm install
npm run package
code --install-extension spl-lang-vscode-3.0.0.vsix
```

For development, open this folder and press F5 to start an Extension Development Host.

## Develop

```sh
npm run build
npm run typecheck
npm test
```

* `src/extension.ts` starts the language client and registers the Run and Debug commands, whose
  command line is built by `src/commandLine.ts`; `src/server.ts` is the language server.
* `src/workflow.ts` scans a document with `scan` from `../lang/src/scanner.ts` and maps positions
  between the source and the virtual module.
* `src/typescriptService.ts` holds the TypeScript language service: the virtual modules of open
  documents and of `.spl` files on disk, checked with `CHECK_OPTIONS` from `../lang/src/scanner.ts`.
* `src/languageFeatures.ts` answers editor requests from the TypeScript service;
  `src/blockFeatures.ts` adds what only blocks have: header keys, `@name` references and outputs.
* `src/catalog.ts` holds the help shown for library names in blocks; it must match `library()` in
  `../lang/src/library.ts` and `../lang/globals.d.ts`, which a test enforces.
* `build.mjs` bundles the sources and copies the declarations the server gives to TypeScript into
  `out/spl-types`, `out/ts-lib` and `out/types`.
* `syntaxes/spl.tmLanguage.json` is the grammar; `test/` covers the language server, the grammar
  against targeted snippets and every example in `../lang/examples`, and the command line.
