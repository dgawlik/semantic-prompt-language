# Getting started

Orchestrate conversations with LLMs, validate the responses, enforce schemas
and quickly iterate. Download the npm package or use it directly with `npx`.

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
@{model='gpt-6-luna'}

let isFriday = ?{fmt='json'} 'Is today Friday? Return true or false.'
if isFriday {
    success 'Today is Friday!'
} else {
    success ?'Complain in original way'
}
```

Check the syntax, log in and run it:

```sh
npx spl-lang hello.spl --check
npx spl-lang login
npx spl-lang hello.spl
```

Use `--model <id>` if the example's model is unavailable.

**stdout vs. stderr**

The value passed to `success` or a top-level `return` goes to stdout: strings
are printed raw, everything else as JSON. An uncaught failure prints its payload
to stdout. Logs, including the model and reasoning effort of each LLM call, go
to stderr so results can be piped safely.

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
let user = ?{schema=User, reasoning='low', repairs=2} 'Invent a fictional adult user'
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
npx spl-lang user.spl --record user.jsonl
npx spl-lang user.spl --replay user.jsonl --silent
```

Replay needs no model credentials. Requests must match exactly and in order.
Replay permits local reads but blocks writes, shell, network, agents and persistent
stores. Recordings contain prompts and raw responses; protect them as sensitive
data. See [record/replay](CLI.md#offline-generation-recordreplay).

## Breaking changes in 0.3

| Old | New |
| --- | --- |
| `read_file{path='a.txt'} 'Return it'` | `read_file('a.txt')`; interpret the result with a separate generation call. |
| Tools with missing parameters | Required positional arguments, or explicit `agent '...'` for model-selected actions. |
| `instruct` / `avoid` | Use `enforce` / `forbid` for scoped prompt guidance. |
| `think{level='high'}` | `?{reasoning='high'}` or `think{reasoning='high'}`. |
| `let x += 1`, `let d.key = 2` | `x += 1`, `d.key = 2`; `let` declares or redeclares a name. |
| Blocks share the function/script scope | Each block creates a lexical child scope. Use assignment, not inner `let`, to update an enclosing declaration. |
| Modifier values checked by parsing | Values are expressions checked at runtime; unknown or duplicate names remain syntax errors. |

## Repository tour

| Path | Contents |
| --- | --- |
| [LANG-PRD.md](../LANG-PRD.md) | Product requirements and language specification. |
| [lang/](../lang/) | The interpreter: `src/`, `tests/`, `examples/` and `docs/syntax.ebnf`. |
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
