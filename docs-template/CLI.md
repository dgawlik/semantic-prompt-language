# CLI & runtime

The interpreter runs one opted-in Markdown file to completion or a human-input boundary. It prints the result on stdout, logs on stderr and reports the outcome through its exit code. Raw `.spl` files are rejected; add the required extension/version frontmatter and wrap the code in an SPL fence. See [document structure](Language.md#program-structure).

## Usage

```bash
spl <script.md> [--log-level error|info|debug] [--silent] [--model <id>]
                 [--store <file.json> | --store-module <module>]
                 [--timeout <s>] [--cwd <dir>] [--mcp <file.json>] [--check]
                 [--trace <file.jsonl> | --record <file.jsonl> | --replay <file.jsonl>]
                 [--arg <value> ...]
spl <script.md> --checkpoint <run.jsonl> [--silent]
spl <script.md> --resume --checkpoint <run.jsonl> [--answer-for <id> --answer <text> | --answer-for <id> --answer-file <file>]
spl <script.md> --resume <run.jsonl> [--answer-for <id> --answer <text> | --answer-for <id> --answer-file <file>]
spl login
spl logout
```

From a checkout use `node dist/cli.js` or `npx file:./lang`. The package installs two equivalent binaries: `spl` and `spl-lang`. A script run expects exactly one script file; `login` and `logout` are separate commands, see [Authentication](#authentication).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--log-level <level>` | `info` | `error`, `info` or `debug`. Logs go to stderr. |
| `--silent` | off | Suppress all logs; only the result is printed. |
| `--model <id>` | SDK default | Overrides per-call model, then frontmatter model, then SDK default. |
| `--arg <value>` | none | Repeatable string argument exposed through `$args`, in order. Also accepts `--arg=value`. |
| `--mcp <file.json>` | none | MCP servers in VS Code `mcp.json` format; see [MCP configuration](#mcp-configuration). |
| `--store <file.json>` | — | Persist top-level variables in a JSON file. |
| `--store-module <path>` | — | Custom store module exporting `createStore()`. Mutually exclusive with `--store`. |
| `--timeout <seconds>` | `300` | Per-LLM-call timeout. |
| `--trace <file.jsonl>` | none | Create a new workflow trace of all LLM requests, responses, and failures, including agents. Works with `--silent`. |
| `--record <file.jsonl>` | none | Create a new generation recording, including natural-language code submissions. Rejects existing files and action-taking agent calls. |
| `--replay <file.jsonl>` | none | Replay recorded LLM/agent results without Copilot or MCP. Explicit script tools and stores run normally for workflow traces; legacy generation recordings retain their restrictions. Mutually exclusive with `--trace` and `--record`. |
| `--checkpoint <file>` | none | Create a new resumable-run journal; never overwrite an existing file. With bare `--resume`, open and append to this existing journal instead. |
| `--resume [file]` | none | Inspect pending human input, or continue with a matching answer. Omit the file when using `--checkpoint <file>`; `--resume <file>` remains supported. |
| `--answer-for <id>` | none | Exact pending `request_id`, not `run_id`; required with either answer flag. |
| `--answer <text>` | none | Exact free-text answer, including `--answer=` for an empty string. Requires `--resume`. |
| `--answer-file <file>` | none | UTF-8 answer file; preserves whitespace. Mutually exclusive with `--answer`. |
| `--cwd <dir>` | current dir | Base directory for relative paths, `restrict` checks, and the working directory of tools and the model. |
| `--check` | off | Parse the script and validate any `--mcp` config without starting servers or making LLM calls. |
| `-v`, `--version` | — | Print the version. |
| `-h`, `--help` | — | Print usage. |

## Script arguments and environment

```bash
spl --arg=first --arg="two words" example.md
spl example.md --arg first --arg "two words"
spl example.md --arg= --arg=--literal-option
```

Options may appear before or after the single script file. Each `--arg` supplies exactly
one string: the first is `$args[0]`, the second `$args[1]`, and so on. Empty values
are preserved. Use `--arg=--literal-option` for strings beginning with `-`.
Extra positional arguments are still usage errors; use `--arg` for each script argument.
Without arguments `$args` is empty, and out-of-range indexes return `None`.

`$env.NAME` or `$env['NAME']` reads the process environment as a string, returning `None`
for absent variables and `''` for present-but-empty ones. Both special variables are
read-only snapshots, including through aliases; they are not automatically persisted.
They work during replay using the current process environment and supplied arguments.
Neither is evaluated by `--check`. See [runtime inputs](Language.md#runtime-inputs-env-and-args).

## Output streams & exit codes

### stdout

The value of `success` or of a top-level `return`: strings raw, everything else as pretty-printed JSON. On an uncaught failure: the failure payload.

Resumable runs instead emit a single [JSON protocol envelope](#resumable-human-input),
including when `--silent` is enabled.

### stderr

Logs, `log()` output, syntax errors, and for every LLM call the effective model and reasoning effort.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Uncaught script failure. |
| `2` | Syntax or usage error. |
| `3` | Waiting for human input in a resumable run; not a script failure. |
| `70` | Internal or checkpoint persistence/infrastructure error. |

## Logging

| Level | Shows |
| --- | --- |
| `error` | Errors (for example a variable store that could not be saved), the full assembled prompt and raw response of every LLM call, and deterministic statement traces. |
| `info` (default) | Everything above plus warnings, one line per LLM call with its effective parameters and duration, `think(show=True)` reasoning, `log()` messages. |
| `debug` | Everything above plus tool invocations, caught failures and active restrictions. |

LLM requests and responses use the `[llm]` tag at every non-silent level. They may contain sensitive data; use `--silent` to suppress all logs.

Each executed SPL statement is traced to stderr under `[deterministic]`, with its line number, statement kind and source line, at every non-silent level. Loop bodies are traced for each iteration; skipped branches are not traced. This records control flow, including statements wrapping LLM calls, not intermediate expression values.

```bash
spl script.md --silent                    # result only
spl script.md --log-level debug 2> run.log   # keep the full transcript, pipe the result
```

## MCP configuration

Pass a JSON file using the VS Code `mcp.json` shape: a top-level `servers` object maps server names to connection settings. MCP tools are available only during live `agent` calls. Generation and replay never start MCP servers. Workflow tracing supports agents; legacy generation recording rejects them.

### Remote HTTP or SSE server

For a URL-based server, explicitly set `"type": "http"` (or `"sse"` for an SSE endpoint). Omitting `type` defaults to `stdio`, so a config containing only `url` and `headers` is rejected.

```json
{
  "servers": {
    "socialtoai": {
      "type": "http",
      "url": "https://mcp.socialtoai.com/mcp",
      "headers": {
        "Authorization": "${env:SOCIALTOAI_AUTHORIZATION}"
      },
      "timeout": 30000
    }
  }
}
```

Keep credentials out of the JSON file. Set `SOCIALTOAI_AUTHORIZATION` in the environment before running SPL. Its value must be the complete header value required by the service (for example `Bearer YOUR_TOKEN` if that service requires Bearer authentication). SPL substitutes the value verbatim; it does not add an authentication scheme. Omit `headers` when the server does not require them.

### Local stdio server

A stdio server runs a local executable that speaks MCP over stdin/stdout. Replace the script path below with your MCP server's entry point. Keep the executable in `command` and its arguments as separate strings in `args`, not as one shell command.

```json
{
  "servers": {
    "docs": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/tools/docs-server.js"],
      "env": { "TOKEN": "${env:DOCS_TOKEN}" },
      "cwd": "${workspaceFolder}",
      "tools": ["search"],
      "timeout": 30000
    }
  }
}
```

### Configuration fields

Server names use letters, digits, underscores, dots or hyphens. They are the names used in `restrict mcp`, not a server's URL or executable name.

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | All | `"stdio"` (default), `"http"` or `"sse"`. Always specify it for remote servers. |
| `command` | stdio, required | Non-empty string: executable name or path. |
| `args` | stdio, optional | Array of argument strings, such as `["server.js", "--port", "3000"]`. |
| `env` | stdio, optional | Object mapping environment variable names to string values. |
| `cwd` | stdio, optional | Working directory string; defaults to SPL's `--cwd`. Relative values resolve against `--cwd`. |
| `url` | http/sse, required | Full MCP endpoint URL using `http:` or `https:`. |
| `headers` | http/sse, optional | Object mapping HTTP header names to string values. |
| `tools` | All, optional | Array of tool names exposed by the server, for example `["search"]`. Omitted or `["*"]` allows all; `[]` disables the server. This is a configuration allowlist, which `restrict mcp` can only narrow. |
| `timeout` | All, optional | Positive number of milliseconds per MCP tool call, such as `30000`. This is separate from SPL's `--timeout` in seconds per LLM call. |

### Variables, paths and unsupported settings

* `${workspaceFolder}` expands to SPL's `--cwd`, not the folder containing the JSON file.

* `${env:NAME}` expands an environment variable in `command`, `args`, `env`, `cwd`, `url` or `headers` values. A missing variable is a configuration error, including during `--check`.

* The `--mcp` filename is relative to the invoking directory, independently of `--cwd`. The config may be anywhere; `.vscode/mcp.json` is a convention, not a requirement.

* Use strict JSON: no comments or trailing commas. Windows backslashes inside JSON strings must be escaped (`"C:\\tools\\server.js"`); forward slashes avoid this escaping.

* SPL supports the documented VS Code configuration subset, not every VS Code setting. Interactive `inputs`, `${input:...}`, other variable forms, `envFile` and other unsupported server fields are rejected explicitly.

### Validate, run and restrict access

With a script and config in the current directory:

```bash
spl script.md --mcp mcp.json --check
spl script.md --mcp mcp.json
```

`--check` validates script syntax, JSON structure, settings and variable expansion without starting MCP servers or making LLM calls. It does not verify credentials, endpoint reachability, executable availability or tool names.

Use server names from the JSON keys to limit tool access:

```spl
restrict mcp 'socialtoai' {
    let news = agent 'Use the configured socialtoai MCP tools to summarize current news.'
}
```

`restrict mcp 'socialtoai/tool_name'` allows just one tool; replace `tool_name` with an actual tool exposed by that server. A `tools` list in the config uses unqualified names such as `"search"`, not `"socialtoai/search"`.

Only load trusted configurations: they can launch local programs or connect to remote services. Server names and `server/tool` selectors in [`restrict mcp`](Restrictions.md#mcp-servers-and-tools) are case-sensitive. Without an MCP restriction all configured tools are allowed; no unconfigured MCP server is approved.

## Variable store

Stores are independent of traces and recordings. Workflow trace replay loads and saves them normally. Replaying legacy `--record` files rejects both `--store` and `--store-module` before loading user modules or writing state.

Scripts can keep state between runs. `--store vars.json` loads top-level variables from the file at start and writes them back at exit — **also on failure**. Functions are not persisted. The file must contain a JSON object; writes are atomic (temp file + rename).

```bash
spl examples/journal.md --store journal.json
```

### Custom stores

`--store-module ./mystore.mjs` plugs in your own persistence. The module exports `createStore()` (or a default export of that shape) returning an object with `load()` and `save(vars)`:

`mystore.mjs`

```js
import fs from 'node:fs';

export function createStore() {
  const file = './state.json';
  return {
    load() { return fs.existsSync(file) ask JSON.parse(fs.readFileSync(file, 'utf8')) : {}; },
    save(vars) { fs.writeFileSync(file, JSON.stringify(vars)); },
  };
}
```

**Synchronous interface**

`load()` and `save()` are synchronous, so a store must complete its I/O before returning. `createStore()` itself may be async. `save()` receives plain JSON-compatible values (`vars`), never functions.

## Authentication

LLM calls go to GitHub Copilot, so the runtime needs credentials. Run `spl login` once: it does nothing if the runtime is already authenticated (an earlier login, a Copilot CLI or `gh` login, or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`); otherwise it starts GitHub's device flow, prints a one-time code and a URL, waits until you confirm in the browser, verifies the token with the Copilot runtime and saves it to `~/.spl/credentials.json` (folder overridable with `SPL_HOME`). Scripts pick that token up automatically. `spl logout` deletes the saved file.

```bash
spl login
# Open https://github.com/login/device and enter the code: ABCD-1234
# Authenticated with GitHub Copilot as octocat.
```

A script that needs an LLM without credentials fails with `llm_error` and asks you to run `spl login`. Scripts that never call an LLM (and `--check`) need no login.

## Backend

Each live call opens a fresh session through the GitHub Copilot SDK. Generation (`ask` and `think`) exposes no tools and aborts unexpected permission requests. Only explicit `agent` sessions expose runtime and configured MCP tools under active restrictions. Pass context explicitly; previous calls are not implicit conversation history.

## Resumable human input

`human 'question'` emits JSON and exits `3`, without reading stdin or keeping a
process waiting. Start with `--checkpoint`, inspect with `--resume`, and provide
one answer bound to the pending request ID:

```bash
spl examples/human-review.md --checkpoint run.jsonl --silent
spl examples/human-review.md --resume --checkpoint run.jsonl --silent
spl examples/human-review.md --resume --checkpoint run.jsonl --answer-for REQUEST_ID --answer-file feedback.txt
```

`--resume run.jsonl` is equivalent to `--resume --checkpoint run.jsonl`. Each
answer may pause again with a new `request_id`; keep using the same journal and
the latest request ID, not the run ID. Completed runs cannot resume.

See [Human in the loop](HITL.md) for the full protocol, no-repeat guarantees,
same-workspace limits, sensitive-state handling, and GitHub Actions integration.
Resumable mode cannot combine with stores or trace/record/replay.

## Workflow traces and replay

```bash
spl workflow.md --trace workflow.jsonl
spl workflow.md --replay workflow.jsonl --silent
```

`--trace` creates a new file and never overwrites an existing one. It instruments every backend call from `ask`, `think`, and `agent`, including repair attempts and failures that the script catches. Tracing is independent of log level and `--silent`. `--trace`, `--record`, and `--replay` are mutually exclusive. `--check` does not create a trace.

Replay needs no model credentials and never constructs a Copilot client or starts MCP servers. It supplies the recorded raw response or failure at each LLM call. JSON parsing, schemas, repairs, assertions, and normal control flow run again. Requests must match exactly and in order: call kind, assembled prompt (including schema/guidance), requested model, reasoning effort, and show-reasoning flag. Changed inputs, exhaustion, and unused entries fail explicitly.

**Replay is not a dry run or a snapshot restore.** Explicit script calls to `read_file`, `write_file`, `shell`, `web_fetch`, and `web_search` still execute under normal restrictions. Persistent stores also load and save normally, including after script failure. Environment variables, arguments, files, and explicit tool outputs come from the current run. Replay can therefore perform writes and network requests; those inputs must still produce matching LLM requests.

Agent results are replayed without executing the agent or repeating its runtime tools or MCP calls. Only the completed agent call's request and result/failure are captured, not the SDK's internal conversation or individual tool exchanges. Replay does not recreate files or other side effects produced by the original agent; provision required state separately.

### Trace format

The UTF-8 JSONL file begins with a versioned header, followed by one entry per completed backend call:

```json
{"format":"spl-trace","version":1}
{"request":{"kind":"ask","prompt":"Question","model":null,"reasoningEffort":null,"showReasoning":false},"response":{"text":"Answer","reasoning":"Optional reasoning","effective":{"model":"actual-model"}}}
```

Requests are structured objects; absent model/effort values are `null`. Responses preserve unparsed text, optional reasoning, and effective backend parameters. A failed call has `error` instead of `response`, for example:

```json
{"request":{"kind":"ask","prompt":"Question","model":null,"reasoningEffort":null,"showReasoning":false},"error":{"status_code":"llm_error","reason":"transport failed"}}
```

Backend errors replay as `llm_error`; runtime failures retain their original category and reason. Source locations are attached by the current script. Incomplete or malformed entries and unknown format versions are rejected explicitly.

**Protect traces**

Files contain assembled prompts and raw responses, including source data and reasoning. Treat them as sensitive; do not commit private traces. Trace files are created with owner-only permissions where supported by the operating system.

## Offline generation record/replay

```bash
spl examples/triage-issues.md --record triage.jsonl
spl examples/triage-issues.md --replay triage.jsonl --silent
```

This legacy mode remains supported with its original `spl-generation`, version 1 format. Record creates a new JSONL file and never overwrites one. Replay needs no credentials and never constructs a Copilot client or starts MCP servers. Both modes reject agents. Recording captures successful backend responses, including invalid JSON that subsequently triggers a repair; transport errors are not recorded.

Requests must match exactly and in order: call kind, assembled prompt (including schema/guidance), requested model, reasoning effort, and show-reasoning flag. Changed prompts, exhausted recordings, and unused entries fail explicitly. Replay re-runs JSON parsing, schema validation, repair prompts, and deterministic code.

Replay of these legacy files permits local reads only. Writes, shell, network, agents, and persistent stores fail before execution. Use `--trace` for workflow replay with explicit side effects and agent results.

**Protect recordings**

Files contain assembled prompts and raw responses, including source data. Treat them as sensitive; do not commit private recordings. Record mode still executes explicit raw I/O normally.

## Reproducibility

Control flow, arithmetic and interpolation are deterministic. For LLM calls reproducibility is **best effort**:

* The Copilot SDK has no `temperature` or `seed` setting, so the language has none either.

* The shared `reasoning` modifier maps to SDK effort; unsupported effort logs a warning and uses the model default.

* Use schemas, assertions, bounded generation repair, and offline record/replay to contain variance; see [repair behavior](Failures.md#bounded-generation-repair).

```text
[info] llm ask call: {"backend":"copilot-sdk","model":"gpt-5.5","reasoningEffort":null} (1840 ms)
```
