# SPL: Semantic Prompt Language

A small Python-like language for reliable AI workflows: raw tools execute exactly what
the script specifies, generation returns validated data, and explicit agents choose actions.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
[Markdown documentation](docs-template/Introduction.md) |
[Language specification](LANG-PRD.md) | [Grammar](lang/docs/syntax.ebnf)

## Install and run

Requires Node.js 20+. Model calls require GitHub Copilot authentication; raw tools,
syntax checks, and recorded generation replay do not.

```sh
npm install -g spl-lang
spl login
spl example.spl
```

From a checkout: `cd lang`, `npm install`, then `node dist/cli.js examples/hi.spl`.

## Generation, validation, and exact I/O

```spl
let Invoice = {
    'type': 'object',
    'properties': {'total': {'type': 'number'}},
    'required': ['total'],
    'additionalProperties': False,
}
let document = read_file('invoice.txt')
let invoice = ?{schema=Invoice, reasoning='high', repairs=2} 'Extract the total: {document}'
assert invoice.total >= 0 'total must not be negative'
restrict './out' {
    write_file('./out/invoice.json', json_stringify(invoice))
}
success invoice
```

- `read_file(path)`, `write_file(path, content)`, `web_fetch(url)`, `web_search(query)`,
  and `shell(command)` are ordinary positional functions. They never call a model.
  File/web reads return text, writes return a confirmation, search returns result text,
  and shell returns combined stdout/stderr or raises `tool_error` on nonzero exit.
- `?` and `think` are **generation-only**: no runtime tools, built-in Copilot tools, or MCP servers.
  `think` is shorthand for generation with default medium reasoning.
- `agent 'Inspect the source and fix the bug'` explicitly allows model-directed actions.
  Runtime tools and configured MCP tools remain subject to active restrictions.
- All three accept expression-valued `len`, `fmt`, `reasoning`, `show`, `schema`, `repairs`,
  and `model` modifiers. Unknown/duplicate names are syntax errors; invalid values are runtime errors.
- `fmt` supports `integer`, `float`, `array`, `object`, `text`, and `boolean`.
  Non-text formats require strict JSON of the selected type; `float` accepts any finite
  number, including whole numbers. `object` requires a dict, not an array.
  `fmt='json'` still accepts any JSON value. Prose and Markdown fences are rejected for
  JSON formats. `schema` implies JSON output unless `fmt` is explicit.
- Schemas use synchronous JSON Schema draft-07, validated by Ajv in strict mode.
  No coercion, implicit defaults, or removal of extra fields. Errors include field paths.
- `repairs=0..5` allows that many **additional generation attempts**, only for JSON/shape errors.
  Transport errors are not retried. Agents cannot use repairs, and prompt expressions run only once.
  Business rules remain explicit `assert` statements.

## Guidance is not a guarantee

```spl
let answer = None
enforce 'Answer in English' {
    forbid 'jokes' {
        answer = ?{len='sentence'} 'Explain recursion'
    }
}
success answer
```

`enforce` and `forbid` are the positive and negative scoped prompt-guidance keywords.
They and `len` do not verify compliance. `schema` and `assert` validate results.
`restrict` checks actions, and nested restrictions intersect:

```spl
let findings = None
restrict './src', exec 'git', mcp 'docs/search' {
    findings = agent{reasoning='high'} 'Inspect the source and consult docs/search'
}
success findings
```

Raw tools and agents are allow-by-default outside restrictions. Shell restrictions are
best-effort command-line checks, not an OS sandbox. MCP servers are trusted services:
`restrict mcp` limits calls, not server-internal I/O.

## Bindings and control flow

```spl
let count = 0
for i in range(3) {
    count += i
}
let result = {
    let count = 10
    count + 1
}
success [count, result]  # [3, 11]
```

`let name = ...` declares/redeclares in the current scope. Every block creates a child scope;
inner declarations shadow outer names and are inaccessible from the parent. Reads and
assignments search outward through the lexical scope chain, using the first declaration found.
Each loop iteration has its own scope, including its loop variables.
`def`, recursion,
Python-style expressions, interpolation, `try/except`, `assert`, `fail`, `success`, and
top-level `return` are supported.

Blocks and `if`/`elif`/`else` can be used as expressions. Their final expression is their
value; an empty block, a statement-ending block, or an unmatched conditional returns `None`.
`{}` remains an empty dictionary; use `{ pass }` for a block returning `None`.

```spl
let result = if ?{fmt='boolean'} 'Today is Friday?' {
    ? 'Haiku on variance'
} else {
    ? 'Sentence on passing time'
}
log{level=debug}(result)
success result
```

`log(value, ...)` defaults to info. `log{level=error|info|debug}(value, ...)` selects
severity (one level, not a literal `|` expression); quoted levels and expressions are also
accepted. Debug messages are emitted only with `--log-level debug`.

## Offline regression tests

```sh
spl extraction.spl --record responses.jsonl
spl extraction.spl --replay responses.jsonl --silent
```

Recordings are new JSONL files; existing files are never overwritten. They match ordered
requests including the assembled prompt, call kind, requested model, reasoning, and display
options. Repairs are recorded too. A mismatch, exhaustion, or unused response fails explicitly.

Recording rejects agents. Replay never starts Copilot or MCP servers, permits local reads,
and blocks writes, shell, network, agents, and persistent variable stores. It is not a
general workflow cache: split side-effecting stages from replayable generation.
**Recordings and logs contain prompts and responses; treat them as sensitive data.**

## CLI and failures

```text
spl script.spl [--model id] [--mcp file.json] [--cwd dir] [--timeout seconds]
               [--store file.json | --store-module module]
               [--record file.jsonl | --replay file.jsonl]
               [--log-level error|info|debug] [--silent] [--check]
spl login
spl logout
```

Model precedence: CLI override, per-call modifier, `@{model='...'}`, SDK default.
The result goes to stdout; logs go to stderr. Non-silent logs include full LLM transcripts
and statement traces. Exit codes: `0` success, `1` script failure, `2` syntax/usage error,
`70` internal error. `--check` validates syntax and MCP configuration, not runtime expressions.

Caught failures expose `status`, `status_code`, `reason`, `command`, and `line`.
Categories include `invalid_format`, `validation_failed`, `restriction_violation`,
`assertion_failed`, `llm_error`, `tool_error`, `runtime_error`, and `explicit_failure`.
Persistence is opt-in with `--store`; snapshots are saved even after a script failure.

## Breaking changes in 0.3

| Before | Now |
|---|---|
| `read_file{path='a.txt'} 'Return it'` | `read_file('a.txt')` |
| Tool command with omitted parameters | Explicit `agent '...'` |
| `instruct` / `avoid` | Use `enforce` / `forbid` for scoped prompt guidance |
| `think{level='high'}` | `?{reasoning='high'}` or `think{reasoning='high'}` |
| `let x += 1`, `let d.key = 2` | `x += 1`, `d.key = 2` |
| Blocks share their function/script scope | Blocks create lexical scopes; use assignment to update an outer binding |
| Unknown modifier values fail at parse time | Expression values are validated at runtime |
| `fmt='object'` accepts objects and arrays | Use `object` for dicts, `array` for lists, or `json` for any JSON value |

## Development

```sh
cd lang
npm install
npm test
```

Tests are offline by default. To opt into authenticated live tests in PowerShell:
`$env:SPL_LIVE_TESTS='1'; npm test`. Remove that environment variable afterward.
The [VS Code extension](vscode/README.md) provides live parser-backed diagnostics, completions, hover,
go-to-definition, and document symbols. It has its own `npm test` and bundles its language server.

### Documentation site

Edit the Markdown pages in [docs-template/](docs-template/Introduction.md), then
regenerate the static site:

```sh
npm install
npm run docs:build
npm run docs:check
```

Shared styles and browser interactions live in [docs/assets/](docs/assets/).
The build renders all pages, highlights code, preserves published permalinks, and
creates a local search index. Commit the generated HTML and search index together
with the Markdown changes; GitHub Pages serves `docs/` without a runtime build.
`docs:check` fails if generated files are stale.

To preview locally, run `python -m http.server 8765 --directory docs` and open
`http://localhost:8765`. The focused offline checks are in
[examples.test.ts](lang/tests/examples.test.ts).
