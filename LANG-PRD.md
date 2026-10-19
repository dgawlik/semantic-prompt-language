# Semantic Prompt Language: 0.3 specification

SPL is a small Python-like language for AI workflows. Braces delimit blocks; statements
end at newlines or semicolons. The [EBNF](lang/docs/syntax.ebnf) specifies the syntax.
This version intentionally breaks 0.2 syntax; see the [migration guide](README.md#breaking-changes-in-03).

## Goals and boundaries

1. Deterministic control flow and data manipulation; model outputs are nondeterministic.
2. Explicit separation of exact I/O, generation, and model-directed actions.
3. Runtime validation of model output before the program consumes it.
4. Bounded generation repair without repeating external actions.
5. Offline generation regression tests through exact record/replay.
6. Guidance must not be described as a runtime guarantee.

Not goals: full Python compatibility, classes, a static type system, general workflow
caching, transactional external actions, an OS sandbox, or bit-for-bit reproducible live output.
The Copilot SDK does not expose temperature/seed controls used by this runtime.

## Bindings

`let name = expression` declares or redeclares a binding in the current function/script.
`name = expression` and compound assignments require an existing binding in that local scope.
Functions can read lexical enclosing scopes but cannot rebind their callers' variables.
There is no implicit nonlocal assignment.

All blocks, including bare grouping blocks, share their enclosing function/script scope.
Only function calls introduce a new local scope. Parameters, loop variables, function
definitions, and caught-failure names create local bindings.
List/dict members remain mutable and can be shared across function boundaries.

Values: None, bool, number, string, list, string-keyed dict, and functions.
Python-style operators, comparisons, short-circuiting, indexing, slicing, methods,
closures, recursion, loops, and conditionals form the deterministic subset.
Strings interpolate `{expression}`; `{{`/`}}`, escaped braces, and raw strings provide literal braces.

## Exact tools

The following are ordinary positional built-in functions, not language keywords:

| Function | Result |
|---|---|
| `read_file(path)` | Exact UTF-8 file text |
| `write_file(path, content)` | Write confirmation text |
| `web_fetch(url)` | HTTP response body text |
| `web_search(query)` | Search result text |
| `shell(command)` | Combined stdout/stderr; nonzero exit raises `tool_error` |

All arguments are required strings. No tool invokes a model.
Tools use the active restrictions and paths relative to `--cwd`.
Network responses can vary externally; "exact" means no model interpretation.
Shell timeout is 120 seconds; HTTP timeout is 30 seconds; redirects are limited to five.
Agent-facing tool results may be truncated with an explicit marker; raw I/O is not truncated.

## Generation and agency

`? prompt` is a prefix expression at unary precedence. `think prompt` is generation
with medium reasoning by default. Both have no runtime, built-in Copilot, or MCP tools,
and unexpected permission requests abort the call.

`agent prompt` explicitly enables model-directed runtime and configured MCP tools.
Agents default to medium reasoning. Actions remain subject to active restrictions;
agents are not automatically retried.

All three accept a brace modifier list. Names are unique and checked at parse time;
values are arbitrary expressions, evaluated once and checked at runtime before a call.

| Modifier | Contract |
|---|---|
| `len` | `word`, `sentence`, `paragraph`, `long`; prompt hint only |
| `fmt` | `text` (default), `json` (any JSON value), `object` (object/array) |
| `reasoning` | `low`, `medium`, `high`; model support is best effort with warnings |
| `show` | Boolean, default False; stream available model reasoning to info logs |
| `schema` | Strict synchronous JSON Schema draft-07 object/boolean; implies json format |
| `repairs` | Integer 0..5; additional generation attempts, default 0 |
| `model` | Nonempty model identifier |

Model precedence: CLI override > per-call modifier > header `@{model='...'}` > SDK default.
Every call uses a fresh session; context must be passed explicitly through values.

### Structured output and repairs

JSON parsing is strict: no extraction from prose or Markdown fences.
Schema compilation uses Ajv strict mode, without coercion, defaults, or deleting extra fields.
Invalid schemas and configuration combinations are `runtime_error` before model invocation.
Asynchronous schemas and unresolved external references are not supported.

Malformed JSON raises `invalid_format`. Schema mismatch raises `validation_failed`
with field paths, including missing fields and array indices.
`schema` cannot be combined with `fmt='text'`. Repairs require JSON output.

Repair runs only for `invalid_format` and `validation_failed`, giving the model its previous
answer and validation errors. The prompt and modifier expressions are not reevaluated.
The maximum number of model calls is `1 + repairs`. Transport/model/tool/restriction errors
are not repaired. Agents require `repairs=0`.
Business rules are explicit `assert` statements outside schema repair.

## Guidance and restrictions

`instruct text { ... }` and `avoid text { ... }` prepend scoped response guidance.
They apply dynamically to calls in the block and called functions; nested guidance combines
and unwinds on exit. They do not verify compliance.

`restrict [fs|net|exec|mcp] expression { ... }` checks actions at runtime.
The default kind is fs. Arguments are comma-separated strings or nonempty string lists.
Clauses can be combined, and nested/repeated clauses of one kind intersect.

- fs canonicalizes relative paths, `..`, and symlinks before checking containment.
- net checks exact hosts or wildcard subdomains, including every redirect hop.
- exec checks executable names, chains, pipelines, path-like arguments, and redirections.
  This is best effort, not an OS sandbox for programs with their own I/O.
- mcp checks configured server/tool selectors; configuration allowlists cannot be widened.
  MCP servers are trusted services; these scopes do not sandbox server-internal I/O.

Raw tools and agents are allow-by-default outside restrictions. Generation has no tools
regardless of scopes. Permission requests for tools outside the runtime/configuration are rejected.

## Failures and termination

`assert condition [message]` raises `assertion_failed`, `fail reason` raises
`explicit_failure`, and `try { ... } except name { ... }` binds the caught failure payload.
All script failures have `status`, `reason`, `command`, `line`, and `status_code`.
Other categories: `invalid_format`, `validation_failed`, `restriction_violation`,
`llm_error`, `tool_error`, `runtime_error`.

`return` immediately exits the innermost function or the script at top level.
`success [value]` immediately ends the script, even from a function.
`break`/`continue` require a lexically enclosing loop in the same function.
Syntax errors are detected before execution and are not catchable.

## Persistence and record/replay

Variable stores are opt-in. They seed script locals and save nonfunction globals on exit,
even after a script failure. This is not transactionality or a record of completed actions.

`--record file.jsonl` writes a new generation recording and refuses an existing path.
`--replay file.jsonl` reads it without starting Copilot or MCP servers.
The JSONL header is `{"format":"spl-generation","version":1}`.
Each subsequent line contains a serialized request key and raw backend response.

Request keys include call kind, assembled prompt, requested model, reasoning effort,
and show-reasoning flag. Calls match exactly and in order, including repair attempts.
Mismatches, exhausted recordings, and unused entries are explicit failures.
Recordings capture successful backend responses, not transport errors.

Agents are rejected in record and replay modes. Replay permits local reads only:
writes, shell, network, and persistent stores are blocked before execution.
It never replays external side effects and is not a general workflow cache.
Recordings and logs contain sensitive prompt/response content and require appropriate handling.

## CLI, documentation, and validation

stdout carries the script result or failure payload; stderr carries logs.
Exit codes: 0 success, 1 script failure, 2 syntax/usage, 70 internal error.
`--check` validates syntax and supplied MCP configuration, not runtime expressions/schemas.
Non-silent levels include full model transcripts and executed-statement traces.

Changes must stay consistent across parser/runtime, EBNF, examples, site reference,
READMEs, editor highlighting/snippets, and offline tests.
Tests are offline by default; authenticated live tests require `SPL_LIVE_TESTS=1`.
