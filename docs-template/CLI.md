# CLI & runtime

`spl` runs one workflow, a Markdown document or a [`.spl` file](Language.md#dedicated-spl-files),
prints its result on stdout and logs on stderr, and reports the outcome through its exit code.
Requires Node.js >=24.15.0.

## Usage

```bash
spl <workflow.md> [options] [--arg value ...]
spl <workflow.spl> [options] [--arg value ...]
spl <workflow.md> --trace run.jsonl
spl login <openai|anthropic|google>
spl logout [openai|anthropic|google]
```

| Option | Description |
| --- | --- |
| `--arg <value>` | Script argument exposed as `args[i]`; repeatable, also `--arg=value` |
| `--human <answer>` | Answer a human question without prompting; repeatable in question order, also `--human=answer` |
| `--model <id>` | Model for every call, overriding per-call and frontmatter models |
| `--provider <name>` | `openai`, `anthropic` or `google`; model IDs also accept `provider/model` |
| `--cwd <dir>` | Base folder for imports, relative paths, restrictions, tools and agents (default: current) |
| `--check` | Validate frontmatter, fences, blockquote controls, relative imports and `--mcp` config without running |
| `--log-level <level>` | `error`, `info` (default) or `debug` |
| `--silent` | No execution logs; human prompts still appear on stderr |
| `--timeout <s>` | Per model call (default 300) |
| `--mcp <file.json>` | MCP servers, see [MCP servers](#mcp-servers) |
| `--trace <file.jsonl>` | Append execution history, automatically resume or replay the same file; see [Traces and replay](#traces-and-replay) |
| `--pin` | Save a successful workflow with its recorded effects as [locked Markdown](#pinned-workflows) |
| `-v`, `--version` / `-h`, `--help` | Version / usage |

Each `--arg` is one string; use `--arg=--value` for values starting with a dash. Only `.md`
and `.spl` workflows are executable, and every option applies to both.

`--check` compiles every `js` and `ts` fence, parses `@CTL` and `@CODEGEN`, and verifies that
static relative `import` declarations point at existing files under `--cwd`. For a `.spl` file
it checks the blocks and the settings of their tags in the same way. Dynamic
`import('./x.js')` calls and package names are not checked. It runs no code and calls no model,
so it cannot find errors that only appear at run time, such as a misspelled variable.

Normal runs handle `human` calls and blockquote `ask_human` questions directly. The shell
prints each question on stderr and reads one line from stdin, preserving whitespace except the
line ending. Repeat `--human` to supply answers in question order without prompting:

```bash
spl lang/examples/color-poem.md
spl lang/examples/color-poem.md --human blue --human apple
```

Supplied answers are exact strings, including empty or multiline values; use `--human=--value`
for answers starting with a dash. Once supplied answers are exhausted, remaining questions prompt
normally, even with `--silent`. EOF without an answer is a script failure, not a suspension.
With `--trace`, recorded answers replay without prompting or consuming supplied `--human` values;
those values answer only new questions.

## Output and exit codes

stdout gets the `success` value: strings as-is, everything else as JSON. A workflow that ends
without calling `success` prints nothing. An uncaught failure prints its
[payload](Safety.md#failure-payload) instead. stderr gets logs, including every model prompt and
response, plus changes to shared variables with `--log-level debug`.
Use `--silent` when logs could expose sensitive data.

Each event has one header, without repeated continuation badges, panels or timestamps:

| Icon | Category | Color |
| --- | --- | --- |
| `->` | Model input: ask, think, agent, blockquote or codegen | Magenta |
| `<-` | Model output or runtime action | Cyan |
| `x` | Error | Red |
| `!` | Warning | Yellow |
| `i` | Information | Blue |
| `.` | Debug | Gray |
| `~` | Variable state | Yellow |

Generic embedding messages have a `- message` header. Explicit `log(...)` calls keep their
`[info|error|debug] log:` prefix for embedding/notebook compatibility.
State logs cover the shared top-level bindings: each event names the binding, its previous value
(`<unbound>` on initialization) and its new value. Bindings are compared after every top-level
statement and agent action, so a change made inside a function or loop is reported when that
statement finishes. Local variables, unchanged values and imported modules are not reported.
During trace replay, reconstruction is silent; newly completed steps remain visible.

Terminal stdin and stderr enable an isolated BetterTUI view on stderr, even when stdout is piped.
Event headers are bold when terminal styling is enabled. An animated trailing loading character
remains visible while the workflow runs, including while waiting for model output. It disappears
on exit and is never included in the expanded transcript or stdout.
Generated model prefaces (runtime/document preambles, guidance and initial blockquote context)
and every object/array start as folded summaries; the requested prompt stays visible.
Up/Down selects a payload in the viewport or scrolls text; Enter/Space toggles a visible selection;
Page Up/Down scrolls; Home/End reaches the ends. Other folds and selection survive arrival/resize.
The view initially follows new output. Scrolling away from the bottom pauses following, not
execution; scrolling back to the bottom with arrows, Page Down or End resumes following.
Expanded JSON uses two-space indentation and preserves original numeric/string tokens and duplicate
keys. Primitives and malformed JSON remain readable without misleading fold controls.

Model responses and available reasoning stream live in this view by default; `hide: true` suppresses reasoning.
Partial JSON is shown as text until the authoritative response arrives, when normal formatting
and folding apply. Streaming previews are separate from immutable log events, so the final
transcript contains each complete response once. Redirected logs remain expanded and append-only.
`--silent` also suppresses streaming previews.

`@CODEGEN` responses appear as JavaScript code with line numbers, preserved indentation and
syntax colors when terminal color is enabled. The same display handles incomplete streaming
code and definitions reused from cache. Generated codegen instructions and binding context start
folded, leaving the requested function description visible. Plain logs and the final transcript
retain the source without line-number gutters.

Normal finish restores input/cursor/screen state and leaves one complete expanded transcript on
stderr; no inspection keypress delays exit. Renderer/native failures are diagnosed and select plain
append-only output without changing workflow results. Non-terminal stdin/stderr, `TERM=dumb`,
embedded sinks, silent, help/version, auth and check-only never acquire the UI.
Before a human prompt, the interactive renderer exits and restores the terminal; subsequent logs
remain append-only so only the shell reads the answer. Supplied `--human` answers do not stop the UI.
If terminal-mode queries are unsupported or an alternate screen is already active, SPL diagnoses
the limitation and uses append-only output without taking over that screen.
Message, label and value controls are sanitized rather than executed as terminal instructions.

Colors are enabled automatically when stderr is a terminal, and disabled for redirected output
or `TERM=dumb`. Set `NO_COLOR=1` to disable color, or `FORCE_COLOR=1` to enable it when redirecting;
`FORCE_COLOR=0` disables color, and `NO_COLOR` takes precedence. stdout results and trace journals
remain plain, machine-readable data.
`--silent` suppresses execution logs; usage, syntax and trace-usage diagnostics still appear
on stderr so command-line errors are not hidden.
`--log-level` retains ordinary severity filtering; model transcripts appear at every non-silent
level, while state events appear only at `debug`. Forced color never enables cursor controls or keyboard input.

For example, `log('review:', review)` produces:

```text
[info] log: review:
{
  "findings": [],
  "count": 0
}
```

Embedded callers can pass structured data directly with `logger.info('review:', review)`.
Custom logger sinks default to plain text; `new Logger('info', sink, { color: true })`
explicitly enables styling. Non-JSON values such as errors, bigints and circular objects use
Node's inspect format instead of losing error details or failing JSON serialization.
An additive `eventSink` option delivers detached readonly events instead of strings, never both.
Neither library imports nor custom sinks load BetterTUI or start a process.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Script failure |
| `2` | Syntax or usage error, including a failed `--check` and a trace that does not match |
| `70` | Internal or infrastructure error |

## Traces and replay

```bash
spl flow.md --trace run.jsonl
spl flow.md --trace run.jsonl --silent  # resume or replay the same run
spl flow.md --trace next-run.jsonl     # start a fresh run
```

`--trace` is the only CLI persistence and replay option. A missing file starts a run. With an
existing file, the workflow's JavaScript runs again from the top while every recorded effect
returns its recorded result, which rebuilds variables, functions and loops; execution then
continues live at the first unrecorded effect. Records are appended and flushed durably:
existing bytes are never rewritten. A completed success or failure replays, prints the same
result and leaves the trace unchanged. To restart, choose a different JSONL file.

The version 2 JSONL journal records the effects of the library: model requests, raw responses
and failures (including repairs, reasoning, sampling and token budgets), blockquote decisions,
`readFile`/`writeFile`/`webFetch`/`webSearch`/`shell` outcomes, restrictions, human answers,
generated `@CODEGEN` code, accessed environment values and the final result. Completed effects
are not executed again: replay never contacts model providers or MCP, re-reads files through the
tools, repeats writes, commands or network calls, or prompts for recorded answers. It does not
recreate side effects if their files have been removed or changed.

**Only library effects are replayed.** Plain JavaScript is executed again on every run. Anything
your code does through Node.js APIs directly, such as `node:fs`, `fetch`, `child_process`,
`Date.now()` or `Math.random()`, is neither recorded nor suppressed. If such a value changes
and flows into a prompt or tool argument, the request no longer matches the journal and the run
stops with `trace effect history mismatch`.

Helper modules are part of that plain JavaScript. They are imported natively again on replay
and their source is not recorded: an edited helper can change the replayed result, and a deleted
one makes the replay fail.

Source, runtime, working directory and model/provider/MCP configuration must match. Arguments are
retained; omitting `--arg` reuses them, while explicitly different arguments fail. Requests must
match exactly and in order; malformed, mismatched and unused history fail without falling back
to live work.

After an interruption, a recorded human question or tool-free generation request can continue.
If a write, shell command or agent was interrupted between its durable intent and outcome, its
side effects may already have occurred: SPL reports an unresolved effect instead of repeating it.
Truncated final records likewise require manual recovery; SPL never truncates the log to guess.
Only one process can write a trace at a time; a lock from a terminated process is reclaimed.

For [code generation](LLM-commands.md#code-generation), traced runs also save
`<workflow>.<function>.js` sibling files with a description hash on the first line. New traced
runs reuse matching files without generation calls. Replay of an existing JSONL file uses its
recorded code regardless of later cache edits or removal.

Calls that run concurrently, such as `Promise.all(items.map(item => ask(...)))`, are recorded
one at a time in call order when a trace or pin is active, so they replay deterministically.

**Keep traces private.** They include prompts, responses, human answers and tool results.
Reading `env` captures the environment snapshot for deterministic reconstruction; a blockquote
`get_env` records only the requested value. These may contain secrets. New files use owner-only
permissions where supported. Trace logging is not a transaction system or a sandbox.

## Pinned workflows

```bash
spl flow.md --pin
spl flow.locked.md
```

`--pin` runs the workflow normally. Only after successful execution and backend cleanup does it
create a sibling `flow.locked.md`; the original file is unchanged, and an existing locked file is
never overwritten. `--check --pin` only validates and writes nothing. Failed or interrupted runs
do not produce a locked workflow.

The locked document retains the original Markdown and appends a versioned JSON execution journal
inside a double blockquote (`>>`) with a `spl-lock` fence. It includes every returned model response
(including repair attempts and reasoning), blockquote runtime decisions, tool outcomes, generated
code and human answers. This block is data, never another instruction to a model.

The runtime recognizes the journal automatically, including through the embedding `run` API.
Locked workflows run on their own; `ExecutionSession` rejects them instead of mixing pinned inputs with retained state.
The JavaScript runs again while recorded effects return their recorded results: no model/provider
or MCP calls, no library file/network/shell operations, no variable-store access and no human prompts.
The script arguments, CLI model override and working directory are retained. When `env` or a
blockquote environment tool is used, the environment snapshot is retained as well. Replay checks
source identity, execution options, request order and complete journal consumption; missing,
malformed, mismatched or unused entries fail without falling back to live calls.
As with traces, only library effects are pinned. Code that calls Node.js APIs directly runs
again, and helper modules are imported from disk again. A locked workflow that imports local
helpers is therefore not self-contained: it needs those files, an edited helper changes the
result and a deleted one fails. Keep everything a locked workflow must reproduce in its fences.

Pinning cannot be combined with `--trace`. Locked workflows also
reject MCP configuration and supplied human answers. Explicit argument, model or working-directory
overrides must match the pinned values. To change the workflow or its inputs, run the original file
with `--pin` again after moving or removing the old locked file.

A `.spl` workflow is pinned the same way: `spl flow.spl --pin` creates `flow.locked.spl`, which
keeps the original blocks and appends the journal in a `{lock}` block.

**Keep locked files private.** Responses, human answers, file contents, initial variables and any
accessed environment snapshot can contain secrets. Pinning is not a sandbox: the original run still
performs all requested actions; locked replay does not repeat those actions or recreate their effects.

## MCP servers

`--mcp` takes a file in VS Code's `mcp.json` format. MCP tools are available only to agents.

```json
{
  "servers": {
    "docs": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/tools/docs-server.js"],
      "env": { "TOKEN": "${env:DOCS_TOKEN}" },
      "tools": ["search"]
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "${env:REMOTE_AUTH}" },
      "timeout": 30000
    }
  }
}
```

* `type` is `stdio` (default), `http` or `sse`; always set it for remote servers.
* stdio servers use `command`, `args`, `env` and `cwd`; remote servers use `url` and `headers`.
* `tools` is an allowlist (`["*"]` or omitted allows all); `timeout` is in milliseconds per tool call.
* `${workspaceFolder}` expands to `--cwd`; `${env:NAME}` reads the environment and fails if missing.
  Keep secrets in the environment, not the file. Other VS Code variables and settings are rejected.

Use the server names in [`restrict({ mcp })`](Safety.md#restrictions), and `--check` to validate the
file without starting servers. Only load configurations you trust.

## Models and authentication

Every model call uses the official OpenAI, Anthropic or Google client in a fresh conversation.
See [Getting started](Getting-started.md#install) for API-key login and environment variables.
A call without credentials, or a provider/model access error, fails with `llm_error`.
Workflows without model calls, check-only operations and replay do not initialize providers or MCP.

Model precedence: CLI `--model`, per-call `model`, frontmatter `model`, provider default.
IDs may be bare (`claude-sonnet-4-5`, `gemini-2.5-flash`, `gpt-4.1`) or qualified
(`anthropic/claude-sonnet-4-5`). Recognizable bare IDs infer their provider; custom IDs can be
qualified or used with `--provider`. Unknown models are passed unchanged to the selected provider
and fail if unavailable; there is no fallback to another model.

Provider selection uses explicit `--provider`, then the model's prefix/inferred provider,
then `SPL_PROVIDER`, then the saved login default, then a single configured provider.
An explicit provider conflicting with the model's provider is an error. Multiple configured
providers without a selection are an error, not an arbitrary choice.
Defaults are `gpt-4.1` (OpenAI), `claude-sonnet-4-5` (Anthropic), and `gemini-2.5-flash` (Google).

Reasoning levels map to OpenAI reasoning effort, Anthropic thinking budgets/adaptive effort,
and Google thinking budgets/levels. Unsupported recognized combinations warn and use the model
default; effective provider, model and reasoning effort are retained in traces. Runtime tools
execute sequentially, MCP results remain traceable, and timeout/cancellation never accepts a
partial answer. Failed actions are not automatically retried.
Live output remains non-reproducible; contain variance with schemas, assertions and traces.

## Runtime limits

* **One thread.** Fences run as ordinary JavaScript on the main thread. A long synchronous loop
  blocks log rendering, timers and Ctrl+C handling until it yields. Put `await` points in long
  loops, or move heavy work to a worker thread or child process.
* **Await library calls.** A model call or tool that is not awaited keeps running in the
  background, and if it fails the rejected promise crashes the process instead of producing a
  failure payload.
* **Replay covers library effects only.** Traces and locked workflows do not record Node.js APIs
  called directly or the source of helper modules; see [Traces and replay](#traces-and-replay).
* **`restrict` is not a sandbox.** It governs the library's tools, agents and MCP servers; see
  [Restrictions](Safety.md#restrictions).

## Embedding

The package that provides the CLI is also the library. Besides the
[workflow functions](Language.md#the-library-in-nodejs-programs), it exports what is needed to
run whole documents from a program.

```js
import fs from 'node:fs';
import { parseMarkdown, run, Logger, AiBackend } from 'spl-lang';

const logger = new Logger('silent');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
    const workflow = parseMarkdown(fs.readFileSync('flow.md', 'utf8'));
    const result = await run(workflow, { backend, logger, file: 'flow.md', cwd: process.cwd(), args: ['first'] });
    if (result.status === 'success') console.log(result.value);
    else console.error(result.failure);
} finally {
    await backend.close();
}
```

`parseMarkdown` compiles every fence and throws `SplSyntaxError` (with `line` and `col`) for
invalid documents. `parseSpl` does the same for the text of a [`.spl` file](Language.md#dedicated-spl-files)
and returns the same kind of workflow. `run` resolves to `{ status: 'success', value, hasValue }` or
`{ status: 'failure', failure }`; `hasValue` is `false` when the document ended without `success`.

| `run` option | Meaning |
| --- | --- |
| `backend`, `logger` | Required: the model backend and the log destination |
| `cwd` | Working directory for imports, relative paths, restrictions and tools (default: process directory) |
| `args` | Script arguments (default `[]`, never `process.argv`) |
| `model` | Overrides frontmatter and per-call models, like `--model` |
| `human` | `(question, line) => string` or a promise of one; answers `human` and `ask_human` |
| `file` | Path of the workflow document; names generated-code caches |
| `source`, `sourceVersion` | URI and version reported as `source` and `source_version` in failure payloads |
| `trace`, `pin` | An open `Trace` or `Pin` to record and replay effects |
| `store` | Embedding-only initial bindings and final snapshot; not available with a trace |

Embedded runs never read stdin themselves; provide a `human` handler when a workflow asks for
input. `parse(code, { language, model })` wraps plain JavaScript (or `'ts'`) as a one-fence
workflow, `parseInstruction(text)` wraps one blockquote, and `checkWorkflow(workflow, cwd)`
returns the missing-import problems that `--check` reports.

Use `Trace.open(file, { source: workflow.lines.join('\n'), runtime: 'your-runtime-id', cwd, args, configuration })`
and pass the result as `trace`. After execution and backend cleanup, call `trace.finish(result)`;
always call `trace.close()` in `finally`. The same file automatically resumes or replays.

A custom backend implements `call(request)` and `close()`, which makes offline tests simple:

```js
import { parse, run, Logger } from 'spl-lang';

const backend = {
    async call(request) { return { text: '4', effective: {} }; },
    async close() {},
};
const workflow = parse("success(await ask('2 + 2?', { fmt: 'integer' }));");
const result = await run(workflow, { backend, logger: new Logger('silent') });
```

`request.prompt` is the fully assembled prompt and `request.kind` is `ask`, `think` or `agent`;
only `agent` requests may run tools. For blockquotes the request has `naturalLanguage: true`,
the `runtimeTools` definitions and `invokeAction({ name, arguments })` to perform a tool call.
`AiBackend` accepts an optional `provider` alongside `logger`, `cwd`, `timeoutMs` and `mcpServers`.
The `CopilotBackend` export is an alias of `AiBackend` kept for existing imports, not a Copilot connection.

### Interactive sessions

`ExecutionSession` keeps one shared scope across calls, for notebooks and REPLs. Each call runs
one cell; unlike `run`, the value of a cell's final expression is returned.

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

Calls must not overlap. A failure keeps the changes made before it; nothing is replayed.
`source` and `sourceVersion` are remembered by the functions a cell defines and returned in
failure payloads, so a host can locate an error in the cell that defined the failing function.
Sessions do not accept `store`, `trace` or `pin`. The host owns backend cleanup and cancellation;
the VS Code notebook runs each session in a separate process so that even an endless loop can be
stopped.
