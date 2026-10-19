# SPL: Semantic Prompt Language

A small Python-like language for reliable AI workflows: raw tools execute exactly what
the script specifies, generation returns validated data, and explicit agents choose actions.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
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
- `fmt='json'` parses any JSON value; `fmt='object'` requires an object or array.
  Both are strict: prose and Markdown fences are rejected. `schema` implies JSON output.
- Schemas use synchronous JSON Schema draft-07, validated by Ajv in strict mode.
  No coercion, implicit defaults, or removal of extra fields. Errors include field paths.
- `repairs=0..5` allows that many **additional generation attempts**, only for JSON/shape errors.
  Transport errors are not retried. Agents cannot use repairs, and prompt expressions run only once.
  Business rules remain explicit `assert` statements.

## Guidance is not a guarantee

```spl
enforce 'Answer in English' {
    forbid 'jokes' {
        let answer = ?{len='sentence'} 'Explain recursion'
    }
}
success answer
```

`enforce` and `forbid` are scoped prompt guidance, with `instruct` and `avoid` as equivalent
aliases. They and `len` do not verify compliance. `schema` and `assert` validate results.
`restrict` checks actions, and nested restrictions intersect:

```spl
restrict './src', exec 'git', mcp 'docs/search' {
    let findings = agent{reasoning='high'} 'Inspect the source and consult docs/search'
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
{ let visible = count }
success visible
```

`let name = ...` declares/redeclares in the current function or script. All blocks share that
scope. Assignment requires an existing local binding; a function may read outer names but
cannot rebind them. Lists and dicts can be mutated to share state. `def`, recursion,
Python-style expressions, interpolation, `try/except`, `assert`, `fail`, `success`, and
top-level `return` are supported.

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
| `enforce` / `forbid` | Still supported; `instruct` / `avoid` are equivalent guidance aliases |
| `think{level='high'}` | `?{reasoning='high'}` or `think{reasoning='high'}` |
| `let x += 1`, `let d.key = 2` | `x += 1`, `d.key = 2` |
| Bare blocks shadow variables | Every block shares its function/script scope |
| Unknown modifier values fail at parse time | Expression values are validated at runtime |

## Development

```sh
cd lang
npm install
npm test
```

Tests are offline by default. To opt into authenticated live tests in PowerShell:
`$env:SPL_LIVE_TESTS='1'; npm test`. Remove that environment variable afterward.
The [VS Code extension](vscode/README.md) has its own `npm test`.
