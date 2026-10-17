

# Semantic Prompt Language

The scope of this project is a Python-like language that allows natural language prompts that call LLMs directly
from the syntax. The audience is developers who want to automate tasks and write ordinary programs more concisely
with the help of AI.

## Key tenets

1. **Best-effort reproducibility.** Everything outside LLM calls (control flow, arithmetic, string interpolation,
   variable handling) is fully deterministic. For LLM calls the runtime reduces variance on a best-effort basis:
   it sets `temperature=0` and a fixed `seed` when the selected model/SDK supports them, and records the effective
   parameters in the logs. Identical LLM output is **not guaranteed**; scripts should use `assert` and `fmt`
   validation to guard against variance.
2. **Least privilege through explicit restriction.** The MVP is allow-by-default: a script has the full
   permissions of the user running the interpreter. Authors narrow permissions with scoped `restrict` blocks, and
   the runtime enforces them (it does not merely ask the LLM to comply). A deny-by-default permission model is a
   possible future change.

### Non-goals

* Bit-for-bit reproducible LLM output (no record/replay or response cache in the MVP).
* Being a full Python implementation; only a reasonable subset is supported.

## MVP scope

* Working parser and runtime with strict syntax checking
* GitHub Copilot SDK integration
* EBNF syntax document
* VS Code syntax-highlighting extension
* Command-line interpreter

## The language

### Variables

They are declared with

```
let variable1 = ...
```

and are mutable during the execution of the script. They can be interpolated in either plain text or LLM commands and
are substituted as is. They are stored in a JSON file store that is pluggable from the CLI.

### Commands

#### Operational modifiers

All commands have defaults, but allow to override their mode with operational modifiers. For example

```
think{level='high'} 'What is the meaning of life'
```

Modifier values follow these rules:

* Names and values are validated by the parser against a fixed schema per command. Unknown modifiers or values are
  a syntax error, not silently ignored.
* String values are quoted and lowercase (`level='high'`, `len='sentence'`, `fmt='object'`).
* Booleans use Python spelling (`show=True`).
* Directive values in the script header are quoted too (`@{model='gpt-terra-6'}`).

| Command | Modifier | Allowed values |
|---------|----------|----------------|
| `think` | `level` | `'low'`, `'medium'`, `'high'` |
| `think` | `show` | `True`, `False` |
| `?` | `len` | `'word'`, `'sentence'`, `'paragraph'`, `'long'` (provisional) |
| `?` | `fmt` | `'text'`, `'object'` |


#### LLM call

An LLM call is invoked via `?`. It allows overriding length and format.

```
let response = ?{len='sentence', fmt='object'} 'A joke about programmers'
```

`len` is a suggestion to the LLM that the runtime prepends to the query during the call. Likewise `fmt='object'`
guides the LLM to generate a JSON response; moreover the runtime validates the JSON structure and parses it
(an invalid response raises a failure with `status_code='invalid_format'`).

The parsed object can then be used:

```
let firstName = response.firstName
```

#### Enforce/Forbid

Enforce and forbid have scopes. They are in force only inside the provided block.

Example:

```
enforce 'Users favorite color is red' {
    let color = ?'What is my favorite color?'
}
```

The runtime tracks on a stack which enforce/forbid statements are in scope and prepends their constraints to the
LLM query.


#### Think

Tells the LLM to deliberate about the problem and allows adjusting its thinking level.

```
think{level='low', show=True} 'Why are tests not passing'
```


#### Restrict

`restrict` narrows what the script and the LLM tools it invokes may do inside its block. Without `restrict`,
everything is allowed (allow-by-default). There are three resource kinds:

| Form | Effect |
|------|--------|
| `restrict './target/out' { ... }` | Reads and writes are allowed only inside the folder. Same as `restrict fs`. |
| `restrict net 'api.example.com' { ... }` | Network access is allowed only to the listed hosts. |
| `restrict exec 'npm,git' { ... }` | Shell commands are allowed only for the listed executables. |

```
restrict './target/out' {
    think 'Run tests and write to tests.log'
}
```

Enforcement has two layers:

1. **Guidance:** the runtime tells the LLM about the active restrictions in the prompt.
2. **Hard enforcement:** the runtime intercepts every tool call (file, network, exec) made by the LLM and blocks
   any that violate the active restrictions. A blocked call returns a `failure` payload (see "Handling failure").

Rules:

* Restrictions are scoped to the block and can be nested. Nested restrictions of the same kind can only narrow
  the allowed set (the effective set is the intersection), never widen it.
* Paths are resolved to absolute, canonical paths before checking, so `..` and symlinks cannot escape the folder.


#### Tool calls

A tool call has the form `let variableName = <tool>{param=value} 'instructions'`. In the MVP the tools are a
**fixed built-in set** exposed through the Copilot SDK; user-defined tools and MCP servers are out of scope.

| Tool | Purpose | Governed by |
|------|---------|-------------|
| `read_file` | Read a file | `restrict fs` |
| `write_file` | Create or modify a file | `restrict fs` |
| `web_fetch` | Fetch a URL | `restrict net` |
| `shell` | Run a shell command | `restrict exec` |

```
let readme = read_file{path='./README.md'} 'Return the file content'
```

Every tool call, whether made explicitly by the script or by the LLM during a `think`/`?` command, goes through the
same runtime interception and is checked against the active `restrict` scopes. The tool list is provisional and
should be finalized against what the Copilot SDK exposes.



### Deterministic part of the language

The language introduces non-determinism through the commands above because they are handled as LLM calls.
But these commands return mostly plain text results or JSON values that are stored in variables.

The rest of the language operates on these variables in a purely deterministic way with Python-like syntax.
This includes `if`/`elif`/`else`, `for`, `while`, functions, function calls, indexing, boolean and arithmetic
expressions, string interpolation (even in the commands) and other things that are part of a reasonable subset of
Python.


### Handling failure

A failure (failed LLM call, invalid `fmt` output, blocked tool call, failed `assert`, `fail`, runtime error)
**stops the script immediately** unless it is caught with `try/except`. All failures share the same JSON payload:

```json
{
    "status": "failure",
    "reason": "reason",
    "command": "source line as plain text",
    "line": 12,
    "status_code": "assertion_failed"
}
```

`status_code` is one of (provisional): `assertion_failed`, `explicit_failure`, `invalid_format`,
`restriction_violation`, `llm_error`, `tool_error`, `runtime_error`.

Failures can be handled with `try/except`; the caught payload is bound to the given name:

```
try {
    let response = ?{fmt='object'} 'A joke about programmers'
} except err {
    let response = {'setup': 'none', 'punchline': err.reason}
}
```

There are 3 special commands that control when the program stops:

```
assert 1==2 'Abnormal'
```
Raises a failure with `status_code='assertion_failed'` when the condition is false.

```
fail 'Mysterious reason'
```
Raises a failure with `status_code='explicit_failure'`.

```
success result
```
Stops the script successfully; `result` is the value printed to stdout and returned by the interpreter.

An uncaught failure prints the payload to stdout and exits with a non-zero exit code; success exits with 0.

## Logging

The runtime is a CLI interpreter with a tunable logging level. It runs the script file until completion.

* Logs are written to **stderr**; the script result (the value of `success`, or the failure payload) is written to
  **stdout**, so the result can be piped safely.
* `--log-level <level>` sets verbosity (`error`, `info`, `debug`; provisional).
* `--silent` suppresses all logs; only the result is printed.
* Logs record, for each LLM call, the effective model and parameters (including `temperature` and `seed`).
* Exit code: `0` on success, non-zero on an uncaught failure.


## Models and thinking level

The script file allows special directives at the top.

```
@{model='gpt-terra-6'}
```

More directives may be added in the future.

The `think` command's `level` is mapped to the corresponding reasoning-effort setting of the Copilot SDK API.
If the selected model does not support that setting, the runtime logs a warning and continues with the model default.

## Tech stack

The project is written in TypeScript with the GitHub Copilot SDK. The interpreter must be runnable with `npx`
(without a prior global install).