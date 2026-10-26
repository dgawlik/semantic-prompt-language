# SPL: Semantic Prompt Language

Executable Markdown for AI workflows: mix Python-like SPL code with natural-language
instructions, sharing variables, tools, validation, and control flow.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
[Markdown documentation](docs-template/Introduction.md) |
[Language specification](LANG-PRD.md) | [Grammar](docs-template/Grammar.md)

## Why SPL?

1. **Fast iteration loops.** Write a small workflow, run it, inspect the result, and
   refine the prompt or guard. Syntax checks, direct execution, and trace/replay keep
   the loop short without building a separate orchestration layer.
2. **Deterministic logic stays separate from LLM judgment.** Ordinary code owns
   control flow and data manipulation; `ask` and `think` mark generation, and `agent`
   explicitly opts into model-directed actions. Use `fmt`, `schema`, `assert`,
   bounded `repairs`, and `restrict` to contain variance rather than trust a prompt.
3. **Readable at a glance.** Familiar expressions, compact modifiers, and visible
   guard statements put the inputs, model calls, checks, and outputs in one
   scannable script.

Raw tools never call a model, but files, network responses, and shell commands still
depend on external state. Guards validate the rules you specify; they do not make
live model output deterministic or guarantee that an answer is factually correct.

## Install and run

Requires Node.js 20+. Model calls require GitHub Copilot authentication; raw tools,
syntax checks, and recorded LLM replay do not.

```sh
npm install -g spl-lang
spl login
spl example.md
```

From a checkout: `cd lang`, `npm install`, then `node dist/cli.js examples/hi.md`.

## Executable Markdown

Only `.md` files execute. The following is a complete workflow:

````text
---
extension: semantic-prompt-language
version: 1
preamble: Be concise.
---

# This heading and ordinary prose are comments.

```spl
let count = 20
```

> Add two to @count, then return it using @success.
````

The exact `extension` identifier and numeric `version: 1` are required.
Optional frontmatter fields are `model` and `preamble`. CLI `--model` overrides
per-call models and the frontmatter default. Unknown or invalid fields are errors.
Built-in runtime instructions and the optional preamble precede every model request,
including nested generation and repair attempts.

Top-level `spl` fences and blockquotes execute in document order and share a scope.
Each fence is a complete SPL unit; constructs cannot span fences. Other Markdown,
including other code languages and nested examples in lists, is ignored.
`success`, `fail`, and top-level `return` terminate the whole document.

Blockquotes have access to the entire language through the registered `submit_spl`
hook: the model submits a program, then the runtime executes it in the shared scope.
`@name` denotes a binding or operation, such as `@count`, `@read_file`, or `@success`;
markers are optional semantic hints, not string interpolation. Natural-language
interpretation is model-dependent; generated code uses the same restrictions and
validation as handwritten code. Tools are allow-by-default outside `restrict`.
Use trusted workflow documents only.

Natural-language human input requires `--checkpoint` just like SPL `human`.
Traces record submitted code; replay executes that code without translating again,
so explicit effects still run. Checkpoint resume skips completed effects.
`--check` validates frontmatter and SPL syntax, but cannot validate natural-language
intent without a model. See [Language basics](docs-template/Language.md#program-structure).

Raw `parse(source)` / `run(program, options)` APIs remain compatible. Embedders use
`parseMarkdown(source)` for the new document format. The SPL examples below show
fence contents, not standalone executable files.

## Commands and modifiers

Generation uses `ask`, reasoning uses `think`, and model-directed actions use `agent`.
All three accept multiline named modifiers in parentheses, with the prompt outside:

```spl
let score = ask(
    fmt = 'integer',
    repairs = 1
) 'Rate this issue'
let explanation = think(reasoning='high') 'Explain this score: {score}'
let report = agent(reasoning='low') 'Inspect the project and summarize its status'
log(level=debug)(score)
```

No modifiers: `ask 'prompt'` or `ask() 'prompt'`. Options can have a trailing comma.
Document models use frontmatter `model: model-id`. Ordinary `log(value)` and raw tool calls
are unchanged. The old `?`, brace modifiers, and `@{...}` headers are rejected with
migration hints; replace them with `ask`, `command(...)`, and frontmatter `model`.

## Generation, validation, and exact I/O

Read the workflow top to bottom: fetch the input explicitly, ask the model for a
validated value, check the business rule, then write the accepted result.

```spl
let Invoice = {
    'type': 'object',
    'properties': {'total': {'type': 'number'}},
    'required': ['total'],
    'additionalProperties': False,
}
let document = read_file('invoice.txt')
let invoice = ask(schema=Invoice, reasoning='high', repairs=2) 'Extract the total: {document}'
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
- `ask` and `think` are **generation-only**: no runtime tools, built-in Copilot tools, or MCP servers.
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
        answer = ask(len='sentence') 'Explain recursion'
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
    findings = agent(reasoning='high') 'Inspect the source and consult docs/search'
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
let result = if ask(fmt='boolean') 'Today is Friday?' {
    ask 'Haiku on variance'
} else {
    ask 'Sentence on passing time'
}
log(level=debug)(result)
success result
```

`log(value, ...)` defaults to info. `log(level=error|info|debug)(value, ...)` selects
severity (one level, not a literal `|` expression); quoted levels and expressions are also
accepted. Debug messages are emitted only with `--log-level debug`.

## Replayable workflows

For noninteractive human review, `human 'question'` emits JSON and exits `3`.
Start with `spl workflow.md --checkpoint run.jsonl`, then submit a matching request
with `spl workflow.md --resume run.jsonl --answer-for REQUEST_ID --answer-file feedback.txt`.
Equivalently, use `--resume --checkpoint run.jsonl`. Every further question appends
to that same journal; answer its latest `request_id`, not the workflow's `run_id`.
Completed tools/model calls are not repeated; preserve the same workspace and
script/runtime/configuration. This is separate from ordinary trace replay below.
See the [Human in the loop guide](docs-template/HITL.md) for the protocol and GitHub Actions recipe.

Capture a live run, then iterate on guards and deterministic logic without another
model call when the recorded LLM requests remain unchanged:

```sh
spl extraction.md --trace responses.jsonl
spl extraction.md --replay responses.jsonl --silent
```

Traces capture all `ask`, `think`, and `agent` requests, raw responses, reasoning,
effective parameters, and failures in a versioned JSONL format. Existing files are
never overwritten, and `--silent` does not suppress tracing. Replay matches ordered
requests including the assembled prompt, call kind, requested model, reasoning, and display
options. Repairs and caught backend failures are replayed too. A mismatch, exhaustion,
or unused entry fails explicitly. Replay never starts Copilot or MCP servers.

**Workflow replay still executes explicit script tools and persistent stores normally.**
It returns recorded agent results without repeating agent-owned tools or MCP actions;
it does not recreate their side effects. Files, network responses, environment variables,
and arguments come from the current run, so unchanged LLM inputs are required.
For the older generation-only mode, `--record file.jsonl` remains supported; replaying
those legacy files still blocks agents, writes, shell, network, and persistent stores.
`--trace`, `--record`, and `--replay` are mutually exclusive.
**Traces, recordings, and logs contain sensitive prompts and responses; protect them.**
See [trace format and replay behavior](docs-template/CLI.md#workflow-traces-and-replay).
Changing a prompt, model, or other matched request option requires a new live trace;
replay does not generate a new answer.

## CLI and failures

Scripts can read process environment strings with `$env.NAME` or `$env['NAME']`,
and arguments with `$args[0]`, `$args[1]`, etc. Pass each argument with
`spl --arg=first --arg="two words" script.md`. Missing environment names and
out-of-range argument indexes return `None`; a set-but-empty environment value stays `''`.
Both values are read-only snapshots, including through aliases, and are not
automatically persisted. See [runtime inputs](docs-template/Language.md#runtime-inputs-env-and-args).

```text
spl script.md [--model id] [--mcp file.json] [--cwd dir] [--timeout seconds]
               [--store file.json | --store-module module]
               [--trace file.jsonl | --record file.jsonl | --replay file.jsonl]
               [--log-level error|info|debug] [--silent] [--check]
               [--arg value ...]
spl login
spl logout
```

Model precedence: CLI override, per-call modifier, `@(model='...')`, SDK default.
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
| `think{level='high'}` | `ask(reasoning='high')` or `think(reasoning='high')` |
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
