# CLI & runtime

`spl` runs one Markdown workflow, prints its result on stdout and logs on stderr, and reports
the outcome through its exit code. Requires Node.js >=24.15.0.

## Usage

```bash
spl <workflow.md> [options] [--arg value ...]
spl <workflow.md> --trace run.jsonl
spl login <openai|anthropic|google>
spl logout [openai|anthropic|google]
```

| Option | Description |
| --- | --- |
| `--arg <value>` | Script argument exposed as `$args[i]`; repeatable, also `--arg=value` |
| `--human <answer>` | Answer a human question without prompting; repeatable in question order, also `--human=answer` |
| `--model <id>` | Model for every call, overriding per-call and frontmatter models |
| `--provider <name>` | `openai`, `anthropic` or `google`; model IDs also accept `provider/model` |
| `--cwd <dir>` | Base folder for paths, restrictions, tools and agents (default: current) |
| `--check` | Validate frontmatter, syntax and `--mcp` config without running |
| `--log-level <level>` | `error`, `info` (default) or `debug` |
| `--silent` | No execution logs; human prompts still appear on stderr |
| `--timeout <s>` | Per model call (default 300) |
| `--mcp <file.json>` | MCP servers, see [MCP servers](#mcp-servers) |
| `--trace <file.jsonl>` | Append execution history, automatically resume or replay the same file; see [Traces and replay](#traces-and-replay) |
| `--pin` | Save a successful workflow as self-contained [locked Markdown](#pinned-workflows) |
| `-v`, `--version` / `-h`, `--help` | Version / usage |

Each `--arg` is one string; use `--arg=--value` for values starting with a dash.

Normal runs handle `human` expressions and blockquote `ask_human` questions directly. The shell
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

stdout gets the `success` value: strings as-is, everything else as JSON. An uncaught failure prints
its [payload](Safety.md#failure-payload) instead. stderr gets logs, including every model prompt and
response and committed variable-state changes. Use `--silent` when logs could expose sensitive data.

Each event has one header, without repeated continuation badges, panels or timestamps:

| Icon | Category | Color |
| --- | --- | --- |
| `->` | Model input: ask, think, agent or blockquote | Magenta |
| `<-` | Model output or runtime action | Cyan |
| `x` | Error | Red |
| `!` | Warning | Yellow |
| `i` | Information | Blue |
| `.` | Debug | Gray |
| `~` | Variable state | Yellow |

Generic embedding messages have a `- message` header. Explicit script logs keep their
`[info|error|debug] log:` prefix for embedding/notebook compatibility.
State logs identify each affected binding's defining scope, previous value (`<unbound>` on
initialization) and new value. Parameters, loop/handler bindings, closures and shared mutations
are included. A shared mutation is one event listing all affected aliases. Same-value assignments,
no-op methods, reads, scope exits and initial runtime/store baselines do not create events.
Automatic executed-source and control-flow step traces no longer appear at any verbosity.
Historical trace reconstruction is suppressed; newly completed steps remain visible.

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
Enter/Space never jumps to an off-screen selection, and End reaches the output tail even when
text or a streaming preview extends beyond the last payload.
Expanded JSON uses two-space indentation and preserves original numeric/string tokens and duplicate
keys. Primitives and malformed JSON remain readable without misleading fold controls.

Model responses and available reasoning stream live in this view by default; `hide=True` suppresses reasoning.
Partial JSON is shown as text until the authoritative response arrives, when normal formatting
and folding apply. Streaming previews are separate from immutable log events, so the final
transcript contains each complete response once. Redirected logs remain expanded and append-only.
`--silent` also suppresses streaming previews.

Normal finish restores input/cursor/screen state and leaves one complete expanded transcript on
stderr; no inspection keypress delays exit. Renderer/native failures are diagnosed and select plain
append-only output without changing workflow results. Non-terminal stdin/stderr, `TERM=dumb`,
embedded sinks, silent, help/version, auth and check-only never acquire the UI.
Before a human prompt, the interactive renderer exits and restores the terminal; subsequent logs
remain append-only so only the shell reads the answer. Supplied `--human` answers do not stop the UI.
Before native rendering, the child queries cursor visibility and alternate-screen state.
Unsupported queries or an already-active alternate screen select diagnosed append-only output;
SPL does not clear an existing application's alternate screen. The parent owns the input-mode
snapshot and cursor restoration before native code runs, including after a child crash.
Message, label and value controls are sanitized rather than executed as terminal instructions.

Colors are enabled automatically when stderr is a terminal, and disabled for redirected output
or `TERM=dumb`. Set `NO_COLOR=1` to disable color, or `FORCE_COLOR=1` to enable it when redirecting;
`FORCE_COLOR=0` disables color, and `NO_COLOR` takes precedence. stdout results and trace journals
remain plain, machine-readable data.
`--silent` suppresses execution logs; usage, syntax and trace-usage diagnostics still appear
on stderr so command-line errors are not hidden.
`--log-level` retains ordinary severity filtering; model transcripts and state events appear at
every non-silent level. Forced color never enables cursor controls or keyboard input.

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
Neither library imports nor custom sinks load BetterTUI or start a process. Automatic observation
uses non-invoking snapshots: callable identities, cycle references and accessor placeholders,
without running getters, serializers or custom inspectors.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Script failure |
| `2` | Syntax or usage error |
| `70` | Internal or infrastructure error |

## Traces and replay

```bash
spl flow.md --trace run.jsonl
spl flow.md --trace run.jsonl --silent  # resume or replay the same run
spl flow.md --trace next-run.jsonl     # start a fresh run
```

`--trace` is the only CLI persistence and replay option. A missing file starts a run; an existing
file reconstructs local variables, functions, loops and shared mutations from its recorded external
inputs, then continues at the first unrecorded step. Records are appended and flushed durably:
existing bytes are never rewritten. A completed success or failure replays deterministically,
prints the same result and leaves the trace unchanged. To restart, choose a different JSONL file.

The version 2 JSONL journal records model requests, raw responses and failures (including repairs,
reasoning, sampling and token budgets), blockquote decisions, explicit file/shell/web tool outcomes,
human answers and the terminal result. Completed effects are not executed again: replay never
contacts model providers or MCP, re-reads files, repeats writes/commands/network calls, or prompts
for recorded answers. It does not recreate side effects if their files have been removed or changed.

Source, runtime, working directory and model/provider/MCP configuration must match. Arguments are
retained; omitting `--arg` reuses them, while explicitly different arguments fail. Requests must
match exactly and in order; malformed, mismatched and unused history fail without falling back
to live work. Legacy trace and generation-recording formats are not accepted.

After an interruption, a recorded human question or tool-free generation request can continue.
If a write, shell command or agent was interrupted between its durable intent and outcome, its
side effects may already have occurred: SPL reports an unresolved effect instead of repeating it.
Truncated final records likewise require manual recovery; SPL never truncates the log to guess.
Only one process can write a trace at a time; a lock from a terminated process is reclaimed.

Human input still uses stdin or repeatable `--human` flags; there are no suspension envelopes,
answer IDs or waiting exit codes. The former `--store`, `--store-module`, `--record`, `--replay`,
`--checkpoint`, `--resume`, `--answer-for`, `--answer` and `--answer-file` options are removed.

**Keep traces private.** They include prompts, responses, human answers and tool results.
`$env` access captures the environment snapshot for deterministic reconstruction; a blockquote
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
(including repair attempts and reasoning), blockquote runtime decisions, explicit tool outcomes and
human answers. This block is data, never another instruction to a model.

The runtime recognizes the journal automatically, including through the embedding `run` API.
Locked workflows are standalone; `ExecutionSession` rejects them instead of mixing pinned inputs with retained state.
It substitutes recorded answers and reconstructs shared state deterministically: no model/provider
or MCP calls, file/network/shell operations, repeated writes, variable-store access or human prompts.
The initial variable-store snapshot, script arguments, CLI model override and working directory are
retained. When `$env` or a blockquote environment tool is used, the environment snapshot is retained
as well. Replay checks source identity, execution options, request order and complete journal
consumption; missing, malformed, mismatched or unused entries fail without falling back to live calls.

Pinning cannot be combined with `--trace`. Locked workflows also
reject MCP configuration and supplied human answers. Explicit argument, model or working-directory
overrides must match the pinned values. To change the workflow or its inputs, run the original file
with `--pin` again after moving or removing the old locked file.

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

Use the server names in [`restrict mcp`](Safety.md#restrictions), and `--check` to validate the
file without starting servers. Only load configurations you trust.

## Models and authentication

Every model call uses the official OpenAI, Anthropic or Google client in a fresh conversation.
See [Getting started](Getting-started.md#install) for API-key login and environment variables.
A call without credentials, or a provider/model access error, fails with `llm_error`.
Deterministic workflows, check-only operations and replay do not initialize providers or MCP.

Model precedence is unchanged: CLI `--model`, per-call `model`, frontmatter `model`, provider default.
IDs may be bare (`claude-sonnet-4-5`, `gemini-2.5-flash`, `gpt-4.1`) or qualified
(`anthropic/claude-sonnet-4-5`). Recognizable bare IDs infer their provider; custom IDs can be
qualified or used with `--provider`. Unknown models are passed unchanged to the selected provider
and fail if unavailable; there is no fallback to another model.

Provider selection uses explicit `--provider`, then the model's prefix/inferred provider,
then `SPL_PROVIDER`, then the saved login default, then a single configured provider.
An explicit provider conflicting with the model's provider is an error. Multiple configured
providers without a selection are an error, not an arbitrary choice.
Defaults are `gpt-4.1` (OpenAI), `claude-sonnet-4-5` (Anthropic), and `gemini-2.5-flash` (Google).

SPL reasoning levels map to OpenAI reasoning effort, Anthropic thinking budgets/adaptive effort,
and Google thinking budgets/levels. Unsupported recognized combinations warn and use the model
default; effective provider, model and reasoning effort are retained in traces. Runtime tools
execute sequentially, MCP results remain traceable, and timeout/cancellation never accepts a
partial answer. Failed actions are not automatically retried.
Live output remains non-reproducible; contain variance with schemas, assertions and traces.

## Embedding

```js
import { parseMarkdown, run, Logger, AiBackend } from 'spl-lang';
import fs from 'node:fs';

const logger = new Logger('silent');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
  const program = parseMarkdown(fs.readFileSync('flow.md', 'utf8'));
  const result = await run(program, { backend, logger, cwd: process.cwd(), args: ['first'] });
  if (result.status === 'success') console.log(result.value);
  else console.error(result.failure);
} finally {
  await backend.close();
}
```

`run` returns `success` (with `value`) or `failure` (with `failure`).
Options include `backend`, `logger`, `cwd`, `args` (default `[]`, never `process.argv`),
`store` (embedding-only bindings/snapshots), `model`, `human` and `trace`. A `human(question, line)` handler returns a string or
`Promise<string>` for both human expressions and blockquote `ask_human` calls. Embedded runs never
read stdin themselves; provide this handler when requesting new human input.
Use `Trace.open(file, { source: program.lines.join('\n'), runtime: 'your-runtime-id', cwd, args, configuration })`
and pass the result as `trace`. After execution and backend cleanup, call `trace.finish(result)`;
always call `trace.close()` in `finally`. The same file automatically resumes or replays.
Trace runs cannot use an embedding variable store; local state is reconstructed from history.
A custom backend implements `call(request)` and `close()`;
only requests of kind `agent` may run tools. Raw `parse` and `run` still accept plain SPL source.
`AiBackend` accepts an optional `provider` alongside `logger`, `cwd`, `timeoutMs` and `mcpServers`.
The previous `CopilotBackend` export is an alias for embedding compatibility, not a Copilot connection.
