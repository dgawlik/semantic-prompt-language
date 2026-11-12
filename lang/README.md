<img src="https://raw.githubusercontent.com/dgawlik/semantic-prompt-language/HEAD/vscode/icon.png" alt="SPL logo" width="128" height="127">

# spl-lang

Semantic Prompt Language: a Node.js library for checked model calls, agents and guards, and a
CLI that runs Markdown workflows written with it. In a workflow, `js` fences run as native
JavaScript with the library already imported, and blockquotes run as agent commands.
Requires Node.js >=24.15.0. See the
[documentation](https://dgawlik.github.io/semantic-prompt-language/) for the full guide.

## Run

```sh
npm install -g spl-lang      # or, in this folder: npm install && node dist/cli.js
spl login openai           # or anthropic / google
spl examples/hi.md
```

`spl login <provider>` securely prompts for an API key and saves a per-provider key and default
provider in `~/.spl/credentials.json` (`SPL_HOME` overrides the folder). Environment credentials
take precedence: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY`
(also `GOOGLE_API_KEY` / `GEMINI_API_KEY`). With multiple configured providers, use `--provider`,
`SPL_PROVIDER`, a provider/model ID, or a saved login default. Login is API-key configuration,
not subscription OAuth. Workflows without model calls, `--check` and replay work without signing in.

```text
spl workflow.md [--arg value ...] [--model id] [--provider openai|anthropic|google] [--cwd dir] [--mcp file.json] [--timeout s]
                [--human answer ...]
                [--trace file.jsonl]
                [--pin]
                [--log-level error|info|debug] [--silent] [--check]
spl login <openai|anthropic|google>
spl logout [openai|anthropic|google]
```

The result goes to stdout and logs to stderr. Exit codes: `0` success, `1` script failure,
`2` syntax or usage error, `70` internal error.
See [CLI & runtime](../docs-template/CLI.md).

## A workflow

````markdown
---
extension: semantic-prompt-language
version: 1
---

# Rate a review

```js
const Rating = struct('Rating', {
    score: int.annotate({ minimum: 1, maximum: 5, desc: 'Review score' }),
    reason: str,
});
const review = await readFile(args[0] ?? './review.txt');
```

> Rate the review in @review from 1 to 5. @validate[Rating] save to @rating

```js
assert(rating.score >= 1 && rating.score <= 5, 'score out of range');
await restrict('./out', () => writeFile('./out/rating.json', JSON.stringify(rating)));
success(rating);
```
````

* Fences are native JavaScript on Node.js: top-level `await`, `import` of `node:` modules, local
  `.js` files and packages. Imports and relative paths resolve against the working directory
  (`--cwd`); `import.meta` describes the workflow file. Imported names are live, read-only
  bindings. `spl-lang` and `spl-lang/markdown` always resolve to the running copy of the
  package, also inside helper modules, so helpers need no local install.
* Fences run on the main thread: a long synchronous loop blocks logs and Ctrl+C until it
  yields, and a library call that is not awaited can crash the process when it fails.
* All fences and blockquotes share one scope. Top-level declarations are visible to later fences
  and to agents; redeclaring a name in a later fence rebinds it.
* The library is pre-imported in every fence: `ask`, `think`, `agent`, `human`, `enforce`,
  `forbid`, `restrict`, `success`, `fail`, `assert`, `log`, `codegen`, `readFile`, `writeFile`,
  `webFetch`, `webSearch`, `shell`, `args`, `env`, `markdown`, `Failure`, and the type builders
  `str`, `int`, `float`, `bool`, `char`, `nil`, `any`, `object`, `fn`, `list`, `union`,
  `nullable`, `enumOf`, `struct`, `typedef`, `jsonSchema`, `validate` and `t`.
* Blockquotes run as agent commands. Their tools load and save shared variables, call functions,
  read environment values, ask a person, and use runtime tools and configured MCP servers.
  `@CTL(...)` sets restrictions, guidance, model and reasoning; `@CODEGEN 'description'`
  generates JavaScript functions into the shared scope.
* Annotations such as `minimum` are advice for the model, not constraints: the assertion above
  enforces the score. `schema` and `@validate` check the shape.

See [Workflow code](../docs-template/Language.md), [Natural language & models](../docs-template/LLM-commands.md)
and [Guards & failures](../docs-template/Safety.md).

## The library

```js
import { ask, agent, enumOf, restrict, str, struct } from 'spl-lang';

const Triage = struct('Triage', {
    label: enumOf('bug', 'feature', 'question'),
    reason: str.describe('One-sentence explanation'),
});

const triage = await ask('Classify: the export button does nothing', { schema: Triage, repairs: 2 });
const report = await restrict({ fs: './src', exec: 'npm' }, () =>
    agent(`Find the cause of this ${triage.label}: ${triage.reason}`));
```

* `ask` and `think` generate values without tools; `agent` can act with `read_file`,
  `write_file`, `web_fetch`, `web_search`, `shell` and MCP tools, within `restrict` scopes.
* Options: `len`, `fmt`, `schema`, `repairs`, `reasoning`, `hide`, `model`, `tokens`, and for
  `ask` only `seed`, `temperature` and `topP`. Invalid options fail before any model call.
* `fmt`, `schema`, `repairs` and `assert` check output; `enforce(text, body)` and
  `forbid(text, body)` only guide prompts.
* Types validate data, parse JSON into JavaScript objects (or class instances with
  `.methods()` and `.class()`) and render JSON Schema with annotations. `Infer<typeof Type>`
  gives the TypeScript type. Try [typed-data.md](examples/typed-data.md) without a model.
* `readFile`, `writeFile`, `webFetch`, `webSearch` and `shell` are exact tools: they never call
  a model and are checked against restrictions. `restrict` does not govern Node.js APIs that
  your own code calls.
* Failures are `Failure` exceptions with `statusCode` and `reason`. `success(value)` ends a
  workflow by throwing a signal, so a catch-all must rethrow what it does not handle.
* Outside a workflow the library uses a default runtime: provider keys from the environment or
  `spl login`, info-level logs on stderr. `configure({ model, provider, cwd, args, logLevel, logger, backend, timeoutMs, mcpServers, trace, human })`
  replaces it.
* `spl-lang/markdown` exports the Markdown builder (`markdown` in fences), and
  `spl-lang/globals` declares the fence globals for editors:
  `{ "compilerOptions": { "types": ["spl-lang/globals"] } }`.

The [API reference](../docs-template/Reference.md) lists every signature and option.

## Traces, pins and human input

`--trace run.jsonl` appends durable execution history. Reusing the same path automatically resumes
recorded work or replays a completed success/failure without model/MCP calls, repeated tool effects
or repeated human prompts. Existing trace bytes never change. Choose another JSONL file to restart.
Source, runtime and execution configuration must match; unsafe interrupted effects require manual
recovery. Only library effects are recorded: the workflow's own JavaScript runs again on replay,
including any Node.js APIs it calls directly and the helper modules it imports.

`spl workflow.md --pin` runs normally and, only on success, creates `workflow.locked.md`.
The original Markdown is retained, with a journal in double blockquotes (`>>`).
Run `spl workflow.locked.md` to replay the same model responses, runtime decisions, tool results
and human answers without contacting providers/MCP, repeating tool effects or prompting.
Arguments, model overrides and any accessed environment snapshot are pinned too.
Helper modules are not: a locked workflow that imports local helpers still needs those files,
and an edited helper changes the replayed result.
Existing locked files are never overwritten. Pinning cannot be combined with `--trace`.
Keep traces and locked files private: they contain captured responses and external inputs.

With `--trace`, `@CODEGEN` and `codegen()` save generated functions beside the workflow as
`<workflow>.<function>.js`; later traced runs reuse a file whose first-line hash matches the
description.

Normal runs ask human questions directly on stderr and read one line from stdin. Supply repeatable
`--human <answer>` flags to skip prompting in question order, for example
`spl examples/color-poem.md --human blue --human apple`. Remaining questions still prompt,
including with `--silent`. With `--trace`, supplied answers are consumed only for unrecorded questions.

## Logs

Each event has one compact header: `->` input (magenta), `<-` output/action (cyan),
`~` state (yellow), `x` error (red), `!` warning (yellow), `i` info (blue), `.` debug (gray).
`log(...)` calls keep the prefix `[info|error|debug] log:`. With `--log-level debug`, state logs
report changes to shared top-level variables with their before and after values.

When stdin and stderr are terminals, BetterTUI initially folds JSON objects/arrays. Up/Down
selects payloads (or scrolls text), Enter/Space toggles a visible selection, Page Up/Down scrolls,
and Home/End reaches the ends. Output follows the tail initially; scrolling away pauses following
without pausing execution. Finishing restores the terminal and retains one complete expanded
transcript without a keypress. Before a human prompt, the renderer restores the terminal and
switches to append-only logs. Redirected logs and embedded sinks never read input and always
expand JSON with two-space indentation. stdout results and trace journals remain machine-readable.

`--log-level` filters severity; model events remain visible at every non-silent level.
`--silent` suppresses execution logs. `NO_COLOR` wins over `FORCE_COLOR`; `FORCE_COLOR=0`
disables color and forced color never enables interactivity. Auth,
help/version and `--check` do not start a renderer.

## Embedding

```js
import fs from 'node:fs';
import { parseMarkdown, run, Logger, AiBackend } from 'spl-lang';

const logger = new Logger('silent');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
    const workflow = parseMarkdown(fs.readFileSync('flow.md', 'utf8'));
    const result = await run(workflow, { backend, logger, file: 'flow.md', args: ['first'] });
    console.log(result);
} finally {
    await backend.close();
}
```

Also exported: `parse` (plain JavaScript as a one-fence workflow), `parseInstruction`,
`checkWorkflow`, `compileCell`, `Trace`, `Pin`, `loadMcpConfig`, authentication helpers,
embedding-only variable-store interfaces and types. See [Embedding](../docs-template/CLI.md#embedding).
`CopilotBackend` remains an alias of `AiBackend` for existing embedding imports.
Embedded callers provide a `human(question, line)` handler returning a string or `Promise<string>`;
the runtime never reads stdin itself. A supplied `trace` replays recorded answers without calling
the handler, and records new answers.

### Interactive sessions

Use `ExecutionSession` for notebook/REPL execution. It keeps one shared scope, with variables,
objects and function closures, between calls. Calls must be serialized; each session is
isolated, and replacing it clears state.

```js
import { ExecutionSession, parse, Logger } from 'spl-lang';

const backend = { async call() { throw new Error('no model in this example'); }, async close() {} };
const logger = new Logger('silent');
const session = new ExecutionSession();

await session.run(parse('let count = 2;\nfunction double() { return count * 2; }'), { backend, logger });
await session.run(parse('count += 1;'), { backend, logger });
const result = await session.run(parse('double()'), { backend, logger, source: 'cell:3' });
// result: { status: 'success', value: 6, hasValue: true }
```

Unlike one-shot `run`, a session returns the final expression's value; `success` keeps its usual
behavior. Failures retain changes already made; no cells are replayed.
The optional `source` URI and `sourceVersion` are remembered by function definitions and returned
as `failure.source` and `failure.source_version`, so a host can locate errors without highlighting
stale edited source. Stores, traces and pins are not session options. The embedding host owns
backend cleanup and cancellation; the VS Code notebook extension uses a separate process per
notebook so even unbounded code can be interrupted.

## Tests

```sh
npm test
```

Tests are offline and never contact a model.
