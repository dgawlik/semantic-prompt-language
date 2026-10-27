# Build AI workflows in minutes, not hours

Run all your workflows in Markdown editor. SPL understands both code and natural language. `spl` code fences hold exact, Python-like code; blockquotes hold natural-language agent commands. Both share one scope, the same tools and the same guards, so each step can be written in whichever form reads best.

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
let Card = {
    'type': 'object',
    'properties': {'term': {'type': 'string'}, 'definition': {'type': 'string'}},
    'required': ['term', 'definition'],
    'additionalProperties': False,
}
let cards = {}
for topic in topics {
    cards[topic] = ask(schema=Card, repairs=1) 'A one-sentence flashcard about {topic}'
}
```

> Pick the key of @cards whose card a beginner would find hardest. Save that exact key to @hardest

```spl
assert hardest in topics "unexpected topic '{hardest}'"
restrict './out' {
    write_file('./out/cards.json', json_stringify(cards, 2))
}
success {'cards': len(cards), 'hardest': hardest}
```
````

The loop is ordinary code; each `ask` must return JSON matching `Card`, with one repair attempt.
The blockquote agent saves its answer through a shared-variable tool, and the `assert` after it checks the result.
Writing is limited to `./out`.

## Why SPL?

1. **Short loops.** One file, run directly. `--check` validates syntax without a model, and
   trace/replay reruns your code and guards against recorded model answers.
2. **Exact code where it matters.** Control flow, arithmetic and I/O never call a model.
   `ask` and `think` generate values without tools; `agent` expressions and blockquotes can act.
3. **Guards you can see.** `fmt`, `schema` and `assert` check data; `restrict` checks actions.
   Prompt guidance (`enforce`, `forbid`, `len`) is kept separate from validation.
4. **Readable.** Inputs, prompts, checks and outputs sit in one document, top to bottom.

## How a run works

1. Frontmatter opts the file in. All fences are parsed first, so syntax errors fail before anything runs.
2. Fences and blockquotes execute in document order in one shared scope.
3. A blockquote sends its text, visible bindings and runtime tools to an agent. The model calls
   tools to invoke functions, read environment values, request human input and load/save shared variables.
   It never submits generated SPL.
4. `ask`, `think` and `agent` call GitHub Copilot through the Copilot SDK, one fresh session per call.
5. `success` prints the result on stdout. Logs go to stderr.

## Non-goals

* Full Python, classes or a static type system.
* Reproducible model output, transactional actions or an OS sandbox.

## Where next

* [Getting started](Getting-started.md): install, sign in, run and iterate.
* [Language](Language.md): SPL syntax, scopes, built-ins and tools.
* [Natural language & models](LLM-commands.md): blockquotes, `ask`, `think`, `agent` and output validation.
* [Guards & failures](Safety.md): restrictions, assertions, failures and human input.
* [CLI & runtime](CLI.md): options, traces, stores, MCP and embedding.
* [Examples](Examples.md): real-world workflows.
