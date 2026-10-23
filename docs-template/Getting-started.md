# Getting started

Go from an idea to a small, guarded workflow with a short edit-run-check loop.
SPL keeps deterministic logic, model calls, and validation visible in one readable
script, so you can iterate on the solution rather than build orchestration glue.

Start with exact raw tools, add schema-validated generation, and opt into agents
only when the model should choose actions. Syntax checks, scripts without LLM
commands and recorded replay need no Copilot login.

## Requirements

* Node.js 20 or newer.
* A GitHub Copilot account for live model calls. Run `npx spl-lang login` once.
  See [Authentication](CLI.md#authentication).

## Quick test

Create `hello.spl`:

```spl
let report = 'Checkout fails for every customer after deployment.'
let severity = ask(fmt='integer', repairs=1) 'Rate the impact from 1 to 5: {report}'
assert severity >= 1 and severity <= 5 'severity must be between 1 and 5'
let route = if severity >= 4 { 'urgent-review' } else { 'normal-review' }
success {'severity': severity, 'route': route}
```

Check the syntax, log in and run it:

```sh
npx spl-lang hello.spl --check
npx spl-lang login
npx spl-lang hello.spl
```

The `ask` is the only model call; its result must be an integer. The assertion checks
the allowed range, then ordinary code chooses a route. `repairs=1` can correct one
format failure, not a failed assertion. Use `--model <id>` to choose a model instead
of the SDK default.

**stdout vs. stderr**

The value passed to `success` or a top-level `return` goes to stdout: strings
are printed raw, everything else as JSON. An uncaught failure prints its payload
to stdout. Logs, including the model and reasoning effort of each LLM call, go
to stderr so results can be piped safely.

## A short iteration loop

1. **Edit one decision at a time.** Keep data preparation and control flow in
   ordinary code. Put model judgment behind a visible `ask` or `think`; use `agent`
   only when the model should choose actions.
2. **Check syntax cheaply.** `--check` parses the script without model calls or
   script side effects. It does not validate runtime modifier values or compile schemas.
3. **Run and inspect.** Read the result and failure category, then refine the
   prompt, schema, assertion, or restriction. Capture a live trace when you want
   to reuse that run's LLM results.
4. **Retest with the same answers.** Replay to iterate on downstream logic and guards
   while LLM requests stay unchanged. If you change a prompt, model, or matched
   option, run live again with a new trace filename.

```sh
npx spl-lang hello.spl --check
npx spl-lang hello.spl --trace hello-v1.jsonl
npx spl-lang hello.spl --replay hello-v1.jsonl
```

Replay never starts Copilot or MCP, but explicit script tools and stores still run.
It does not repeat or restore agent-owned actions. Protect traces as sensitive data;
see [workflow replay](CLI.md#workflow-traces-and-replay).

## Install & build

For a global installation:

```sh
npm install -g spl-lang
spl login
spl hello.spl
```

From a checkout, the interpreter lives in `lang/`:

```sh
cd lang
npm install
npm run build
```

`npm install` also runs `prepare`, compiling TypeScript to `dist/`. The package
exposes two equivalent binaries, `spl` and `spl-lang`, pointing at `dist/cli.js`.

## Your first run

From `lang/` in a checkout:

1. Check the syntax without model calls or script side effects:

   ```sh
   node dist/cli.js examples/basics.spl --check
   ```

2. Log in to Copilot. When authentication is needed, GitHub's device flow prints
   a code and URL to confirm in the browser:

   ```sh
   node dist/cli.js login
   ```

3. Run against Copilot:

   ```sh
   node dist/cli.js examples/live.spl
   ```

Alternatively, from the repository root, use the local package with `npx`:

```sh
npx file:./lang lang/examples/live.spl
```

## Write a script

For structured output, create `user.spl`:

```spl
let User = {
    'type': 'object',
    'properties': {'name': {'type': 'string'}, 'age': {'type': 'integer', 'minimum': 0}},
    'required': ['name', 'age'],
    'additionalProperties': False,
}
let user = ask(schema=User, reasoning='low', repairs=2) 'Invent a fictional adult user'
assert user.age >= 18 'expected an adult'
success user
```

```sh
npx spl-lang user.spl --model gpt-6-luna
```

**Literal braces in prompts**

Every non-raw string interpolates `{expr}`. For literal braces, double them
(`{{ }}`), escape them (`\{ \}`), or use a raw string such as `r'{"a": 1}'`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The script finished: it reached `success`, a top-level `return` or the end. |
| `1` | Uncaught failure; the failure payload is printed to stdout. |
| `2` | Syntax error or command-line usage error. |
| `70` | Internal interpreter error. |

## Replay generation offline

```sh
npx spl-lang user.spl --trace user.jsonl
npx spl-lang user.spl --replay user.jsonl --silent
```

Replay needs no model credentials. Requests must match exactly and in order.
Workflow replay returns recorded generation and agent results without starting
Copilot or MCP. Explicit script tools and stores still execute normally; agent-owned
actions are not repeated. Traces contain prompts and raw responses; protect them as
sensitive data. Legacy `--record` files retain generation-only replay restrictions.
See [trace/replay](CLI.md#workflow-traces-and-replay).

## Breaking changes in 0.3

**Current command syntax:** replace `?{fmt='integer'} 'prompt'` with
`ask(fmt='integer') 'prompt'`, `think{...}` / `agent{...}` with
`think(...)` / `agent(...)`, `log{level=debug}(value)` with
`log(level=debug)(value)`, and `@{model='...'}` with `@(model='...')`.
Blocks and dictionaries still use braces. See [command modifiers](LLM-commands.md#composable-modifiers).

| Old | New |
| --- | --- |
| `read_file{path='a.txt'} 'Return it'` | `read_file('a.txt')`; interpret the result with a separate generation call. |
| Tools with missing parameters | Required positional arguments, or explicit `agent '...'` for model-selected actions. |
| `instruct` / `avoid` | Use `enforce` / `forbid` for scoped prompt guidance. |
| `think{level='high'}` | `ask(reasoning='high')` or `think(reasoning='high')`. |
| `let x += 1`, `let d.key = 2` | `x += 1`, `d.key = 2`; `let` declares or redeclares a name. |
| Blocks share the function/script scope | Each block creates a lexical child scope. Use assignment, not inner `let`, to update an enclosing declaration. |
| Modifier values checked by parsing | Values are expressions checked at runtime; unknown or duplicate names remain syntax errors. |

## Repository tour

| Path | Contents |
| --- | --- |
| [LANG-PRD.md](../LANG-PRD.md) | Product requirements and language specification. |
| [lang/](../lang/) | The interpreter: `src/`, `tests/` and `examples/`. The canonical grammar is in [Grammar](Grammar.md). |
| [vscode/](../vscode/) | VS Code extension: language server, TextMate grammar, snippets and tests. |
| [docs/](../docs/) | The HTML documentation site. |
| [docs-template/](Introduction.md) | Markdown documentation, starting with the introduction. |

## Run the tests

```sh
cd lang
npm test
```

The default suite builds and runs offline, without model calls. It checks example
syntax and documentation snippets.

For authenticated live checks, explicitly set `SPL_LIVE_TESTS=1`. In PowerShell,
run `$env:SPL_LIVE_TESTS='1'; npm test`, then remove the environment variable
with `Remove-Item Env:SPL_LIVE_TESTS`.
