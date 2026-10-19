# spl-lang 0.3

The Semantic Prompt Language interpreter. Requires Node.js 20+.

See the [project guide](../README.md), [language specification](../LANG-PRD.md),
[EBNF](docs/syntax.ebnf), and [documentation site](../docs/index.html).

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
- **Generation:** `?` and `think` have no tools or MCP access.
- **Agency:** `agent` explicitly enables model-directed runtime and configured MCP tools.
- **Validation:** expression-valued `schema` uses strict synchronous JSON Schema draft-07;
  `fmt='json'` accepts any JSON value, `fmt='object'` requires an object/array.
  Prose and code fences are not silently extracted.
- **Repairs:** `repairs=0..5` retries only malformed/invalid generation, not transport errors
  or external actions. Agents require `repairs=0`. Use `assert` for business rules.
- **Guidance:** `enforce`/`forbid` and `len` influence prompts, not runtime guarantees.
- **Capabilities:** nested `restrict fs/net/exec/mcp` clauses intersect. Shell command
  inspection is best effort; MCP servers are trusted services, not OS-sandboxed.
- **Bindings:** `let` declares/redeclares function/script locals; `x = ...` and `x += ...`
  update existing locals. Every block shares that scope. Enclosing names are readable but
  cannot be rebound by a function; shared collections remain mutable.

Common generation modifiers are `len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`,
and `model`. Values are evaluated once, then validated before calling the model.
`think` and `agent` default to medium reasoning; `?` uses the model default.
CLI `--model` overrides per-call `model`, which overrides the header directive.

## Record/replay

```sh
node dist/cli.js examples/triage-issues.spl --record triage.jsonl
node dist/cli.js examples/triage-issues.spl --replay triage.jsonl --silent
```

Record creates a new file and rejects agents. Replay performs exact, ordered request matching
without starting Copilot/MCP. Local reads are permitted; writes, shell, network, agents,
and persistent stores are blocked. Recordings include prompts and raw responses and must
be protected like logs. Mismatched, missing, or unused entries fail explicitly.

## CLI

```text
spl script.spl [--model id] [--mcp file.json] [--cwd dir] [--timeout seconds]
               [--store file.json | --store-module module]
               [--record file.jsonl | --replay file.jsonl]
               [--log-level error|info|debug] [--silent] [--check]
```

Results are printed on stdout, logs on stderr. Full prompts/responses and statement traces
appear at every non-silent log level. Exit codes are `0` success, `1` script failure,
`2` syntax/usage error, and `70` internal error. `--check` does not execute modifier expressions
or compile schemas. See [CLI and MCP configuration](../docs/cli.html).

## Tests and embedding

```sh
npm test
```

The default suite is offline. In PowerShell, opt into authenticated live checks with
`$env:SPL_LIVE_TESTS='1'; npm test`, then remove the environment variable.

The package exports `parse`, `run`, `Logger`, `CopilotBackend`, `RecordingBackend`,
`ReplayBackend`, variable stores, authentication helpers, and related types.
Call `close()` on the backend after running; replay also checks for unused entries there.
Custom backends must honor the request kind: only `agent` may execute tools.
See [embedding](../docs/internals.html#embedding).

## Migration

Use `enforce` and `forbid` for scoped prompt guidance; `instruct` and `avoid` are not accepted.
0.3 removes `think{level=...}`, tool-command syntax, and `let` before
compound/member/index assignments. Use `reasoning`, ordinary raw functions, and explicit agents instead.
Bare blocks no longer create scopes. See the [migration table](../README.md#breaking-changes-in-03).
