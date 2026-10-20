# Write scripts where prompts are syntax

SPL is a small scripting language for reliable AI workflows. Minimize
entropy by containing LLM calls, be explicit about constraints, validate
schemas and more. Scripts are a compact way to specify what you want - let
the runtime deal with glue code.

Raw tools perform exact I/O, generation returns validated data, and explicit
agents choose actions. Bounded repair and offline replay contain model variance
without silently repeating external actions.

`quickstart.spl`

```spl
@{model='gpt-6-luna'}

def fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}

let fib10 = fib(10)
let modelFib10 = ?{fmt='integer'} 'fibonacci of 10 is?'

assert fib10 == modelFib10 'Oops model got it wrong'

let joke = ?{fmt='object'} 'A joke about programmers as {{"setup": ..., "punchline": ...}}'

let animal = None
enforce 'Answer in Chinese' {
    forbid 'Mentioning the word cat' {
        animal = ?{len='paragraph'} 'Funny story involving a pet animal'
    }
}

success {'fib': fib10, 'modelFib': modelFib10, 'animal': animal, 'joke': joke}
```

## Why SPL?

Solutions talking to LLMs manually usually end up as string-building logic and
ad-hoc parsing. By expressing intent rather than method, you are able to quickly
understand what code is doing and why.

* Prompts as part of syntax - `?` and `think` return values.
  You can store them in variables, test them and interpolate them in strings.
* Clear deterministic boundaries - control flow, arithmetic, interpolation and
  variables never touch the model. Generation has no tools; raw network and shell
  operations still have their normal external variability.
* Least privilege - scopes narrow files, hosts, executables and MCP tools.
  The runtime blocks violations - it does not just ask nicely.
* Untrusted output, validated - `schema` checks structure with field-path errors,
  bounded `repairs` correct generation only, and `assert` checks business rules.
* Runs with `npx` - run `npx spl-lang login` and you are good to go.
* Editor support - the VS Code extension adds a language server, syntax coloring,
  snippets and bracket handling for `.spl` files.

## Design tenets

* Best-effort reproducibility - SPL provides controls to reduce LLM variance.
  Control flow and interpolation are deterministic; live model output is not.
  Schemas and assertions validate answers, while exact generation record/replay
  supports offline regression tests.
* Least privilege - the runtime checks file access, network connections, shell
  execution and MCP usage. Generation has no tools. Raw tools and explicit agents
  are allow-by-default outside `restrict` blocks. Shell command inspection and
  trusted MCP services are not OS sandboxes.

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

* [Getting started](Getting-started.md) - install, authenticate and run your first script.
* [Language basics](Language.md) - variables, strings, operators, control flow and functions.
* [Generation, agents & tools](LLM-commands.md) - modifiers, schemas, repairs, guidance and exact tools.
* [Restrictions](Restrictions.md) - narrow file, network, executable and MCP access.
* [Failures & errors](Failures.md) - failure payloads, status codes and recovery.
* [Built-ins](Builtins.md) - functions and collection methods.
* [CLI & runtime](CLI.md) - options, authentication, persistence and record/replay.
* [Grammar](Grammar.md) - the complete EBNF reference.
* [Examples](Examples.md) - working scripts for extraction, triage, agents and CI gates.
* [VS Code extension](Editor.md) - installation, highlighting and snippets.
* [Architecture](Internals.md) - execution boundaries, embedding and extension points.

## Non-goals

* Bit-for-bit reproducible live model output, a general workflow cache or
  transactional external actions.
* A full Python implementation - SPL supports a deliberately small subset.
