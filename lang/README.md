<img src="https://raw.githubusercontent.com/dgawlik/semantic-prompt-language/HEAD/vscode/icon.png" alt="SPL logo" width="128" height="127">

# spl-lang

Semantic Prompt Language: natural-language instructions for models and agents, interleaved with
TypeScript in one `.spl` file. The package is the compiler and CLI that run such files, and a
Node.js library for checked model calls, agents and guards.
Requires Node.js >=24.15.0. See the
[documentation](https://dgawlik.github.io/semantic-prompt-language/) for the full guide.

## Run

```sh
npm install -g spl-lang      # or, in this folder: npm install && node dist/cli.js
spl login openai             # or anthropic / google
spl run examples/hi.spl
```

`spl login <provider>` securely prompts for an API key and saves a per-provider key and default
provider in `~/.spl/credentials.json` (`SPL_HOME` overrides the folder). Environment credentials
take precedence: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY`
(also `GOOGLE_API_KEY` / `GEMINI_API_KEY`). With multiple configured providers, use `--provider`,
`SPL_PROVIDER`, a provider/model ID, or a saved login default. Login is API-key configuration,
not subscription OAuth. Workflows without model calls, `spl check`, `spl compile`, `spl doc` and
replay work without signing in.

```text
spl run <file.spl> [--arg value ...] [--model id] [--provider openai|anthropic|google] [--cwd dir]
                   [--mcp file.json] [--timeout s] [--human answer ...] [--trace file.jsonl]
                   [--log-level error|info|debug] [--silent] [--debug]
spl check <file.spl>
spl compile <file.spl>
spl doc <file.spl> [--format md|html]
spl login <openai|anthropic|google>
spl logout [openai|anthropic|google]
```

The result goes to stdout and logs to stderr. Exit codes: `0` success, `1` workflow failure,
`2` syntax, type or usage error, `70` internal error.
See [CLI & runtime](../docs-template/CLI.md).

## A workflow

```spl
//*
# Rate a review
*//

const Rating = Struct('Rating', {
    score: Int.annotate({ minimum: 1, maximum: 5, desc: 'Review score' }),
    reason: Str,
});
const review = await readFile(args[0] ?? './review.txt');

---
outputVar: rating
outputType: Rating
repairs: 1

Rate this review from 1 to 5: @review
---

assert(rating.score >= 1 && rating.score <= 5, 'score out of range');
await restrict('./out', () => writeFile('./out/rating.json', JSON.stringify(rating)));
success(rating);
```

* A `.spl` file is TypeScript with three additions. `//* ... *//` is a Markdown comment. A `---`
  block is an instruction for a model: an optional header of `key: value` lines, then the text.
  `@name` in the text reads a variable.
* Blocks have three modes. `ask` (the default) makes one model call without tools and declares
  `outputVar`, coerced to `outputType`. `agent` lets the model act with tools and declares its
  outputs inline: `->[Type] @name`. `codegen` generates functions: `-> @slugify(text: string): string`.
* A block is a statement and may stand wherever one may, including functions and loops. Outputs
  are constants in the enclosing scope; `=name` assigns an existing `let`.
* Code is TypeScript on Node.js: top-level `await`, `import` of `node:` modules, local files,
  packages and other `.spl` files, resolved from the file. Node.js erases the types, so only
  erasable type syntax is allowed. `spl run` does not type-check; `spl check` does, with `tsc`.
* A `.spl` module's default export is its workflow, `workflow(args?, options?)`, which resolves to
  the value given to `success()`. `export`ed declarations stay at module level. `spl compile`
  writes the same module as a `.ts` file.
* A header-only block at the start of the file sets defaults for the whole file, for example
  `model: gpt-6-luna`.

See [Workflow code](../docs-template/Language.md) and
[Natural language & models](../docs-template/LLM-commands.md).

## The library

Everything a `.spl` file uses without importing is also a normal ES module:

```js
import { ask, agent, restrict, Struct, Str, Int, configure } from 'spl-lang';

configure({ model: 'gpt-6-luna' });
const Rating = Struct('Rating', { score: Int, reason: Str });
const rating = await ask('Rate this review from 1 to 5: ...', { schema: Rating, repairs: 1 });
```

* `ask(prompt, options?)` asks a model for a value without tools; `agent(prompt, options?)` lets it
  act with the built-in tools and MCP servers. Options: `schema`, `fmt`, `len`, `repairs`,
  `reasoning` (`none`, `low`, `medium`, `high`, `max`; `medium` by default), `model`, `tokens`,
  `hide`, and for `ask` the sampling settings `seed`, `temperature` and `topP`.
* `decision({ question, evidence, cutoff })` and `decision({ question, evidence, labels })` answer a
  question with a boolean: a probability above `cutoff`, or the meaning of the chosen label. OpenAI and
  Google use their decision endpoints with fixed models (`gpt-6-luna`, `gemini-decision-1`);
  Anthropic models simulate one.
* `human(question)` asks a person. `enforce(text, fn)` and `forbid(text, fn)` add prompt guidance;
  `restrict(spec, fn)` limits files, hosts, executables and MCP tools. `success`, `fail`, `assert`
  and `log` control and report a run. `codegen(description)` generates a function.
* Types start with an uppercase letter: `Str`, `Int`, `Float`, `Bool`, `Char`, `Nil`, `Any`, `Dict`,
  `Fn`, `List`, `Union`, `Nullable`, `Enum`, `Struct`, `Typedef`, `JsonSchema`. They validate
  (`parse`, `is`), convert (`coerce`: JSON text, numeric strings, `1`/`0` for `Bool`; never a model),
  parse into classes (`.methods()`, `.class()`) and render JSON Schema with annotations.
  `Infer<typeof Type>` gives the TypeScript type. Try [typed-data.spl](examples/typed-data.spl)
  without a model.
* `readFile`, `writeFile`, `webFetch`, `webSearch` and `shell` are exact tools: they never call
  a model and are checked against restrictions. `restrict` does not govern Node.js APIs that
  your own code calls.
* Failures are `Failure` exceptions with `statusCode`, `reason` and `line`. `success(value)` ends a
  workflow by throwing a signal, so a catch-all must rethrow what it does not handle.
* Outside a workflow the library uses a default runtime: provider keys from the environment or
  `spl login`, info-level logs on stderr. `configure({ model, provider, cwd, args, logLevel, logger, backend, timeoutMs, mcpServers, trace, human })`
  replaces it.
* `spl-lang/markdown` exports the Markdown builder (`markdown` in workflows), and
  `spl-lang/globals` declares the workflow globals for editors:
  `{ "compilerOptions": { "types": ["spl-lang/globals"] } }`.

The [API reference](../docs-template/Reference.md) lists every signature and option.

## Traces and human input

`--trace run.jsonl` appends durable execution history. Reusing the same path automatically resumes
recorded work or replays a completed success/failure without model/MCP calls, repeated tool effects
or repeated human prompts. Existing trace bytes never change. Choose another JSONL file to restart.
Source, runtime and execution configuration must match; unsafe interrupted effects require manual
recovery. Only library effects are recorded, blocks included: the workflow's own code runs again
on replay, including any Node.js APIs it calls directly and the modules it imports.
Keep traces private: they contain captured responses and external inputs.

Codegen blocks and `codegen()` save generated functions beside the workflow as
`<workflow>.<function>.js`; later runs reuse a file whose first-line hash matches the description.

Normal runs ask human questions directly: in the terminal view's status box, or on stderr with one
line read from stdin when logs are redirected. Supply repeatable
`--human <answer>` flags to skip prompting in question order, for example
`spl run examples/color-poem.spl --human blue --human apple`. Remaining questions still prompt,
including with `--silent`. With `--trace`, supplied answers are consumed only for unrecorded questions.

## Logs

Each event has one compact header: `->` input (magenta), `<-` output/action (cyan), `*` tool (green),
`~` state (yellow), `x` error (red), `!` warning (yellow), `i` info (blue), `.` debug (gray).
`log(...)` calls keep the prefix `[info|error|debug] log:`. With `--log-level debug`, state logs
report changes to top-level variables and the outputs of blocks, with their before and after
values. Tool calls (files, web, shell, MCP) are logged from `info` with their content.

When stdin and stderr are terminals, logs appear in a full-screen Ink view on stderr's alternate
screen. Preambles, JSON, generated code and tool content (files read or written, fetched pages,
search results) start collapsed: Up/Down selects, Space/Enter expands with line numbers and syntax
colors, Page Up/Down scrolls and Home/End reaches the ends. Output follows the tail; scrolling away
pauses following without pausing execution. Human questions are answered inside the view. When the
run ends the view waits for `e`; exiting restores the terminal, prints nothing to stderr and leaves
only the result on stdout. `--debug` stops before each `---` block and each top-level statement:
`n` runs the next step, `v` shows the top-level variables, `c` continues and `e` exits. Redirected
logs and embedded sinks never read input and always expand JSON with two-space indentation. stdout
results and trace journals remain machine-readable.

`--log-level` filters severity; model events remain visible at every non-silent level.
`--silent` suppresses execution logs. `NO_COLOR` wins over `FORCE_COLOR`; `FORCE_COLOR=0`
disables color and forced color never enables interactivity. Only `spl run` starts the view.

## Embedding

A compiled workflow is the simplest way to embed one: `spl compile review.spl` writes `review.ts`,
whose default export runs the workflow.

```ts
import review from './review.ts';

const rating = await review(['./review.txt'], { model: 'gpt-6-luna', logLevel: 'silent' });
```

To run `.spl` source directly, and to supply your own model backend, logger or trace:

```js
import fs from 'node:fs';
import { run, AiBackend, Logger } from 'spl-lang';

const logger = new Logger('info');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
const result = await run(fs.readFileSync('review.spl', 'utf8'), {
    backend, logger, file: 'review.spl', args: ['./review.txt'],
    human: question => 'yes',
});
await backend.close();
if (result.status === 'failure') console.error(result.failure);
```

`run` resolves to `{ status: 'success', value, hasValue }` or `{ status: 'failure', failure }` and
throws `SplSyntaxError` when the file does not compile. `scan(source)` returns the scanner's
TypeScript with blocks, comments and problems; `compile(source)` adds the module code;
`check(file)` type-checks with `tsc`; `documentMarkdown(source)` and `documentHtml(source, title)`
are `spl doc`. `beforeStep` in the run options is the hook behind `--debug`.

## Tests

```sh
npm test    # builds, then runs the offline suite; no test contacts a model
```

`tests/live.test.ts` runs against a real provider only when `SPL_LIVE_TESTS=1` is set.
