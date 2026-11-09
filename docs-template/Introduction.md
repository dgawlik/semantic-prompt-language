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

## Control Randomness

The language has built in constructs that limit LLM drift and let you concisely
define what you are expecting.
Set `temperature` near zero and `top_p` to a small value (for example, `0.0001`) in `ask(...)`
to reduce variability where supported. Sampling is best-effort, not guaranteed reproducibility.

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Randomness Controls

This document shows how to limit randomness in LLM prompts with `ask` sampling modifiers.
Sampling is best-effort and does not guarantee identical responses.

```spl
let recipe1 = ask(seed=13, temperature=0.0, top_p=0.0001, tokens=1024) \
                '<most-frequent>give a recipe for an apple pie</most-frequent>';

let recipe2 = ask(seed=13, temperature=0.0, top_p=0.0001, tokens=1024) \
                '<most-frequent>give a recipe for an apple pie</most-frequent>';

success [recipe1, recipe2]
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
