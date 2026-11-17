# CLI & runtime

`spl` runs, checks, compiles and documents `.spl` workflows. A run prints its result on stdout
and its logs on stderr, and reports the outcome through its exit code.
Requires Node.js >=24.15.0.

## Commands

```bash
spl run <file.spl> [options] [--arg value ...]
spl check <file.spl>
spl compile <file.spl>
spl doc <file.spl> [--format md|html]
spl login <openai|anthropic|google>
spl logout [openai|anthropic|google]
```

| Command | Effect |
| --- | --- |
| `spl run <file.spl>` | Compile the workflow in memory and run it in place |
| `spl check <file.spl>` | Scan and type-check it, without running |
| `spl compile <file.spl>` | Write an importable TypeScript module beside the file |
| `spl doc <file.spl>` | Print its documentation, as Markdown or HTML |
| `spl login <provider>` | Save an API key and select the default provider |
| `spl logout [provider]` | Remove saved credentials; environment variables are unchanged |
| `spl --version`, `spl --help` | Version and usage, also `-v` and `-h` |

`run`, `check`, `compile` and `doc` take exactly one `.spl` file. A file name without a command
is a usage error that suggests `spl run`.

## spl run

| Option | Description |
| --- | --- |
| `--arg <value>` | Script argument exposed as `args[i]`; repeatable, also `--arg=value` |
| `--human <answer>` | Answer a human question without prompting; repeatable in question order, also `--human=answer` |
| `--model <id>` | Model for every call, overriding block settings, call options and file defaults |
| `--provider <name>` | `openai`, `anthropic` or `google`; model ids also accept `provider/model` |
| `--cwd <dir>` | Base folder for relative tool paths, restrictions, agents and MCP servers (default: current) |
| `--log-level <level>` | `error`, `info` (default) or `debug` |
| `--silent` | No execution logs; human prompts still appear on stderr |
| `--debug` | Step through the workflow in the [terminal view](#stepping-with---debug) |
| `--timeout <s>` | Per model call (default 300) |
| `--mcp <file.json>` | MCP servers, see [MCP servers](#mcp-servers) |
| `--trace <name>` | Write execution history to `<name>.jsonl` and an HTML report to `<name>.html` (`<name>.jsonl` is also accepted); see [Traces and replay](#traces-and-replay) |

Each `--arg` is one string; use `--arg=--value` for values starting with a dash.

The file is compiled before anything runs: a syntax error in the code or in a block stops the
run with exit code 2. Types are erased, not checked; use [`spl check`](#spl-check) for that.
`--cwd` does not affect imports, which resolve from the file that contains them.

Runs handle `human` calls and the agents' `askHuman` questions directly. In the
[terminal view](#terminal-view) you type the answer in its status box; otherwise the shell
prints each question on stderr and reads one line from stdin, preserving whitespace except the
line ending. Repeat `--human` to supply answers in question order without prompting:

```bash
spl run examples/color-poem.spl
spl run examples/color-poem.spl --human blue --human apple
```

Supplied answers are exact strings, including empty or multiline values; use `--human=--value`
for answers starting with a dash. Once supplied answers are exhausted, remaining questions prompt
normally, even with `--silent`. Reaching the end of stdin without an answer is a failure of the
workflow, not a suspension. With `--trace`, recorded answers replay without prompting or
consuming supplied `--human` values; those values answer only new questions.

## spl check

`spl check` scans the workflow and every `.spl` file it imports, then type-checks them with the
TypeScript compiler. Nothing runs and no model is called.

```bash
spl check flow.spl
```

```text
x error flow.spl:4:12: Cannot find name 'notes'.
x error flow.spl:7:7: Type 'string' is not assignable to type 'number'.
```

Problems are printed on stderr as `file:line:column: message`, at positions of the `.spl` file,
and the exit code is 2. A clean file prints nothing and exits with 0.

| It reports | Example |
| --- | --- |
| Scanner errors | A misspelled header key, an unmatched `---`, a key that does not apply to the mode |
| Syntax errors in code | A missing bracket, `await` in a function that is not `async` |
| Type errors in code | `const total: number = 'ten'` |
| References that do not exist | `@notes` when no `notes` is in scope: `Cannot find name 'notes'` |
| Outputs used with the wrong type | `->[Int] @=name` when `name` is a string; a property that `outputType` does not have |
| Imports that do not resolve | A missing module or a missing export |

* **What is checked** is the TypeScript the scanner generates, which has every construct on its
  source line, together with the library's declarations and the Node.js types.
* **The options** are `strict` with `noImplicitAny` and `useUnknownInCatchVariables` off,
  `erasableSyntaxOnly`, ES modules with bundler resolution, and JSON modules.
* **Scanner errors come first.** When the scanner finds problems, they are reported without
  running the type checker.
* **It needs TypeScript,** which is a dependency of the package. While it works it keeps a
  `.spl-check-*` folder beside the workflow and removes it afterwards.

`spl check` cannot find errors that only appear at run time, such as an answer that does not
fit its type.

## spl compile

`spl compile` writes `<name>.ts` beside the workflow, and beside every `.spl` file it imports
with a relative path. It prints the paths it wrote.

```bash
spl compile examples/imports/run.spl
```

For [imports/math.spl](../lang/examples/imports/math.spl) the module is:

```ts
// Generated by `spl compile` from math.spl. Edit the .spl file, not this module.
import { __spl, success, args } from 'spl-lang';
export function square(n: number): number {
    return n * n;
}

export default async function workflow(args: string[] = [], options?: __spl.WorkflowOptions): Promise<unknown> {
    return __spl.workflow({ url: import.meta.url }, args, options, async () => {
success(args.map(Number).map(square));
    });
}
```

* **The default export runs the workflow:**
  `export default async function workflow(args, options)`. The file body runs inside it.
  `import`s and `export`ed declarations stay at module level, and imports of other `.spl` files
  point at their compiled `.ts` modules.
* **`success(value)` is the result.** The function resolves to `value`, or to `undefined` when
  the workflow just ends. A failure rejects with a [`Failure`](Safety.md#try--catch).
* **With `options`, it builds its own runtime** and closes it when the workflow ends. The
  options are those of [`configure`](Language.md#the-library-in-nodejs-programs): `model`,
  `provider`, `cwd`, `logLevel`, `logger`, `backend`, `timeoutMs`, `mcpServers`, `trace` and `human`.
* **Without `options`, it joins the runtime in use:** the workflow that called it, or the
  default runtime of the library.
* **It needs `spl-lang` and Node.js.** The module imports the package, and Node.js erases its
  types when it is imported.
* **Exports must stand alone.** An `export`ed declaration that uses a workflow variable is an
  error; see [What a .spl module exports](Language.md#what-a-spl-module-exports).

```ts
import workflow, { square } from './math.ts';

const squares = await workflow(['2', '3'], { logLevel: 'error' });
console.log(squares, square(7));
```

## spl doc

`spl doc` prints the workflow as a document: Markdown by default, one self-contained HTML page
with `--format html`.

```bash
spl doc greet.spl
spl doc greet.spl --format html > greet.html
```

| In the file | In the document |
| --- | --- |
| A `//* ... *//` comment | Prose, as written |
| A run of top-level code between comments and blocks | One `ts` code listing, imports and ordinary comments included |
| A top-level block | A callout headed by its mode, with its settings as a small table and its instruction as quoted text |
| The file defaults | A callout headed `file defaults` |
| A block nested inside code | Part of the code listing, as written |

For the `greet.spl` of [Getting started](Getting-started.md#write-a-workflow) it prints:

````markdown
# Greeting

Greets the person named by the first argument.

```ts
const name = args[0] ?? 'world';
```

> **ask block**
>
> | Setting | Value |
> | --- | --- |
> | `outputVar` | `greeting` |
>
> Write a one-line greeting for @name.

```ts
success(greeting);
```
````

The HTML format uses the styles and the syntax highlighter of this documentation site. A file
with syntax problems is reported like in `spl run`, not documented. The
[Examples](Examples.md) page is generated from the example files with `spl doc`.

## Output and exit codes

stdout gets the `success` value: strings as-is, everything else as JSON. A workflow that ends
without calling `success` prints nothing. An uncaught failure prints its
[payload](Safety.md#failure-payload) instead. stderr gets logs, including every model prompt and
response, plus changes to variables with `--log-level debug`.
Use `--silent` when logs could expose sensitive data.

Each event has one header:

| Icon | Category | Color |
| --- | --- | --- |
| `->` | Model input: ask, agent or codegen | Magenta |
| `<-` | Model output or agent action | Cyan |
| `x` | Error | Red |
| `!` | Warning | Yellow |
| `i` | Information | Blue |
| `.` | Debug | Gray |
| `~` | Variable state | Yellow |
| `*` | Tool call: `* tool readFile path`, followed by its content; `failed` on errors | Green / red |

`log(...)` calls keep their `[info|error|debug] log:` prefix.
Tool calls from code (`readFile`, `writeFile`, `webFetch`, `webSearch`, `shell`), from agent
blocks, from `agent()` and from MCP servers are logged at `info` with what they acted on and
their content: the file read or written, the fetched body, search results, command output, MCP
result or error.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Uncaught failure of the workflow |
| `2` | Syntax, type or usage error, including problems found by `spl check` and a trace that does not match |
| `70` | Internal or infrastructure error |
| `130` | Cancelled with Ctrl+C, or with `e` while stepping |

### Terminal view

When stdin and stderr are terminals, logs appear in a full-screen [Ink](https://github.com/vadimdemedes/ink)
view on the alternate screen of stderr, even when stdout is piped. A header names the workflow, the
timeline follows new output, and a status box at the bottom shows a spinner while the workflow runs,
a human question with its answer field, or the final outcome. The available keys are always listed
under it.

| Item | Shown as |
| --- | --- |
| Model prompt | `❯ ask prompt`; generated text such as guidance, restrictions and the instructions for agents is a collapsed `▸ preamble` line, and the workflow's own prompt follows with a `│` gutter |
| Model response | `● ask response` with the text or expanded JSON output; generated code is a collapsed `▸ JavaScript · N lines` |
| Tool call | `● readFile path` (green) or `✗` (red): files, `webFetch`, `webSearch`, MCP and multi-line variable payloads start compressed (`▸ 42 lines`), while `shell` execution starts expanded (`▾ N lines`) |
| Diagnostics | `✗` error, `!` warning, `•` info, `·` debug, `~` state, `▪` script `log(...)` |

File contents, `webFetch`, `webSearch`, generated code and preambles start collapsed; `shell`
output and model JSON responses start expanded. Up/Down selects a
foldable item, Space or Enter expands or collapses it, Page Up/Down scrolls and Home/End reach the
ends. Until you navigate, the newest item is selected, so Space toggles the latest tool call. Expanded
files, fetched pages, search results and generated code appear as they would in a file: line numbers,
preserved indentation and syntax colors for JavaScript, TypeScript, JSON and Markdown. Expanded JSON
uses two-space indentation and preserves original numeric/string tokens and duplicate keys.
Scrolling away from the bottom pauses following, not execution; End resumes following.

Model responses and available reasoning stream live in this view by default; `hide: true` suppresses
reasoning. The live preview is replaced by the complete response when it arrives. `--silent` also
suppresses streaming previews.

`human()` questions and the agents' `askHuman` questions are answered in the status box: type the
answer and press Enter. Supplied `--human` answers are used first, without prompting.

When the workflow ends, the view stays open with `✓ Completed` or `✗ Failed` until you press `e`.
Exiting restores the terminal exactly as it was and prints nothing to stderr; stdout then gets only
the result or failure payload. Ctrl+C cancels a running workflow (exit code 130) and also closes a
finished one. If the view cannot start or stops unexpectedly, SPL reports it and continues with
append-only logs without changing the workflow result. Non-terminal stdin/stderr, `TERM=dumb`,
`--silent`, help and version, login and logout, `check`, `compile` and `doc` never start the view.
Message, label and value controls are sanitized rather than executed as terminal instructions.

Redirected logs are plain, append-only and fully expanded: JSON is indented, tool content and
generated code follow their header without line-number gutters, and nothing waits for a key.

### Stepping with `--debug`

`--debug` stops the workflow before its first step and lets you run it one step at a time. A step
is a `---` block or a top-level statement. Blocks inside functions and loops are steps too;
function declarations, imports and exported declarations are not.

| Key | Action |
| --- | --- |
| `n` | Next: run the next step, then stop again |
| `v` | Variables: show the top-level variables as JSON |
| `c` | Continue: run to the end without stopping |
| `e` | Exit: stop the workflow immediately (exit code 130) |

Each stop adds a `▶ statement · line N` or `▶ agent block · line N` item with the step's source
collapsed, and the status box shows the line it will run. `v` lists every top-level variable of
the workflow; one that has not been assigned yet shows `<uninitialized>`.

`--debug` needs the terminal view, so it cannot be combined with `--silent` or used with
redirected stdin or stderr.

### State logs

`--log-level debug` adds state events: every change to a top-level variable, with its previous
and its new value.

```text
~ state count @ global (scope-1): <unbound> -> 0
~ state count @ global (scope-1): 0 -> 1
```

* **Top-level variables are compared** before each top-level statement and when the workflow
  ends. A change made inside a function or a loop is reported when the statement that caused
  it has finished.
* **Outputs of nested blocks are reported too.** A block inside a function or a loop has no
  top-level variable, so its outputs appear as `name @ block at line 12 (block-12)`.
* **Locals are not reported.** Variables inside functions, unchanged values and imported
  modules produce no events.
* **Replay is silent.** While a trace replays recorded effects, state events are not repeated.

### Colors and levels

Colors are enabled automatically when stderr is a terminal, and disabled for redirected output
or `TERM=dumb`. Set `NO_COLOR=1` to disable color, or `FORCE_COLOR=1` to enable it when redirecting;
`FORCE_COLOR=0` disables color, and `NO_COLOR` takes precedence. stdout results and trace journals
remain plain, machine-readable data. Forced color never enables cursor controls or keyboard input.

`--silent` suppresses execution logs; usage, syntax and trace-usage diagnostics still appear
on stderr so command-line errors are not hidden.
`--log-level` filters by severity: model prompts and responses appear at every level that is not
silent, tool calls from `info`, and state events only at `debug`.

For example, `log('review:', review)` produces:

```text
[info] log: review:
{
  "findings": [],
  "count": 0
}
```

## Traces and replay

```bash
spl run flow.spl --trace run
spl run flow.spl --trace run --silent       # resume or replay the same run
spl run flow.spl --trace next-run           # start a fresh run
```

`--trace <name>` (or `--trace <name>.jsonl`) produces two files: `<name>.jsonl` with the durable
append-only execution trace, and `<name>.html` with a self-contained HTML report presenting the
workflow run, its `ask` and `agent` inputs and outputs, agent loop tool calls, result and source.
A missing `.jsonl` file starts a run. With an existing `.jsonl` file, the workflow's code runs again from the top while every recorded effect
returns its recorded result, which rebuilds variables, functions and loops; execution then
continues live at the first unrecorded effect. Records are appended and flushed durably:
existing bytes in `<name>.jsonl` are never rewritten. A completed success or failure replays, prints the same
result and leaves `<name>.jsonl` unchanged. To restart, choose a different trace name.

The JSONL journal records the effects of the library: model requests, raw responses and
failures (including repairs, reasoning, sampling and token budgets), `decision()` answers, every
decision of an agent block, `readFile`/`writeFile`/`webFetch`/`webSearch`/`shell` outcomes, restrictions, human
answers, generated code, accessed environment values and the final result. Blocks go through
the same journal as `ask()` and `agent()`. Completed effects are not executed again: replay
never contacts model providers or MCP, re-reads files through the tools, repeats writes,
commands or network calls, or prompts for recorded answers. It does not recreate side effects
if their files have been removed or changed.

**Only library effects are replayed.** Plain code is executed again on every run. Anything
your code does through Node.js APIs directly, such as `node:fs`, `fetch`, `child_process`,
`Date.now()` or `Math.random()`, is neither recorded nor suppressed. If such a value changes
and flows into a prompt or tool argument, the request no longer matches the journal and the run
stops with `trace effect history mismatch`.

Imported modules are part of that plain code. They are loaded again on replay and their source
is not recorded, whether they are `.js` helpers or other `.spl` files: an edited module can
change the replayed result, and a deleted one makes the replay fail.

The source of the workflow, the runtime, the working directory and the model/provider/MCP
configuration must match the recording. Arguments are retained; omitting `--arg` reuses them,
while explicitly different arguments fail. Requests must match exactly and in order; malformed,
mismatched and unused history fail without falling back to live work.

After an interruption, a recorded human question, a model call without tools, a `decision()`, a read or the
next decision of an agent block can continue. If a write, a shell command or an `agent()` call
was interrupted between its durable intent and outcome, its side effects may already have
occurred: SPL reports an unresolved effect instead of repeating it. Truncated final records
likewise require manual recovery; SPL never truncates the log to guess. Only one process can
write a trace at a time; a lock from a terminated process is reclaimed.

Calls that run concurrently, such as `Promise.all(items.map(item => ask(...)))`, are recorded
one at a time in call order when a trace is active, so they replay deterministically.

**Keep traces private.** They include prompts, responses, human answers and tool results.
Reading `env`, in code or as `@env.NAME` in a block, captures the environment for deterministic
reconstruction; an agent's `getEnv` records only the requested value. These may contain
secrets. New files use owner-only permissions where supported. A trace is not a transaction
system or a sandbox.

## MCP servers

`--mcp` takes a file in VS Code's `mcp.json` format. MCP tools are available only to agents:
agent blocks and `agent()` calls.

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

The model sees each MCP tool under a camelCase name: `mcp`, the position of its server among
the servers available to the call, and the tool's name in PascalCase. The `search` tool of the
first server is `mcp0Search`, and `search_docs` of the second is `mcp1SearchDocs`. Logs and
restrictions use the configured names instead: `docs/search`.

Use the server names in [`restrict`](Safety.md#restrictions), as
[mcp.spl](../lang/examples/mcp.spl) does. An invalid file is a usage error before the run
starts. Only load configurations you trust.

## Models and authentication

Every model call uses the official OpenAI, Anthropic or Google client in a fresh conversation.
`decision()` calls the OpenAI and Google decision endpoints with their fixed models
(`gpt-6-luna`, `gemini-decision-1`) and simulates one on Anthropic.
See [Getting started](Getting-started.md#install) for API-key login and environment variables.
A call without credentials, or a provider/model access error, fails with `llm_error`.
Workflows without model calls, `check`, `compile`, `doc` and replay do not initialize providers or MCP.

Model precedence: `--model`, then the `model` of the block or call, then the file default, then
the provider default; see [Models and reasoning](LLM-commands.md#models-and-reasoning).
Ids may be bare (`claude-sonnet-4-5`, `gemini-2.5-flash`, `gpt-4.1`) or qualified
(`anthropic/claude-sonnet-4-5`). Recognizable bare ids infer their provider; custom ids can be
qualified or used with `--provider`. Unknown models are passed unchanged to the selected provider
and fail if unavailable; there is no fallback to another model.

Provider selection uses explicit `--provider`, then the model's prefix or inferred provider,
then `SPL_PROVIDER`, then the saved login default, then a single configured provider.
An explicit provider conflicting with the model's provider is an error. Multiple configured
providers without a selection are an error, not an arbitrary choice.
Defaults are `gpt-4.1` (OpenAI), `claude-sonnet-4-5` (Anthropic), and `gemini-2.5-flash` (Google).

Tools run one at a time, MCP results remain traceable, and timeout or cancellation never
accepts a partial answer. Failed actions are not automatically retried.
Live output remains non-reproducible; contain variance with types, assertions and traces.

## Runtime limits

* **One thread.** Code runs as ordinary JavaScript on the main thread. A long synchronous loop
  blocks log rendering, timers and Ctrl+C handling until it yields. Put `await` points in long
  loops, or move heavy work to a worker thread or child process.
* **Await library calls.** A model call or tool that is not awaited keeps running in the
  background, and if it fails the rejected promise crashes the process instead of producing a
  failure payload.
* **Replay covers library effects only.** Traces do not record Node.js APIs called directly or
  the source of imported modules; see [Traces and replay](#traces-and-replay).
* **`restrict` is not a sandbox.** It governs the library's tools, agents and MCP servers; see
  [Restrictions](Safety.md#restrictions).

## Embedding

The package that provides the CLI is also the library. Besides the
[workflow functions](Language.md#the-library-in-nodejs-programs), it exports what is needed to
run `.spl` source from a program.

```ts
import fs from 'node:fs';
import { run, Logger, AiBackend } from 'spl-lang';

const logger = new Logger('silent');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
    const source = fs.readFileSync('flow.spl', 'utf8');
    const result = await run(source, { backend, logger, file: 'flow.spl', args: ['first'] });
    if (result.status === 'success') console.log(result.value);
    else console.error(result.failure);
} finally {
    await backend.close();
}
```

`run` compiles the source in memory and runs it once. Syntax problems throw `SplSyntaxError`
(with `problems`, `line` and `col`) before anything runs. Otherwise it resolves to
`{ status: 'success', value, hasValue }` or `{ status: 'failure', failure }`; `hasValue` is
`false` when the workflow ended without `success`.

| `run` option | Meaning |
| --- | --- |
| `backend`, `logger` | Required: the model backend and the log destination |
| `file` | Path of the workflow: its imports resolve from here, generated code is cached beside it and failures name it (default: `workflow.spl` in `cwd`) |
| `cwd` | Working directory for relative tool paths, restrictions and tools (default: process directory) |
| `args` | Script arguments (default `[]`, never `process.argv`) |
| `model` | Overrides file defaults and the models of blocks and calls, like `--model` |
| `human` | `(question, line) => string` or a promise of one; answers `human` and `askHuman` |
| `trace` | An open `Trace` to record and replay effects |
| `beforeStep` | Awaited before each `---` block and each top-level statement; `--debug` pauses here |

Embedded runs never read stdin themselves; provide a `human` handler when a workflow asks for
input. `beforeStep` receives `{ kind, line, language, source, variables() }`: `kind` is `code`
or `block`, `language` is `ts`, `ask`, `agent` or `codegen`, and `variables()` returns a
JSON-shaped snapshot of the top-level variables.

A [compiled module](#spl-compile) is the other way to run a workflow from a program: import it
and call its default export.

| Export | Purpose |
| --- | --- |
| `scan(source)` | The front scanner: the generated TypeScript, the blocks, comments, file defaults and problems |
| `compile(source)` | Scan, erase types and analyse; throws `SplSyntaxError` |
| `check(file)` | What `spl check` does; returns the problems |
| `documentMarkdown(source, options?)`, `documentHtml(source, title)` | What `spl doc` prints |
| `HEADER_KEYS`, `MODES` | The header keys and block modes, for editors |
| `Trace`, `loadMcpConfig`, `login`, `logout`, `authStatus` | Traces, MCP configuration and credentials |

Use `Trace.open(file, { source, runtime: 'your-runtime-id', cwd, args, configuration })`
and pass the result as `trace`. After execution and backend cleanup, call `trace.finish(result)`;
always call `trace.close()` in `finally`. The same file automatically resumes or replays.

A custom backend implements `call(request)` and `close()`, which makes offline tests simple:

```ts
import { run, Logger } from 'spl-lang';

const backend = {
    async call() { return { text: '4', effective: {} }; },
    async close() {},
};
const result = await run("success(await ask('2 + 2?', { fmt: 'integer' }));", { backend, logger: new Logger('silent') });
```

`request.prompt` is the fully assembled prompt and `request.kind` is `ask` or `agent`; only
`agent` requests may run tools. For an agent block the request also has the `runtimeTools`
definitions and `invokeAction({ name, arguments })` to perform a tool call.
`AiBackend` accepts an optional `provider` alongside `logger`, `cwd`, `timeoutMs` and `mcpServers`.

Embedded callers can pass structured data to a logger directly with `logger.info('review:', review)`.
Custom logger sinks default to plain text; `new Logger('info', sink, { color: true })`
explicitly enables styling. An `eventSink` option delivers detached read-only events instead of
strings, and a `streamSink` receives live model previews. Neither library imports nor custom
sinks load the terminal view or read input.
