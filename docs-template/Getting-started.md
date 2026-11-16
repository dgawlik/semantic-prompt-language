# Getting started

Install the CLI, configure OpenAI, Anthropic or Google credentials, then write and refine a workflow in a short edit-run loop.

## Install

Use Node.js >=24.15.0. The terminal view is pure JavaScript ([Ink](https://github.com/vadimdemedes/ink)),
so it runs wherever Node.js does. If it cannot start, the CLI reports the problem and keeps complete plain logs.

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

Workflows without model calls, `spl check`, `spl compile`, `spl doc` and replay need no credentials.

## Write a workflow

`greet.spl`

```spl
//*
# Greeting

Greets the person named by the first argument.
*//

const name = args[0] ?? 'world';

---
outputVar: greeting

Write a one-line greeting for @name.
---

success(greeting);
```

```bash
spl run greet.spl --arg Ada
```

The code is TypeScript and runs top to bottom. The `---` block is an instruction for a model:
`@name` passes the variable in, and `outputVar: greeting` names the constant that receives the
answer. `success` ends the run with a result, which the CLI prints on stdout.

## File structure

* **Markdown comments** between `//*` and `*//` are commentary. They are allowed at the top
  level only, and [`spl doc`](CLI.md#spl-doc) renders them as prose.
* **Blocks** between two `---` lines hold an instruction for a model. A block starts with an
  optional header of `key: value` lines such as `mode`, `model` and `outputVar`. The mode is
  `ask` (the default), `agent` or `codegen`; see [Natural language & models](LLM-commands.md).
* **A block without an instruction** sets [defaults for the whole file](Language.md#file-defaults),
  for example the model. It must be the first thing in the file that is not a comment.
* **Everything else** is TypeScript. Blocks may stand wherever a statement may: at the top
  level, in functions, loops and `if` bodies.

Statements and blocks run in file order. `success(value)` or an uncaught failure ends the run.

## TypeScript in five rules

Workflow code is ordinary TypeScript. These rules cover what is specific to workflows;
[Workflow code](Language.md) explains each one.

1. **The library is already in scope.** `ask`, `agent`, `restrict`, `Struct`, `readFile`,
   `success` and the rest need no `import`. Everything else is imported as usual:
   `import fs from 'node:fs'`, `import { helper } from './helper.js'`.
2. **Types are erased, not checked, when the file runs.** `spl run` strips annotations and
   starts at once. `spl check` type-checks the file with the TypeScript compiler. Only
   syntax that can be erased is allowed: no `enum`, `namespace`, decorators or constructor
   parameter properties.
3. **Always `await`.** Model calls, tools, `human`, `restrict` and `codegen` return promises.
   Top-level `await` works everywhere. A block contains an `await`, so a function that holds
   one must be `async`. A call that is not awaited can crash the process when it fails.
4. **Imports resolve from the file; tool paths from the working directory.** `import` follows
   the ES module rules, relative to the file that contains it. Paths given to `readFile`,
   `writeFile`, `shell` and `restrict` are relative to `--cwd`, by default the folder you run
   `spl` from.
5. **The runtime only governs its own library.** `restrict` and traces cover `readFile`,
   `shell`, agents and MCP tools, not `node:fs` or `fetch` calls made by your code.

## The iteration loop

```bash
spl check flow.spl                    # scan and type-check, no model
spl run flow.spl --trace run.jsonl    # record an append-only execution history
spl run flow.spl --trace run.jsonl    # resume automatically, or replay the completed run
spl run flow.spl --trace next.jsonl   # start a fresh run
spl run flow.spl --debug              # step through blocks and top-level statements
spl doc flow.spl                      # print the workflow as a Markdown document
```

Replay needs the same model requests in the same order. After changing the file, record a new
trace. Recorded model calls, tools and human answers are not repeated during replay; your own
code runs again. See [Traces and replay](CLI.md#traces-and-replay).

## Use the library without a .spl file

The same functions are a normal Node.js package. Install `spl-lang` in a project and import what
you need; see [The library in Node.js programs](Language.md#the-library-in-nodejs-programs).

```ts
import { ask, Enum, Str, Struct } from 'spl-lang';

const Triage = Struct('Triage', { label: Enum('bug', 'feature'), reason: Str });
const triage = await ask('Classify: the app crashes on start', { schema: Triage, repairs: 1 });
console.log(triage.label);
```

A workflow can also become a module: [`spl compile`](CLI.md#spl-compile) writes a TypeScript
file whose default export runs the workflow, and one `.spl` file can
[import another](Language.md#imports-and-modules).

## VS Code extension

Install from Marketplace: **[SPL](https://marketplace.visualstudio.com/items?itemName=spl-lang.spl-lang-vscode)**

The extension in `vscode/` gives `.spl` files a TypeScript editing experience.

* **Syntax coloring.** Code is colored as TypeScript, the text inside `//* ... *//` as Markdown,
  and a block as a YAML header followed by instruction text.
* **Diagnostics, completion and hover.** The extension gives the TypeScript language service
  the same TypeScript that the scanner produces for `spl check`, as a virtual document. Every
  construct stays on its line, so problems appear where you wrote them.
* **`@name` completion** inside blocks.
* **Run and Debug commands** that open a terminal for the file; Debug steps through it like
  [`--debug`](CLI.md#stepping-with---debug).

See the [extension guide](../vscode/README.md) for details.

To install from the repository, build the package and install the `.vsix` file it writes:

```bash
cd vscode
npm install
npm run package
```

## Run the tests

```bash
cd lang
npm test
```

Tests are offline and never contact a model.
