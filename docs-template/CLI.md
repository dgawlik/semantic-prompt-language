# CLI & runtime

`spl` runs one Markdown workflow, prints its result on stdout and logs on stderr, and reports
the outcome through its exit code.

## Usage

```bash
spl <workflow.md> [options] [--arg value ...]
spl <workflow.md> --checkpoint run.jsonl
spl <workflow.md> --resume run.jsonl [--answer-for ID (--answer text | --answer-file file)]
spl login | logout
```

| Option | Description |
| --- | --- |
| `--arg <value>` | Script argument exposed as `$args[i]`; repeatable, also `--arg=value` |
| `--model <id>` | Model for every call, overriding per-call and frontmatter models |
| `--cwd <dir>` | Base folder for paths, restrictions, tools and agents (default: current) |
| `--check` | Validate frontmatter, syntax and `--mcp` config without running |
| `--log-level <level>` | `error`, `info` (default) or `debug` |
| `--silent` | No logs; only the result |
| `--timeout <s>` | Per model call (default 300) |
| `--mcp <file.json>` | MCP servers, see [MCP servers](#mcp-servers) |
| `--trace` / `--replay <file.jsonl>` | Record or replay model calls, see [Traces and replay](#traces-and-replay) |
| `--store <file.json>` / `--store-module <path>` | Persist top-level variables, see [Variable stores](#variable-stores) |
| `--checkpoint`, `--resume`, `--answer-for`, `--answer`, `--answer-file` | [Human input](Safety.md#human-in-the-loop) |
| `-v`, `--version` / `-h`, `--help` | Version / usage |

Each `--arg` is one string; use `--arg=--value` for values starting with a dash.

## Output and exit codes

stdout gets the `success` value: strings as-is, everything else as JSON. An uncaught failure prints
its [payload](Safety.md#failure-payload) instead. stderr gets logs, including every model prompt and
response and a trace of executed statements. Use `--silent` when logs could expose sensitive data.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Script failure |
| `2` | Syntax or usage error |
| `3` | Waiting for human input |
| `70` | Internal or infrastructure error |

## Traces and replay

```bash
spl flow.md --trace run.jsonl
spl flow.md --replay run.jsonl --silent
```

`--trace` writes every `ask`, `think`, `agent` and blockquote request with its raw response or failure
to a new JSONL file. `--replay` feeds those results back without contacting Copilot or MCP servers,
so you can iterate on code and guards for free. Requests must match exactly and in order (prompt,
kind, model, reasoning); a mismatch, missing or unused entry fails.

Replay is not a dry run: explicit `read_file`, `write_file`, `shell` and web calls, and stores, still run.
Agent actions are not repeated, and their side effects are not recreated.

```json
{"format":"spl-trace","version":1}
{"request":{"kind":"ask","prompt":"Question","model":null,"reasoningEffort":null,"showReasoning":false},"response":{"text":"Answer","effective":{"model":"actual-model"}}}
```

The older `--record` mode writes generation-only recordings; replaying them blocks writes, shell,
network, agents and stores. Traces and recordings contain full prompts and answers, so keep them private.

## Variable stores

`--store state.json` loads top-level variables at start and saves them at exit, even after a failure.
Functions and `$env`/`$args` are not saved. See [journal.md](../lang/examples/journal.md).

`--store-module ./store.mjs` uses a module exporting `createStore()`, which returns synchronous
`load()` and `save(vars)` methods:

`store.mjs`

```js
import fs from 'node:fs';

export function createStore() {
  const file = './state.json';
  return {
    load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}),
    save: (vars) => fs.writeFileSync(file, JSON.stringify(vars)),
  };
}
```

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

Every model call goes to GitHub Copilot through the Copilot SDK in a fresh session. See
[Getting started](Getting-started.md#install) for `spl login`. A call without credentials fails with
`llm_error`. The SDK has no temperature or seed, so live output is not reproducible. Contain variance
with schemas, assertions and traces.

## Embedding

```js
import { parseMarkdown, run, Logger, CopilotBackend } from 'spl-lang';
import fs from 'node:fs';

const logger = new Logger('silent');
const backend = new CopilotBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
  const program = parseMarkdown(fs.readFileSync('flow.md', 'utf8'));
  const result = await run(program, { backend, logger, cwd: process.cwd(), args: ['first'] });
  if (result.status === 'success') console.log(result.value);
  else console.error(result.failure ?? result.request);
} finally {
  await backend.close();
}
```

`run` returns `success` (with `value`), `failure` (with `failure`), or `waiting_for_input` when given a
`Checkpoint`. Options include `backend`, `logger`, `cwd`, `args` (default `[]`, never `process.argv`),
`store`, `model` and `checkpoint`. Wrap a backend in `TraceBackend` to record, or use `ReplayBackend`
to replay; close it to check for unused entries. A custom backend implements `call(request)` and `close()`;
only requests of kind `agent` may run tools. Raw `parse` and `run` still accept plain SPL source.
