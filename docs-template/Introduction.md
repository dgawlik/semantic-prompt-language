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
let topics = ['recursion', 'closures', 'regular expressions']

hydratable class Card:
    term: str
    definition: str

let cards = object()
for topic in topics:
    cards[topic] = ask(schema=Card, repairs=1) 'A one-sentence flashcard about {topic}'
```

> Pick the key of @cards whose card a beginner would find hardest. Save that exact key to @hardest

```spl
assert hardest in topics "unexpected topic '{hardest}'"
restrict './out':
    write_file('./out/cards.json', json_stringify(object(cards), 2))
success object:
    'cards': len(cards)
    'hardest': hardest
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


## Opt-in Types 

Language is dynamic but has full support for opt-in static type checker. There are supported 
primitive types, structs, classes and dynamic catch-all objects. Functions are first class citizens.

````markdown

```spl
enum Color = 'red' | 'green' | 'blue'
type Palette = list[Color]
type Money = int [minimum=0, desc='Amount in cents']
type MaybeMoney = Money | None

struct Address:
    city: str
    postalCode: str | None

hydratable class Person:
    name: str
    favorite: Color
    address: Address

    def Person(name: str, favorite: Color, address: Address):
        self.name = name
        self.favorite = favorite
        self.address = address

    def greeting() -> str:
        return 'Hello {self.name}'

def repeat(text: str, count: int) -> str:
    return text * count

struct Handler:
    callback: fn(str, int) -> str

let count: int = 2
let ratio: float = 1.0
let initial: char = 'A'
let enabled: bool = True
let colors: Palette = ['blue']
let alias = colors
alias.append('green')
assert len(colors) == 2 'untyped aliases share the same guarded list'

let subtotal: Money = 1250
let total: Money = subtotal * count
let discount: MaybeMoney = None
assert total >= 0 'amounts must not be negative'
let typed_length: int = int(len(colors))
let scaled: float = float(count) * ratio
assert typed_length == count and scaled == float(count) 'convert dynamic or mixed numbers explicitly'
assert json_stringify([count, ratio]) == '[2,1.0]' 'typed numeric JSON preserves representations'

let raw_address = json_parse(r'{"city":"London","postalCode":null}')
let address: Address = validate(raw_address, Address)
let person = Person('Ada', colors[0], address)
let handler: Handler = object:
    'callback': repeat
let choice: int | str = count
if isinstance(choice, int):
    assert choice == count 'the union currently contains an integer'
choice = 'blue'
if isinstance(choice, str):
    assert choice.upper() == 'BLUE' 'narrow unions before string operations'
assert initial == 'A' and enabled and discount == None 'primitive and nullable values'
assert handler.callback('Hi ', count) == 'Hi Hi ' 'callable fields check arguments and results'

let snapshot = object(person)
snapshot.address.city = 'Paris'
assert person.address.city == 'London' 'deep projections must not mutate the source'
log(person.greeting(), handler.callback('Hi ', count))
success object(person)
```
````

## Why SPL?

1. **Short loops.** One file, run directly. `--check` validates syntax without a model, and
   trace/replay reruns your code and guards against recorded model answers.
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
   It never submits generated SPL.
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
* [CLI & runtime](CLI.md): options, traces, stores, MCP and embedding.
* [Examples](Examples.md): real-world workflows.
* [Typing migration](Migration.md): breaking syntax, contracts, numeric representations and class schemas.
