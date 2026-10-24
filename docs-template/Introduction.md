# Build AI workflows in minutes, not hours

SPL is a compact Python-like language designed for fast iteration: keep
deterministic code separate from LLM calls, contain model variance with explicit
guards, and read the whole workflow at a glance.

Spend time developing the solution, not wiring an orchestration layer. Write a
small script, run it, inspect the result, and refine the prompt or guard. The goal
is a working solution in minutes rather than hours of glue code.

`guarded-triage.spl`

```spl
let report = 'Checkout fails for every customer after deployment.'
let severity = ask(fmt='integer', repairs=1) 'Rate the impact from 1 to 5: {report}'
assert severity >= 1 and severity <= 5 'severity must be between 1 and 5'
let route = if severity >= 4 { 'urgent-review' } else { 'normal-review' }
success {'severity': severity, 'route': route}
```

The `ask` is the only model call. `fmt` checks its output type; `assert` rejects an
out-of-range answer before ordinary code routes it. A reviewer can see the input,
the variable part, the guard, and the result without tracing through callbacks.
These checks constrain the answer; they do not prove the severity assessment is correct.

## Why SPL?

1. **Fast iteration loops.** Start with one file and run it directly with `npx`.
   Check syntax without a model, inspect explicit failures, then adjust the smallest
   prompt or guard. Trace/replay lets you retest deterministic logic and checks
   against the same LLM results when requests stay unchanged.
2. **Separate deterministic logic from LLM judgment.** Control flow, arithmetic,
   interpolation, and variables never call a model. `ask` and `think` generate values
   without tools; `agent` explicitly enables model-directed actions. Validate
   outputs with `fmt`, `schema`, and `assert`; bound repairs and restrict actions
   instead of relying on prompt wording.
3. **Clean syntax that scans quickly.** Familiar expressions, brace-delimited
   blocks, and compact call modifiers keep the workflow visible. Prompts return
   values you can name, test, and pass to ordinary functions, rather than hiding
   control flow in string-building and callback plumbing.

## Design tenets

* Keep ordinary code ordinary. Raw file, web, and shell tools execute explicit
  requests without model interpretation. Their external inputs can still vary;
  model-free I/O is not a promise of reproducible external state.
* Guard before accepting output. Formats and schemas check type and structure;
  assertions check the rules you write. Neither proves factual correctness.
* Repair generation, not actions. Bounded `repairs` correct only format/schema
  failures. Agents reject repair retries so a validation failure cannot
  automatically repeat their external actions.
* Make capabilities visible. `restrict` narrows file, network, executable, and MCP
  access. Tools and agents are allow-by-default outside those scopes. Shell
  inspection and trusted MCP services are not OS sandboxes.
* Reuse results deliberately. Workflow traces capture LLM inputs, outputs, and
  failures. Replay skips the model and agent-owned actions, but explicit script
  tools and stores still execute; it is not a dry run or a state restore.

`enforce`, `forbid` and `len` provide prompt guidance, not validation. Use
`schema` and `assert` to validate results, and `restrict` to check actions.

## How a run works

1. Parse - the lexer and parser check syntax. Unknown or duplicate modifier names
   are syntax errors; modifier values are validated at runtime.
2. Interpret - evaluate statements and expressions deterministically.
3. Assemble - prepend guidance, restrictions and modifier hints to the prompt.
4. Call - use the Copilot SDK for generation or explicit agent actions.
   Agent tool calls are intercepted and checked.
5. Result - print the value of `success` to stdout and logs to stderr.

## Where to next

* [Getting started](Getting-started.md) - install, authenticate and build a short iteration loop.
* [Language basics](Language.md) - variables, strings, operators, control flow and functions.
* [Generation, agents & tools](LLM-commands.md) - modifiers, schemas, repairs, guidance and exact tools.
* [Restrictions](Restrictions.md) - narrow file, network, executable and MCP access.
* [Failures & errors](Failures.md) - failure payloads, status codes and recovery.
* [Built-ins](Builtins.md) - functions and collection methods.
* [CLI & runtime](CLI.md) - options, authentication, persistence and trace/replay.
* [Grammar](Grammar.md) - the complete EBNF reference.
* [Examples](Examples.md) - working scripts for extraction, triage, agents and CI gates.
* [Human in the loop](HITL.md) - noninteractive questions, durable pause/resume and CI integration.
* [VS Code extension](Editor.md) - installation, highlighting and snippets.
* [Architecture](Internals.md) - execution boundaries, embedding and extension points.

## Non-goals

* Bit-for-bit reproducible live model output, a general workflow cache or
  transactional external actions.
* A full Python implementation - SPL supports a deliberately small subset.
