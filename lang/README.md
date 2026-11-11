<img src="https://raw.githubusercontent.com/dgawlik/semantic-prompt-language/HEAD/vscode/icon.png" alt="SPL logo" width="128" height="127">

# spl-lang

The SPL interpreter and CLI. Runs Markdown workflows that mix Python-like `spl` fences with
natural-language blockquotes. Requires Node.js >=24.15.0. See the
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
not subscription OAuth; legacy GitHub credentials are no longer used.
Workflows without model calls, `--check` and replay work without signing in.

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

Reusable `.spl` modules can be imported from fenced workflow code with
`import { helper as alias } from './helpers.spl'` or `import * as helpers from './helpers.spl'`.
Paths resolve next to the importing file; top-level declarations are exported automatically.
Bindings are live and read-only, and modules initialize once per run or notebook session.
See [Modules](../docs-template/Language.md#modules).

The bundled `markdown` standard library is written in SPL and imports from any SPL file or workflow
code fence. Build a document dynamically and serialize it to a string:

```spl
import * as markdown from 'markdown'
let doc = markdown.Document().heading('Report', 1)
for name in ['parser', 'runtime']:
    doc.paragraph(markdown.bold(name) + ': passed')
success doc.to_string()
```

It includes lists, quotes, fenced code, tables, links/images, inline formatting, escaping and raw
Markdown. See the [Markdown library reference](../docs-template/Language.md#markdown-standard-library).

`--trace run.jsonl` appends durable execution history. Reusing the same path automatically resumes
recorded work or replays a completed success/failure without model/MCP calls, explicit external effects
or repeated human prompts. Existing trace bytes never change. Choose another JSONL file to restart.
Source, runtime and execution configuration must match; unsafe interrupted effects require manual
recovery. Legacy store, record/replay, checkpoint/resume and answer-ID/file options are removed.

`spl workflow.md --pin` runs normally and, only on success, creates `workflow.locked.md`.
The original Markdown is retained, with a journal in double blockquotes (`>>`).
Run `spl workflow.locked.md` to replay the same model responses, runtime decisions, tool results
and human answers without contacting providers/MCP, repeating side effects or prompting.
Arguments, model overrides, initial variables and any accessed environment snapshot are pinned too.
Existing locked files are never overwritten. Pinning cannot be combined with `--trace`.
Keep locked files private: they contain captured responses and external inputs.

Normal runs ask human questions directly on stderr and read one line from stdin. Supply repeatable
`--human <answer>` flags to skip prompting in question order, for example
`spl examples/color-poem.md --human blue --human apple`. Remaining questions still prompt,
including with `--silent`. With `--trace`, supplied answers are consumed only for unrecorded questions.

Each event has one compact header: `->` input (magenta), `<-` output/action (cyan),
`~` state (yellow), `x` error (red), `!` warning (yellow), `i` info (blue), `.` debug (gray).
Explicit script logs preserve `[info|error|debug] log:`. Automatic state logs identify each
binding's defining scope and before/after values, including aliases and retained closures.
Executed source, unchanged assignments/mutations and initial runtime/store baselines are not logged.

When stdin and stderr are terminals, BetterTUI initially folds JSON objects/arrays. Up/Down
selects payloads (or scrolls text), Enter/Space toggles a visible selection, Page Up/Down scrolls,
and Home/End reaches the ends. Output follows the tail initially; scrolling away pauses following
without pausing execution. Scrolling back to the bottom resumes following automatically.
Off-screen selections do not pull the viewport back when pressing Enter/Space. Finishing
restores the terminal and retains one complete expanded transcript without a keypress.
Styled event headers are bold; an animated trailing loading character appears only while running
and is omitted from the final transcript.
Before a human prompt, the renderer restores the terminal and switches to append-only logs.
Redirected logs and embedded sinks themselves never read input and always expand JSON with two-space
indentation. stdout results and trace journals remain machine-readable.
If terminal-mode queries are unsupported or an alternate screen is already active,
SPL diagnoses the limitation and uses append-only output without taking over that screen.

`--log-level` filters severity; model events remain visible at every non-silent level.
Variable-state changes appear only with `--log-level debug`.
`--silent` suppresses execution logs. `NO_COLOR` wins over `FORCE_COLOR`; `FORCE_COLOR=0`
disables color and forced color never enables interactivity. Auth,
help/version and `--check` do not start a renderer.

## Language in brief

```spl
struct Rating:
    score: int [minimum=1, maximum=5, desc='Review score']
let review = read_file('review.txt')
let rating: Rating = ask(schema=Rating, repairs=2) 'Rate this review from 1 to 5: {review}'
assert 1 <= rating.score and rating.score <= 5 'score out of range'
restrict './out':
    write_file('./out/rating.json', json_stringify(rating))
success rating
```

Field metadata is model advice, not a range constraint: the assertion enforces the score.
`schema=Rating` explicitly selects typed decoding; an annotation alone does not.

* Exact tools `read_file`, `write_file`, `web_fetch`, `web_search` and `shell` never call a model.
* `ask` and `think` generate values without tools; `agent` can act, within `restrict` scopes.
* Use `ask(seed=42, temperature=0, top_p=0.01) 'prompt'` to control sampling.
  Each parameter is optional; omitted controls use provider/model defaults. Sampling modifiers
  are exclusive to `ask`; `think` and `agent` retain their existing modifiers and reasoning defaults.
  Unsupported controls warn and are ignored. Sampling is best-effort; use `--pin` for deterministic replay.
* Blockquotes run as agent commands, not generated SPL. Their tools can call existing functions,
  load/save shared variables, read environment values, request human input, and use
  runtime tools and configured MCP servers. Explicit `agent` expressions keep their existing tool set.
* `fmt`, `schema`, `repairs` and `assert` check output; `enforce`/`forbid` only guide prompts.
* Optional types include `int`, `float`, `char`, enums, exact structs, `list[T]`, unions,
  callable signatures and nominal classes. Reuse contracts with `type Money = int`.
  Mutable contracts persist through untyped aliases. Try
  [typed-data.md](examples/typed-data.md) without a model or login.
* `randomness(...)` prefixes and the `eval(...)` statement have been removed. Move sampling
  controls into `ask(...)`; use `assert` and schemas for explicit output checks. Recreate pins
  and traces after changing their source documents.
* **Breaking syntax change:** blocks use `:` plus a newline and a nonempty body with exactly
  four spaces per level. Use `object:` for dictionaries and `object()` for an empty dictionary,
  not braces. Interpolation and JSON wire braces are unchanged. Annotations opt into enforced
  contracts; untyped bindings remain dynamic. See the
  [manual typing migration guide](../docs-template/Migration.md), including explicit numeric
  conversions, persistent mutable contracts, and class versus struct schemas.

See [Language](../docs-template/Language.md), [Natural language & models](../docs-template/LLM-commands.md)
and [Guards & failures](../docs-template/Safety.md).

## Embedding

```js
import { parseMarkdown, run, Logger, AiBackend } from 'spl-lang';

const logger = new Logger('silent');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
  const result = await run(parseMarkdown(source), { backend, logger, args: ['first'] });
  console.log(result);
} finally {
  await backend.close();
}
```

Also exported: `parse` (raw SPL), `Trace`, embedding-only variable-store interfaces,
authentication helpers and types. See [Embedding](../docs-template/CLI.md#embedding).
`CopilotBackend` remains an alias of `AiBackend` for existing embedding imports.
Typed embedding also exports `encodeJson(value)`, `decodeTypedJson(text, descriptor)` and
`schemaForType(descriptor)`. Use the typed encoder for exact integer tokens and distinct float
spelling; ordinary `JSON.stringify` is not a replacement. Typed decoding requires an explicit
descriptor, and dynamic store loading does not restore descriptors or contracts.
Embedded callers provide a `human(question, line)` handler returning a string or `Promise<string>`
to answer directly; the interpreter never reads stdin itself. A supplied `trace` replays recorded
answers without calling the handler, and records newly supplied answers.

### Interactive sessions

Use `ExecutionSession` for notebook/REPL execution. It retains variables, mutable objects, builtin
aliases and user-function closures without a variable-store file. Calls must be serialized; each
session is isolated, and replacing it clears state.

```js
import { ExecutionSession, parse } from 'spl-lang';

const session = new ExecutionSession();
await session.run(parse('let count = 2\ndef double():\n    return count * 2'), { backend, logger });
await session.run(parse('count += 1'), { backend, logger });
const result = await session.run(parse('double()'), { backend, logger, source: 'cell:3' });
// result: { status: 'success', value: 6, hasValue: true }
```

Unlike one-shot `run`, a session returns the final expression's value. Explicit `return` and
`success` keep their usual behavior. Failures retain changes already made; no cells are replayed.
The optional `source` URI and `sourceVersion` are remembered by function definitions and returned
as `failure.source` and `failure.source_version`, so a host can locate errors without highlighting
stale edited source. Stores and traces are not session
options. The embedding host owns backend cleanup and cancellation; the VS Code notebook extension
uses a separate process per notebook so even unbounded deterministic code can be interrupted.

## Tests

```sh
npm test
```

Tests are offline. In PowerShell, `$env:SPL_LIVE_TESTS='1'; npm test` adds authenticated live tests.