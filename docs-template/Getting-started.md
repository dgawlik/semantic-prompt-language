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

Workflows without model calls, `--check` and replay need no credentials.

## Write a workflow

`greet.md`

````markdown
---
extension: semantic-prompt-language
version: 1
---

# Greeting

```js
const name = args[0] ?? 'world';
```

> Write a one-line greeting for @name and return it with @success
````

```bash
spl greet.md --arg Ada
```

The fence is JavaScript and runs first. The blockquote is sent to the model as an agent command;
`@name` refers to the variable the fence declared, and `@success` asks the agent to end the run
with a result, which the CLI prints on stdout.

## Document structure

* **Frontmatter** must declare `extension: semantic-prompt-language` and `version: 1`.
  Optional `model` sets the default model; optional `preamble` is added to every model request.
  Unknown fields are errors.
* **`js` fences** (also `javascript` and `mjs`) run as native JavaScript. **`ts` fences**
  (`typescript`, `mts`) have their type annotations erased first. Each fence must be complete
  JavaScript on its own; a statement cannot span two fences.
* **Blockquotes** are natural-language steps run by an agent; see
  [Natural language & models](LLM-commands.md#blockquotes). Every top-level blockquote runs, so
  do not use one for commentary.
* **Everything else** (headings, prose, fences in other languages) is commentary. Add `ignore`
  or `no-run` after the language (` ```js ignore `) to show JavaScript without running it.

Fences and blockquotes run in document order in one shared scope. `success(value)` or an
uncaught failure ends the whole document.

A workflow can also be a [`.spl` file](Language.md#dedicated-spl-files), which holds the same
steps as `{js}`, `{agent}` and `{comment}` blocks instead of fences, blockquotes and prose.

## JavaScript in five rules

Workflow code is ordinary JavaScript. These rules cover what is specific to workflows;
[Workflow code](Language.md) explains each one.

1. **The library is already in scope.** `ask`, `agent`, `restrict`, `struct`, `readFile`,
   `success` and the rest need no `import`. Everything else is imported as usual:
   `import fs from 'node:fs'`, `import { helper } from './helper.js'`.
2. **One shared scope.** Top-level `const`, `let`, `function`, `class` and imports are visible in
   later fences and to blockquote agents. Redeclaring a name in a later fence rebinds it, even
   when it was a `const`.
3. **Always `await`.** Model calls, tools, `human`, `restrict` and `codegen` return promises.
   Top-level `await` works in every fence. A call that is not awaited can crash the process
   when it fails, and a long synchronous loop blocks logs and Ctrl+C until it yields: fences
   run on the main thread.
4. **Paths and imports resolve against the working directory** (`--cwd`, by default the folder
   you run `spl` from), not the folder of the workflow file. `import.meta.url`, `.filename` and
   `.dirname` describe the workflow file.
5. **The runtime only governs its own library.** `restrict`, traces and pins cover `readFile`,
   `shell`, agents and MCP tools, not `node:fs` or `fetch` calls made by your code, and not the
   helper modules you import.

## The iteration loop

```bash
spl flow.md --check               # frontmatter, fences, controls and imports, no model
spl flow.md --trace run.jsonl     # record an append-only execution history
spl flow.md --trace run.jsonl     # resume automatically, or replay the completed run
spl flow.md --trace next.jsonl    # start a fresh run
```

Replay needs the same model requests in the same order. After changing a prompt, record a new
trace. Recorded model calls, tools and human answers are not repeated during replay; your own
JavaScript runs again. See [traces and replay](CLI.md#traces-and-replay).

## Use the library without Markdown

The same functions are a normal Node.js package. Install `spl-lang` in a project and import what
you need; see [the library in Node.js programs](Language.md#the-library-in-nodejs-programs).

```js
import { ask, struct, str, enumOf } from 'spl-lang';

const Triage = struct('Triage', { label: enumOf('bug', 'feature'), reason: str });
const triage = await ask('Classify: the app crashes on start', { schema: Triage, repairs: 1 });
console.log(triage.label);
```

## VS Code extension

Install from Marketplace: **[SPL](https://marketplace.visualstudio.com/items?itemName=spl-lang.spl-lang-vscode)**

The extension in `vscode/` turns workflow Markdown into a JavaScript editing experience. Inside
`js` and `ts` fences it runs the TypeScript language service, with the library declared as
globals: completions, hover, signature help, go to definition (F12), references (Shift+F12),
rename (F2), highlights and document symbols work across all fences of a document. Diagnostics
report frontmatter, `@CTL` and JavaScript syntax errors exactly as the runtime compiles them,
missing relative imports, and type errors inside `ts` fences.

In blockquotes, `@` completes shared variables, functions, library functions and markers;
`@validate[` completes declared types; `@CTL(` completes its settings. Names an agent saves
(`save to @invoice`, `-> @result`) are declared for later fences. Type `splworkflow` for a new
workflow document. Ordinary Markdown keeps its normal behavior.

`.spl` files are colored as a whole and get the same features: JavaScript IntelliSense in `{js}`
and `{ts}` blocks, `@` completion in `{agent}` blocks and completion of tag settings.

**SPL: Open as Notebook** runs fences and blockquotes as notebook cells in one session.
The language server only analyzes source and never calls models or tools.
See the [extension guide](../vscode/README.md) for features, shortcuts and limits.

Or install from the repository:

```bash
cd vscode
npm install
npm run package
code --install-extension spl-lang-vscode-2.0.0.vsix
```

## Run the tests

```bash
cd lang
npm test
```

Tests are offline and never contact a model.
