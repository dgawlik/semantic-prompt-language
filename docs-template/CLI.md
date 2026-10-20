# CLI & runtime

The interpreter runs one script file to completion. It prints the result on stdout, logs on stderr and reports the outcome through its exit code.

## Usage

```bash
spl <script.spl> [--log-level error|info|debug] [--silent] [--model <id>]
                 [--store <file.json> | --store-module <module>]
                 [--timeout <s>] [--cwd <dir>] [--mcp <file.json>] [--check]
                 [--record <file.jsonl> | --replay <file.jsonl>]
spl login
spl logout
```

From a checkout use `node dist/cli.js` or `npx file:./lang`. The package installs two equivalent binaries: `spl` and `spl-lang`. A script run expects exactly one script file; `login` and `logout` are separate commands, see [Authentication](#authentication).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--log-level <level>` | `info` | `error`, `info` or `debug`. Logs go to stderr. |
| `--silent` | off | Suppress all logs; only the result is printed. |
| `--model <id>` | SDK default | Overrides per-call model, then header model, then SDK default. |
| `--mcp <file.json>` | none | MCP servers in VS Code `mcp.json` format; see [MCP configuration](#mcp-configuration). |
| `--store <file.json>` | — | Persist top-level variables in a JSON file. |
| `--store-module <path>` | — | Custom store module exporting `createStore()`. Mutually exclusive with `--store`. |
| `--timeout <seconds>` | `300` | Per-LLM-call timeout. |
| `--record <file.jsonl>` | none | Create a new generation recording. Rejects existing files and agent calls. |
| `--replay <file.jsonl>` | none | Offline generation replay. Blocks agents, writes, shell, network, and stores. Mutually exclusive with record. |
| `--cwd <dir>` | current dir | Base directory for relative paths, `restrict` checks, and the working directory of tools and the model. |
| `--check` | off | Parse the script and validate any `--mcp` config without starting servers or making LLM calls. |
| `-v`, `--version` | — | Print the version. |
| `-h`, `--help` | — | Print usage. |

## Output streams & exit codes

### stdout

The value of `success` or of a top-level `return`: strings raw, everything else as pretty-printed JSON. On an uncaught failure: the failure payload.

### stderr

Logs, `log()` output, syntax errors, and for every LLM call the effective model and reasoning effort.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Uncaught script failure. |
| `2` | Syntax or usage error. |
| `70` | Internal error in the interpreter. |

## Logging

| Level | Shows |
| --- | --- |
| `error` | Errors (for example a variable store that could not be saved), the full assembled prompt and raw response of every LLM call, and deterministic statement traces. |
| `info` (default) | Everything above plus warnings, one line per LLM call with its effective parameters and duration, `think{show=True}` reasoning, `log()` messages. |
| `debug` | Everything above plus tool invocations, caught failures and active restrictions. |

LLM requests and responses use the `[llm]` tag at every non-silent level. They may contain sensitive data; use `--silent` to suppress all logs.

Each executed SPL statement is traced to stderr under `[deterministic]`, with its line number, statement kind and source line, at every non-silent level. Loop bodies are traced for each iteration; skipped branches are not traced. This records control flow, including statements wrapping LLM calls, not intermediate expression values.

```bash
spl script.spl --silent                    # result only
spl script.spl --log-level debug 2> run.log   # keep the full transcript, pipe the result
```

## MCP configuration

Pass a JSON file using the VS Code `mcp.json` shape: a top-level `servers` object maps server names to connection settings. MCP tools are available only during explicit `agent` calls. Generation never starts MCP servers, and record/replay rejects agents.

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
spl script.spl --mcp mcp.json --check
spl script.spl --mcp mcp.json
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

Stores are independent of generation recordings. `--replay` rejects both `--store` and `--store-module` before loading user modules or writing state.

Scripts can keep state between runs. `--store vars.json` loads top-level variables from the file at start and writes them back at exit — **also on failure**. Functions are not persisted. The file must contain a JSON object; writes are atomic (temp file + rename).

```bash
spl examples/journal.spl --store journal.json
```

### Custom stores

`--store-module ./mystore.mjs` plugs in your own persistence. The module exports `createStore()` (or a default export of that shape) returning an object with `load()` and `save(vars)`:

`mystore.mjs`

```js
import fs from 'node:fs';

export function createStore() {
  const file = './state.json';
  return {
    load() { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; },
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

Each live call opens a fresh session through the GitHub Copilot SDK. Generation (`?` and `think`) exposes no tools and aborts unexpected permission requests. Only explicit `agent` sessions expose runtime and configured MCP tools under active restrictions. Pass context explicitly; previous calls are not implicit conversation history.

## Offline generation record/replay

```bash
spl examples/triage-issues.spl --record triage.jsonl
spl examples/triage-issues.spl --replay triage.jsonl --silent
```

Record creates a new JSONL file and never overwrites one. Replay needs no credentials and never constructs a Copilot client or starts MCP servers. Both modes reject agents. Recording captures successful backend responses, including invalid JSON that subsequently triggers a repair; transport errors are not recorded.

Requests must match exactly and in order: call kind, assembled prompt (including schema/guidance), requested model, reasoning effort, and show-reasoning flag. Changed prompts, exhausted recordings, and unused entries fail explicitly. Replay re-runs JSON parsing, schema validation, repair prompts, and deterministic code.

Replay permits local reads only. Writes, shell, network, agents, and persistent stores fail before execution. It never replays external actions and is not a general workflow cache. Split those stages out of replayable scripts.

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
