# spl-lang

A compact Python-like language for building AI workflows in minutes, not hours of
orchestration glue. Iterate in a small script, separate deterministic code from
LLM judgment, and contain model variance with explicit guards. Requires Node.js 20+.

SPL is designed around three priorities:

1. **Short iteration loops:** check syntax, run, inspect, refine, and replay unchanged
   LLM requests while testing guards or deterministic logic.
2. **Explicit boundaries and guards:** use ordinary code for computation, `ask`/`think`
   for generation, `agent` for model-directed actions, and validation before accepting results.
3. **Readable scripts:** keep inputs, prompts, checks, and outputs visible together,
   with familiar expressions and compact modifiers rather than orchestration plumbing.

See the [project guide](../README.md), [language specification](../LANG-PRD.md),
[grammar](../docs-template/Grammar.md), and [documentation site](../docs/index.html).

## Run from a checkout

```sh
npm install
node dist/cli.js login
node dist/cli.js examples/hi.spl
```

`npm install` runs the TypeScript build. Installed packages expose `spl` and `spl-lang`.
Authentication is needed only for live generation and explicit agents; raw tools and replay
work without Copilot. Existing Copilot/CLI credentials and supported GitHub token environment
variables are reused. `spl login` otherwise runs device authentication and saves credentials
under `~/.spl` (override with `SPL_HOME`); `spl logout` removes those saved credentials.

## Language contract

- **Exact tools:** `read_file(path)`, `write_file(path, content)`, `web_fetch(url)`,
  `web_search(query)`, `shell(command)` never call a model.
- **Generation:** `ask` and `think` have no tools or MCP access.
- **Agency:** `agent` explicitly enables model-directed runtime and configured MCP tools.
- **Human input:** `human 'question'` suspends a checkpoint run and returns an exact
  answer supplied by a later CLI invocation, never a terminal prompt.
- **Validation:** expression-valued `schema` uses strict synchronous JSON Schema draft-07;
  `fmt` supports `integer`, `float`, `array`, `object`, `text`, and `boolean`.
  Non-text formats require strict JSON of the selected type; `float` accepts any finite
  number, including whole numbers, and `object` requires a dict, not a list.
  `fmt='json'` still accepts any JSON value. Prose and code fences are not silently extracted.
- **Repairs:** `repairs=0..5` retries only malformed/invalid generation, not transport errors
  or external actions. Agents require `repairs=0`. Use `assert` for business rules.
- **Guidance:** `enforce`/`forbid` and `len` influence prompts, not runtime guarantees.
- **Capabilities:** nested `restrict fs/net/exec/mcp` clauses intersect. Shell command
  inspection is best effort; MCP servers are trusted services, not OS-sandboxed.
- **Bindings:** every block has a lexical child scope. `let` declares/redeclares locally
  and shadows outer names. Reads and assignments search outward for the first declaration;
  child locals, loop variables and caught failures do not leak to parents.
- **Expressions:** blocks and conditionals yield their final expression, otherwise `None`.
  `{}` remains an empty dict. Functions still require explicit `return`.
- **Logging:** `log(...)` defaults to info. `log(level=debug)(...)` selects error/info/debug;
  bare level names, strings and expressions are accepted and checked at runtime.
- **Runtime inputs:** `$env.NAME` / `$env['NAME']` reads process environment strings;
  `$args[i]` reads repeated CLI `--arg` strings in order (empty list by default).
  Missing environment names and out-of-range argument indexes return `None`.
  Both are read-only snapshots, including through aliases, and are not automatically persisted.

Common generation modifiers are `len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`,
and `model`. Values are evaluated once, then validated before calling the model.
`think` and `agent` default to medium reasoning; `ask` uses the model default.
CLI `--model` overrides per-call `model`, which overrides the header directive.

## Trace/replay for short iteration loops

```sh
node dist/cli.js examples/triage-issues.spl --check
node dist/cli.js examples/triage-issues.spl --trace triage.jsonl
node dist/cli.js examples/triage-issues.spl --replay triage.jsonl --silent
```

Trace captures all generation and agent requests, raw responses, reasoning, effective
parameters, and backend failures in a new JSONL file. Replay performs exact, ordered
request matching without starting Copilot or MCP. Use it to retest deterministic
logic and guards with the same answers. Changed requests require a new live trace;
mismatched, missing, or unused entries fail explicitly.

Explicit script tools and stores still run normally during workflow replay.
Agent-owned actions are not repeated or restored, so replay is not a dry run.
External inputs can still vary, and guards validate only the rules you specify.
Protect traces like logs: they contain sensitive prompts and raw responses.

Legacy `--record` remains generation-only. Replaying those files allows local reads
but blocks writes, shell, network, agents, and persistent stores.

## CLI

For noninteractive human review:

```sh
spl examples/human-review.spl --checkpoint run.jsonl --silent
spl examples/human-review.spl --resume run.jsonl --answer-for REQUEST_ID --answer-file feedback.txt
```

Waiting emits a JSON request and exits `3`. Resume reconstructs ordinary computation
but does not repeat completed tools/model/agent calls. Preserve the same workspace,
script, runtime and configuration; uncertain interrupted effects require manual
recovery, not automatic retry. Resumable mode cannot combine with stores or
trace/record/replay. See the [Human in the loop guide](../docs/hitl.html).

```text
spl script.spl [--model id] [--mcp file.json] [--cwd dir] [--timeout seconds]
               [--store file.json | --store-module module]
               [--trace file.jsonl | --record file.jsonl | --replay file.jsonl]
               [--log-level error|info|debug] [--silent] [--check]
               [--arg value ...]
```

Results are printed on stdout, logs on stderr. Full prompts/responses and statement traces
appear at every non-silent log level. Exit codes are `0` success, `1` script failure,
`2` syntax/usage error, `3` waiting for human input, and `70` internal/infrastructure error. `--check` does not execute modifier expressions
or compile schemas. See [CLI and MCP configuration](../docs/cli.html).

## Tests and embedding

```sh
npm test
```

The default suite is offline. In PowerShell, opt into authenticated live checks with
`$env:SPL_LIVE_TESTS='1'; npm test`, then remove the environment variable.

The package exports `parse`, `run`, `Logger`, `CopilotBackend`, `TraceBackend`,
`RecordingBackend`, `ReplayBackend`, variable stores, authentication helpers, and related types.
Resumable embedding also exports `Checkpoint`, `CheckpointError`, and context/request types.
Call `close()` on the backend after running; replay also checks for unused entries there.
Custom backends must honor the request kind: only `agent` may execute tools.
Embedding callers can pass `args: ['first', 'second']` in `RunOptions`; omitted
arguments default to `[]`, not the host's `process.argv`. Each run snapshots `process.env`.
See [embedding](../docs/internals.html#embedding).

## Migration

`human` is a reserved keyword; rename previous bindings with that name.

Use `enforce` and `forbid` for scoped prompt guidance; `instruct` and `avoid` are not accepted.
0.3 removes `think(level=...)`, tool-command syntax, and `let` before
compound/member/index assignments. Use `reasoning`, ordinary raw functions, and explicit agents instead.
Blocks create lexical child scopes; replace inner `let` with assignment when an outer
binding must be updated. See the [migration table](../README.md#breaking-changes-in-03).
`fmt='object'` is now object-only; use `fmt='array'` for lists or `fmt='json'` for any JSON value.
