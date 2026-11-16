# SPL 3.0: new syntax

SPL 3.0 removes runnable Markdown documents (`.md`) and the 2.x `.spl` block syntax. Dead code for both is
deleted. The core of the project is now one idea: **interleave natural-language instructions for models and
agents with TypeScript code** in a single `.spl` file.

## Example

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

## Runtime and toolchain

- **Node.js only** (>= 24.15). npm stays the package manager and Vitest stays the test runner. Bun is not used.
- A **front scanner** written in plain TypeScript turns a `.spl` file into TypeScript. It runs wherever Node runs,
  including the VS Code extension host.
- **Line preservation:** the generated TypeScript keeps every source construct on its original line, so
  diagnostics and stack traces point at `.spl` lines without source maps.
- **Pipeline:** scanner → TypeScript → Node `module.stripTypeScriptTypes` (strip mode) → acorn (statement
  boundaries for `--debug`) → execution.
- **TypeScript dialect:** erasable syntax only. `enum`, `namespace`, decorators and constructor parameter properties
  are rejected with a hint (for example "use a union of string literals instead of enum").
- `spl run` strips types and does not type-check. `spl check` type-checks with `tsc`, using the generated
  TypeScript plus `globals.d.ts`.
- **Imports between files:** a `.spl` file may `import` another `.spl` file, through a Node `module.registerHooks`
  loader that compiles `.spl` on import. `spl compile` rewrites those imports to the compiled files.
- **Version:** 3.0.0. A file containing 2.x syntax (`{js}`, `{/js}`, `{agent …}`, `{comment}`, fence-and-blockquote
  Markdown) fails with "SPL 2.x syntax; see the migration guide". `.md` workflows are no longer executable.

## File format

A `.spl` file is TypeScript with three extensions.

### Markdown comments `//* … *//`

- `//*` and `*//` must each start a line (leading whitespace allowed).
- **Top level only:** not inside any `{`, `(` or `[`, and not inside a `---` block. Anywhere else is an error:
  "Markdown comments (`//*`) are only allowed at the top level". An unclosed `//*` is an error at its line.
- The content is Markdown. It is colored as Markdown in VS Code and copied as prose into `spl doc` output.
- Ordinary `//` and `/* */` comments stay part of the code and appear in `doc` code fences.

### Code

Everything else is TypeScript. The scanner skips strings, template literals, regular expressions and comments, so
`---` or `//*` inside them is never treated as syntax.

### Blocks `--- … ---`

A line containing only `---` (surrounding whitespace allowed) opens a block, and the next such line closes it.

- **Fences:** an odd number of fences in a file is an error that names the unmatched opening line. Markdown
  horizontal rules cannot be written as `---` inside a block; use `***`.
- **Placement:** a block may appear wherever a statement may: top level, function bodies, loops, `if`, `try`.
  A block in expression position (`x = ---`) is an error. A block inside a non-async function produces
  TypeScript's "await is only valid in async functions" error.
- **Scope:** outputs are declared in the scope enclosing the block and follow normal block scoping.
- **Structure:** a block is an optional **header** of `key: value` lines, then the **instruction** text.
  - The header is the run of leading lines whose key is a known header key.
  - A blank line, or the first line whose key is unknown, ends the header.
  - A known key that is misspelled (`modle:`) gets a "did you mean `model`?" error.

#### File defaults

A block that has header lines but no instruction sets defaults for the whole file (for example `model`). It is only
allowed as the first item in the file that is not a comment.

#### Header keys

Values are YAML, except `outputType`, which is raw TypeScript text up to the end of the line.

| Key | Modes | Meaning |
| --- | --- | --- |
| `mode` | all | `ask` (default), `agent` or `codegen` |
| `model` | all | Model id; `provider/model` allowed |
| `reasoning` | all | `none`, `low`, `medium` (default), `high`, `max` |
| `enforce` / `forbid` | all | Guidance: string or list of strings |
| `hide` | all | Hide reasoning in logs |
| `tokens` | all | Max generated tokens per model turn |
| `restrict` | agent | `{ fs, exec, net, mcp }` restrictions for this block |
| `outputVar` | ask | Name of the output variable (required in ask blocks) |
| `outputType` | ask | Type expression the answer is coerced to; default `Str` |
| `repairs` | ask | 0–5 retries when coercion to `outputType` fails |
| `seed`, `temperature`, `topP` | ask | Sampling settings |

A key used in a mode it does not apply to is an error.

#### References `@name`

- A reference is `@identifier(.identifier)*` at the start of a word. `user@example.com` is literal text.
- `@@` writes a literal `@`.
- `@env.NAME` reads an environment variable and `@args` reads the CLI arguments.
- There is no `${…}` interpolation, so backticks in prompts need no escaping.
- **Inputs:** every `@name` that is not an output of the same block is an input. An input that does not exist is a
  TypeScript "Cannot find name" error on its line.
- **ask:** referenced values are inlined into the prompt as JSON, labelled with their names.
- **agent:** referenced values are reached through tools (`loadVariable`, `callFunction`). The agent can call
  only the functions referenced in the block, plus the library tools.

#### Outputs

- **`ask` blocks** have exactly one output, named by `outputVar` and coerced with `outputType` (default `Str`).
  - A block without `outputVar` is an error: "ask block needs outputVar".
  - `->` inside an ask block is an error that points at `outputVar`.
  - One ask block is one prompt and one model call. Ask blocks have no tools.
- **`agent` blocks** declare any number of outputs inline: `->[Type] @name`.
  - The type is optional; untyped outputs are saved JSON typed `unknown`.
  - Spaces between `->`, `[Type]` and `@name` are optional. The type expression may contain balanced brackets,
    for example `->[List(Union(Str, Int))] @tags`.
  - The arrow may appear anywhere in a line; the rest of the line stays instruction text.
  - The whole block is one agent call. The model is told each output's name, type and JSON Schema.
  - The agent may save only declared outputs. A block that finishes without saving one fails with
    "agent did not produce @name".
  - An invalid save (`Type.coerce` fails) is returned to the agent with the validation path. It may correct it,
    up to 2 attempts per output; then the block fails with `validation_failed`. Errors from external tools still
    stop the block immediately.
- **`codegen` blocks** declare generated functions: `-> @slugify(text: string): string`.
  - The signature is optional. It is given to the model and becomes the function's TypeScript type.
  - Several `->` lines are generated together in one model call.
  - Generated code is cached beside the workflow, keyed by description and signature.
- **New or updated variable:** outputs declare a new `const` in the enclosing scope. To assign an existing `let`
  instead, write `@=name` (`->[Int] @=count`, `outputVar: =count`). Redeclaring an output is TypeScript's
  "Cannot redeclare block-scoped variable" error.

### Transpilation sketch

Blocks become calls to library primitives on the same lines. The agent block above becomes roughly:

```ts
const { fact15, fib10, fibPlus2, modelFib10 } = await __spl.agent({ line: 25, model: 'gpt-6-luna', reasoning: 'high',
    inputs: { factorial, fib },
    outputs: { fact15: Int, fib10: Int, fibPlus2: Int, modelFib10: Int },
    text: `Invoke @factorial with 15 as argument ->[Int] @fact15
...` });
```

The joke block becomes `const joke = await __spl.ask({ line: 37, outputType: Joke, enforce: [...], forbid: [...], text: `...` });`.

## Models and reasoning

- `think` is removed: the `think()` function, `ThinkOptions`, the `think` interaction kind and its VS Code catalog
  entry. Use `ask(prompt, { reasoning: 'high' })`.
- **Reasoning levels:** `none`, `low`, `medium`, `high`, `max`.
- **Defaults:** ask blocks and `ask()` default to `medium`. `agent()` keeps `medium`.
- **Sampling:** when `seed`, `temperature` or `topP` is given without an explicit `reasoning`, the default becomes
  `none`. An explicit `reasoning` combined with sampling on a provider that rejects the pair is an error when the
  call is made, naming both settings.
- **Unsupported levels:** fall back to the nearest supported level with a warning naming the level used.
  `none` maps to the provider minimum (for example Gemini Pro models cannot disable thinking).
  `max` maps to the strongest effort the model offers (32k thinking budget for budget-based Anthropic models).

## Library changes

- **Types** start with an uppercase letter and the lowercase names are removed:
  `Str`, `Int`, `Float`, `Bool`, `Char`, `Nil`, `Any`, `Dict` (was `object`), `Fn`, `List`, `Union`, `Nullable`,
  `Enum`, `Struct`, `Typedef`, `JsonSchema`. The `t` namespace is renamed to match.
- **`Type.coerce(value)`** converts any value to the type and returns the matching TypeScript type. It is
  deterministic and never calls a model.
  - Strings that hold JSON are parsed first.
  - Numeric strings become numbers. `Int` requires an exact integer: `3.0` gives 3, but `3.7` fails.
  - `Bool` accepts `true`/`false`/`1`/`0` and their strings.
  - `Str` turns non-strings into JSON text.
  - Struct fields and list items are coerced recursively.
  - Failure throws `validation_failed` with the path of the bad field.
  - Model repair is separate: the `repairs` header key and option.
- **Tools** use camelCase everywhere: the names the model sees, `TOOL_SPECS` and log names.
  - Built-in tools: `readFile`, `writeFile`, `webFetch`, `webSearch`, `shell`.
  - Agent tools: `loadVariable`, `saveVariable`, `callFunction`, `getEnv`, `askHuman`, `setGuidance`.
  - MCP tools are exposed as `mcp<Index><Tool>`, for example `mcp0Search`.
  - Restriction kinds stay `fs`, `exec`, `net`, `mcp`.
- **Removed:** `go()`, control lines (`if`/`elif`/`else`/`while` between blocks), `ExecutionSession`, `--pin`, locked
  workflows, Markdown parsing of workflows. Plain TypeScript control flow replaces control lines and `go()`.
- **Kept:** `human()`/`askHuman`, MCP servers, `restrict`/`enforce`/`forbid` in code, `success`/`fail`/`assert`/`log`,
  `--trace` record and replay (blocks go through the same journaled effects as `ask()`/`agent()`).

## CLI

| Command | Effect |
| --- | --- |
| `spl run <file.spl>` | Compile in memory and run in place |
| `spl compile <file.spl>` | Write an importable TypeScript module |
| `spl doc <file.spl> [--format md\|html]` | Generate documentation (Markdown by default) |
| `spl check <file.spl>` | Scan and type-check without running |

- **`compile` output:** `export default async function workflow(args: string[], options?): Promise<Result>`.
  - The file body runs inside the function. `import`s and `export`ed declarations stay at module level.
  - `success(v)` returns `v`; `fail` throws.
  - An `export`ed declaration that uses a workflow variable is an error.
  - The output imports `spl-lang` and runs on Node.
- **Flags kept:** `--model`, `--provider`, `--arg`, `--human`, `--mcp`, `--timeout`, `--trace`, `--cwd`,
  `--log-level`, `--silent`, `--debug`.
- **`--debug`** stops before each `---` block and each top-level statement.
  - `n` runs the next step, `v` shows the top-level variables, `c` continues and `e` exits.
  - `v` uses a generated snapshot function; variables not yet assigned show `<uninitialized>`.
- **State logs** (`--log-level debug`) cover block outputs and top-level variables only. Changes to locals inside
  functions are no longer reported.

## Docs generation (`spl doc`)

- `//* *//` comments become prose.
- Each run of top-level code between prose and blocks becomes one ` ```ts ` fence, imports and ordinary comments
  included.
- A top-level block becomes a callout headed by its mode, with its settings as a small table and its instruction as
  quoted text. A block nested inside code stays in the fence as written.
- `--format html` reuses the documentation site's styles and highlighter.
- The docs site's Examples page is generated from the example `.spl` files with `spl doc`.

## VS Code extension

- **Notebooks** (`.md` notebooks, worker and kernel) are removed.
- **Syntax coloring:** Markdown inside `//* *//`; YAML header and instruction text inside `---`.
- **TypeScript features:** diagnostics, completion and hover, using the scanner's output as a virtual document.
- **`@name` completion** inside blocks.
- **Run and Debug** commands that open a terminal.
- **Consistency test:** the test that keeps catalog, `globals.d.ts` and `library()` in sync moves to the
  uppercase types and camelCase tools.

## Migration

- **Examples:** all examples are converted by hand to the new syntax.
  - `hi`, `code-review` and `codegen` exist as both `.md` and `.spl`; each pair is merged into one `.spl`, based
    on the richer version.
  - Every other `.md` example, including `deterministic/`, becomes `<name>.spl`.
  - `conditional-workflows.spl` and `goto.spl` are rewritten with TypeScript `if`/`while` instead of control lines
    and `go()`.
- **Docs and presentation:** the docs pages, README and presentation are rewritten for the new syntax. The docs
  tests that compare listings with example files follow the new names.
- **Migration guide:** maps each 2.x construct to its 3.0 form, for example fence → code, blockquote → agent block,
  `@CODEGEN` → codegen block, `think()` → `ask` with reasoning, lowercase types → uppercase.
- **No automatic converter.**

## Errors the scanner reports

| Situation | Error |
| --- | --- |
| Odd number of `---` fences | Unmatched block opened at line N |
| Block in expression position | Blocks are statements |
| `//*` below top level or inside a block | Markdown comments are only allowed at the top level |
| Unclosed `//*` | Unclosed Markdown comment |
| Misspelled header key | Did you mean `model`? |
| Header key not valid for the mode | `outputVar` applies only to ask blocks |
| Ask block without `outputVar`, or with `->` | Ask block needs `outputVar` |
| Header-only block that is not first | File defaults must come first |
| 2.x syntax | SPL 2.x syntax; see the migration guide |
| Non-erasable TypeScript (`enum`, …) | Unsupported TypeScript syntax, with a replacement hint |
