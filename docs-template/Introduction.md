


# Write scripts here prompts are syntax

SPL is small scripting language for reliable AI workflows. Minimize
entropy by containing LLM calls, be explicit about contraints, validate
schema and more. Scripts are compact way to specify what you want - let
the runtime deal with glue code.

quickstart.spl
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

enforce 'Answer in Chinese' {
    forbid 'Mentioning the word cat' {
        let animal = ?{len='paragraph'} 'Funny story involving a pet animal'
    }
}

success {'fib': fib10, 'modelFib': modelFib10, 'animal': animal, 'joke': joke}
```

## Why SPL?

Solutions talking to LLMs manually usually end up as string building logic and 
ad-hoc parsing. By expressing intent rather than method you are able to quickly
understand what code is doing and why.


* Prompts as a part of syntax - `?` and `think` return results applied to specification.
You can store them in variables and interpolate anywhere.
* Clear deterministic boundaries - only LLMs introduce variance, rest of the language is
purely deterministic. You can reduce entropy by enforcing constraints.
* Least priviledge - scopes narrow files, hosts and executables. The runtime blocks violations — it doesn't just ask nicely.
* Runs with npx - spl login and you are good to go. 
* Editor support - vscode plugin adds simple language server and syntax coloring for .spl files

## Design tenets

* Best effort determinism - SPL brings in controls to the table to reduce LLM variance, it's core purpose
is to write automatable scripts that anytime they run return similar results
* Least priviledge - runtime enforces file accesses, network connections, shell executions and mcp usage.
Always limit the degree of freedom the model has - for your own good.


