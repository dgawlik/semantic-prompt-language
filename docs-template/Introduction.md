# Build AI workflows in minutes, not hours

Turn Markdown into runnable AI workflows — natural-language steps alongside deterministic code, validation, and human approval.

`hi.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
preamble: 'Be concise.'
---

# Hello, SPL

Prose like this is commentary. Only `spl` fences and blockquotes run, top to bottom, in one shared scope.

```spl

enum Topic = 'recursion' | 'closures' | 'regular expressions'

let topics: list[Topic] = ['recursion', 'closures', 'regular expressions']

struct Card:
    term: Topic
    definition: str [desc = 'One line about']
    description: str [desc='A paragraph about']

let cards = topics.map(
            lambda topic: ask(schema=Card, repairs=1) 
                'A one-sentence flashcard about {topic}'
)
```

> Pick the item of @cards whose card a beginner would find hardest. Save that item to @hardest

```spl
import * as markdown from 'markdown'

let m = markdown.Document()

m.heading(hardest.term, 3)
m.paragraph(markdown.bold(hardest.definition))
m.paragraph(hardest.description)

write_file('./out/hardest-card.md', m.to_string())
```
````

* built-in `ask` generates LLM response with schema validation and one repair 
* natural language blockquote uses **agent** mode to follow instructions and uses **tools** 
to save variable, the variable is saved to global scope 
* `schema=Card` decodes each answer and hydrates contructor-free instance of class `Card`, 
see [Gradual typing](Language.md#gradual-typing)
* `assert` breaks flow in case of mimatch
* `restrict` limits scope's file access to particular location
* `success` returns json 

## Generate reusable functions

Use `@CODEGEN` with a literal string description to generate SPL functions. Once validated,
they are available to later code and blockquotes in the same session, without imports:

````markdown

> @CODEGEN 'Generate sieve(number) sieve of eratosthenes function that returns primes until given number'

```spl 
log(sieve(100))
```
````

*generated.spl*

```spl
# @CODEGEN sha256:0bf6d0586753d772a87e4af0b9177236e64e481f18c5345569e6a82e3ff35427
def sieve(number):
    if number < 2:
        return []
    let flags = list(range(0, number + 1)).map(lambda index: True)
    flags[0] = False
    flags[1] = False
    let divisor = 2
    while divisor * divisor <= number:
        if flags[divisor]:
            let multiple = divisor * divisor
            while multiple <= number:
                flags[multiple] = False
                multiple = multiple + divisor
        divisor = divisor + 1
    return list(range(2, number + 1)).filter(lambda candidate: flags[candidate])
```

With `spl flow.md --trace run.jsonl`, the definition is also saved beside the workflow as
`flow.double.spl`. Its top-level `# @CODEGEN sha256:...` comment hashes the description.
Later traced runs reuse matching definitions without contacting the model, even with a new
trace file. Multiple codegen blockquotes can generate separate functions. Without `--trace`,
functions remain session-local and no files are saved.
See [Code generation](LLM-commands.md#code-generation) for cache and validation details.


## Opt-in Types 

Language is dynamic but has full support for opt-in static type checker. There are supported 
primitive types, structs, classes and dynamic catch-all objects. Functions are first class citizens.

````markdown

---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Types 

This sample shows how to use opt-in types.

```spl
type FloatOrInt = float | int [description = 'Either float or int']

let numbers: list[FloatOrInt] = []

for i in range(4):
    let num = ask(tokens=128, schema=FloatOrInt) 'Sample number'
    numbers.append(num)

for n in numbers:
    if isinstance(n, int):
        log('Integer: {n}')
    else:
        log('Float: {n}')
```

```spl
class Person:
    firstName: str 
    lastName: str 
    age: int 

    def toString():
        return '{self.firstName} {self.lastName} at age {self.age}'

let result = ask(schema=struct(Person)) 'Sample person JSON with firstName, lastName and int age fields'

let person: Person = validate(result, Person)

success person.toString()
```
````

## Why SPL?

1. **Short loops.** One file, run directly. `--check` validates syntax without a model, and
   `--trace run.jsonl` resumes recorded work automatically and replays completed runs deterministically.
2. **Exact code where it matters.** Control flow, arithmetic and I/O never call a model.
   `ask` and `think` generate values without tools; `agent` expressions and blockquotes can act.
3. **Guards you can see.** `fmt`, `schema` and `assert` check data; `restrict` checks actions.
   Prompt guidance (`enforce`, `forbid`, `len`) is kept separate from validation.
4. **Readable.** Inputs, prompts, checks and outputs sit in one document, top to bottom.
5. **Optional typed contracts.** Enums, structs, classes and reusable aliases describe model
   output. Annotations, typed functions and persistent mutable contracts enforce consistency;
   assertions still check whether the content makes sense.

## How a run works

1. Frontmatter opts the file in. All fences are parsed first, so syntax errors fail before anything runs.
2. Fences and blockquotes execute in document order in one shared scope.
3. A blockquote sends its text, visible bindings and runtime tools to an agent. The model calls
   tools to invoke functions, read environment values, request human input and load/save shared variables.
   The explicit `@CODEGEN` form instead generates and validates SPL function definitions.
4. `ask`, `think` and `agent` use the official OpenAI, Anthropic and Google clients, one fresh conversation per call.
5. `success` prints the result on stdout. Logs go to stderr.

## Non-goals

* Full Python, inheritance, recursive schemas or general-purpose automatic source conversion.
* Reproducible model output, transactional actions or an OS sandbox.

## Where next

* [Getting started](Getting-started.md): install, sign in, run and iterate.
* [Language](Language.md): SPL syntax, scopes, built-ins and tools.
* [Natural language & models](LLM-commands.md): blockquotes, `ask`, `think`, `agent` and output validation.
* [Guards & failures](Safety.md): restrictions, assertions, failures and human input.
* [CLI & runtime](CLI.md): options, append-only traces, MCP and embedding.
* [Examples](Examples.md): real-world workflows.
* [Typing migration](Migration.md): breaking syntax, contracts, numeric representations and class schemas.
