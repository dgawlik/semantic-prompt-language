<img src="https://raw.githubusercontent.com/dgawlik/semantic-prompt-language/HEAD/vscode/icon.png" alt="SPL logo" width="128" height="127">

# spl-lang

The SPL interpreter and CLI. Runs Markdown workflows that mix Python-like `spl` fences with
natural-language blockquotes. Requires Node.js 20+. See the
[documentation](https://dgawlik.github.io/semantic-prompt-language/) for the full guide.

## Run

```sh
npm install -g spl-lang      # or, in this folder: npm install && node dist/cli.js
spl login
spl examples/hi.md
```

`spl login` reuses Copilot CLI, `gh` or `GH_TOKEN`/`GITHUB_TOKEN` credentials, or runs GitHub's device
flow. Workflows without model calls, `--check` and replay work without signing in.

```text
spl workflow.md [--arg value ...] [--model id] [--cwd dir] [--mcp file.json] [--timeout s]
                [--store file.json | --store-module module]
                [--trace file.jsonl | --record file.jsonl | --replay file.jsonl]
                [--log-level error|info|debug] [--silent] [--check]
spl workflow.md --checkpoint run.jsonl
spl workflow.md --resume run.jsonl [--answer-for ID (--answer text | --answer-file file)]
spl login | logout
```

The result goes to stdout and logs to stderr. Exit codes: `0` success, `1` script failure,
`2` syntax or usage error, `3` waiting for human input, `70` internal error.
See [CLI & runtime](../docs-template/CLI.md).

Console logs use consistent tags and indented, syntax-colored JSON. Color is automatic on stderr
terminals; `NO_COLOR` disables it and `FORCE_COLOR=1` enables it for redirected logs.
stdout results and trace/checkpoint files remain plain data.

## Language in brief

```spl
let Rating = {'type': 'object', 'properties': {'score': {'type': 'integer'}}, 'required': ['score']}
let review = read_file('review.txt')
let rating = ask(schema=Rating, repairs=2) 'Rate this review from 1 to 5: {review}'
assert 1 <= rating.score and rating.score <= 5 'score out of range'
restrict './out':
    write_file('./out/rating.json', json_stringify(rating))
success rating
```

* Exact tools `read_file`, `write_file`, `web_fetch`, `web_search` and `shell` never call a model.
* `ask` and `think` generate values without tools; `agent` can act, within `restrict` scopes.
* Blockquotes run as agent commands, not generated SPL. Their tools can call existing functions,
  load/save shared variables, read environment values, request checkpointed human input, and use
  runtime tools and configured MCP servers. Explicit `agent` expressions keep their existing tool set.
* `fmt`, `schema`, `repairs` and `assert` check output; `enforce`/`forbid` only guide prompts.
* **Breaking syntax change:** blocks use `:` plus a newline and an indented nonempty body, not
  braces. Use spaces (4 recommended), no inline suites, and `pass` for empty bodies. Dicts and
  interpolation keep their braces; blocks still create lexical child scopes. See the
  [migration rules](../docs-template/Language.md#block-syntax-and-migration).

See [Language](../docs-template/Language.md), [Natural language & models](../docs-template/LLM-commands.md)
and [Guards & failures](../docs-template/Safety.md).

## Embedding

```js
import { parseMarkdown, run, Logger, CopilotBackend } from 'spl-lang';

const logger = new Logger('silent');
const backend = new CopilotBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
  const result = await run(parseMarkdown(source), { backend, logger, args: ['first'] });
  console.log(result);
} finally {
  await backend.close();
}
```

Also exported: `parse` (raw SPL), `TraceBackend`, `ReplayBackend`, `RecordingBackend`, variable stores,
`Checkpoint`, authentication helpers and types. See [Embedding](../docs-template/CLI.md#embedding).

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
stale edited source. Stores and checkpoints are not session
options. The embedding host owns backend cleanup and cancellation; the VS Code notebook extension
uses a separate process per notebook so even unbounded deterministic code can be interrupted.

## Tests

```sh
npm test
```

Tests are offline. In PowerShell, `$env:SPL_LIVE_TESTS='1'; npm test` adds authenticated live tests.