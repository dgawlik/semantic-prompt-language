# SPL: Semantic Prompt Language

The agentic frameworks are hard. Callback hell, operating on graphs and using language native primitives puts burden on you.

There is another way:
* interleave JavaScript with natural language prose directly in one file
* use shorthands for schema enforcement, restricting llm outputs and drive agentic tasks from one file 
* decide with minimal costs about next route

Meet **Semantic Prompt Language**. It's a toolkit and runtime for agentic tasks that runs from a single `.spl` file.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
[Examples](lang/examples)

## Example worth thousand of words

The runtime scans file for `---` tags. When detected they become calls to llms. `//*` are markdown comments. With docs command you can document your workflow as Markdown file. LLM calls can read and write shared variables and whole file is read top to bottom. The whole file gets transpiled to TypeScript and is ready to be consumed by runtime or embedded with JavaScript import. Short example:

```spl
//*
# Fibonacci check

This a markdown comment. It is rendered as prose by `spl doc`.

Points:
* one
* two
*//

---
model: gpt-6-luna
---

const Joke = Struct('Joke', { setup: Str, punchline: Str });

function fib(n: number): number {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function factorial(n: number): number {
    return n === 0 ? 1 : n * factorial(n - 1);
}

---
mode: agent
reasoning: high

Invoke @factorial with 15 as argument ->[Int] @fact15
Invoke @fib with 10 as argument ->[Int] @fib10
Add 2 to @fib10 ->[Int] @fibPlus2
Work out the 10th Fibonacci number yourself, without using @fib ->[Int] @modelFib10
---

assert(fib10 === modelFib10, 'Oops, the model got it wrong');

---
enforce: Answer in Chinese
forbid: Mentioning the word cat
outputVar: joke
outputType: Joke

A joke about programmers with a setup and a punchline.
---

---
outputVar: animal

A paragraph of a funny story about a pet animal.
---

success({ fib: fib10, modelFib: modelFib10, joke, animal });
```

## Why SPL?

* **Short loops.** One file, run in place with `spl run`. `spl check` type-checks without a model;
  `--trace run.jsonl` resumes recorded work and replays completed runs without repeating model
  calls or tool effects.
* **Plain TypeScript where it matters.** Outside its blocks a workflow is TypeScript with top-level
  `await`. The standard library, your own modules, other `.spl` files and npm packages are one
  `import` away. Node.js erases the types, so there is no build step.
* **Checked model output.** An ask block makes one model call and coerces the answer to its
  `outputType`. An agent block declares typed outputs with `->[Type] @name` and must save every one.
  Types are built in code (`Struct`, `Enum`, `List`, `Typedef`) and carry annotations for the model.
* **Guards you can see.** Agents can act; `restrict` limits their files, network, commands and MCP
  tools. Prompt guidance (`enforce`, `forbid`) is kept separate from validation.
* **A library and a module format.** The same functions work in any Node.js program:
  `import { ask, Struct } from 'spl-lang'`. `spl compile` turns a workflow into a TypeScript module
  that exports `workflow(args, options)`.

Try [typed-data.spl](lang/examples/typed-data.spl) without a model or login. See
[Workflow code](docs-template/Language.md) for the file format,
[Types](docs-template/Language.md#types) for the type builders and
[Natural language & models](docs-template/LLM-commands.md) for blocks.

## Install

```sh
npm install -g spl-lang
spl login openai         # or anthropic / google
spl run examples/hi.spl
```

Requires Node.js >=24.15.0. Model calls use the official OpenAI, Anthropic and Google clients.
Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` (also
`GOOGLE_API_KEY` / `GEMINI_API_KEY`), or use `spl login <provider>` to save a key and default provider.
Environment keys override saved keys. With multiple providers and no saved default, select one
using `--provider`, `SPL_PROVIDER` or a model such as `--model anthropic/claude-sonnet-4-5`.
Login configures API keys, not subscription OAuth.

| Command | Effect |
| --- | --- |
| `spl run <file.spl>` | Compile in memory and run in place |
| `spl check <file.spl>` | Scan and type-check with `tsc`, without running |
| `spl compile <file.spl>` | Write an importable TypeScript module beside the file |
| `spl doc <file.spl> [--format md\|html]` | Print documentation generated from the file |

## What to know about the file format

* A `.spl` file is TypeScript with three additions: `//* ... *//` Markdown comments, `---` blocks
  and `@name` references inside blocks.
* A block has an optional header of `key: value` lines (`mode`, `model`, `reasoning`, `outputVar`,
  `outputType`, `enforce`, `forbid`, `restrict`, ...) and then the instruction. `ask` is the default
  mode; `agent` acts with tools; `codegen` generates functions.
* A block is a statement: it may stand at the top level, in a function, in a loop or in an `if`.
  Its outputs are constants in the enclosing scope; `=name` assigns an existing `let`.
* The library is already in scope. Always `await` model calls, tools, `human`, `restrict` and
  `codegen`.
* Imports resolve from the file, as in any ES module. Relative paths given to tools resolve
  against the working directory (`--cwd`).
* `restrict` and traces cover the library's tools, agents and MCP servers. Node.js APIs that your
  code calls directly are neither restricted nor recorded.
* `success(value)` ends the run and prints the value. Uncaught exceptions become
  `runtime_error` failures that name the line of the `.spl` file.

Coming from SPL 2.x? Markdown workflows and the `{js}`/`{agent}` block syntax are gone; the
[migration guide](docs-template/Migration.md) maps every 2.x construct to its 3.0 form.

## Repository

| Folder | Contents |
| --- | --- |
| [lang/](lang/README.md) | The `spl-lang` package: library, compiler, runtime, CLI, tests and [examples](lang/examples/) |
| [vscode/](vscode/README.md) | VS Code extension: syntax coloring, TypeScript language features and Run and Debug commands for `.spl` files |
| [docs-template/](docs-template/Introduction.md) | Documentation sources |
| [docs/](docs/) | Generated documentation site (GitHub Pages); `index.html` is the starter presentation |
| [examples/](langs/examples) | Many examples how SPL can help you|

## Development

```sh
npm --prefix lang install
npm test                 # builds the package, then runs the offline library and runtime tests
npm run docs:build       # regenerates docs/ from docs-template/ and the examples
npm --prefix vscode test # extension tests
```

Tests never contact a model. The [VS Code extension](vscode/README.md) feeds the scanner's
TypeScript to the TypeScript language service, with the library declared as globals, and adds
header and `@name` support inside blocks. Editor analysis is offline and never executes workflows.

## Contributing

PRs and Issues are welcome. The most needed help is in running and testing the toolkit.
There are lots of edge cases to consider, if you found the one please let me know.

I'm also looking for maintainers to discuss ideas, where the project should head next and
more importantly implement use cases.
