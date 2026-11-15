# SPL: Semantic Prompt Language

Run your agentic workflows from single Markdown document or SPL file.

Its `js` fences/blocks run as native JavaScript with the `spl-lang`
toolkit already imported; its blockquotes run as agent commands in plain language. Both share
variables, functions, tools and guards.

[Documentation](https://dgawlik.github.io/semantic-prompt-language/) |
[Examples](lang/examples)

```
{comment}
Prose like this is commentary. Only {js} and {agent} scopes run,
top to bottom, in one shared scope.
The agent selects a topic and saves a validated Card; the final {js}
block only renders it as Markdown.
{/comment}

{js}
const topics = ['recursion', 'closures']
const Topic = enumOf(...topics)
const Card = struct('Card', {
    term: Topic,
    definition: str.describe('Definition one line'),
    description: str.describe('Several sentences about'),
});
{/js}


{agent model='gpt-6.1-sol', reasoning='high'}
Pick the item of @topics that a beginner would find hardest.
Create a flashcard for that topic with term set to the selected topic,
a one-line definition and a description of several sentences.
@validate[Card] save the flashcard to variable @hardest
{/agent}

{js}
const doc = markdown.document()
    .heading(hardest.term, 3)
    .paragraph(markdown.bold(hardest.definition))
    .paragraph(hardest.description);

await writeFile('./out/hardest-card.md', doc.toString());
{/js}
```

## Why SPL?

* **Short loops.** One file, run directly. `--check` needs no model; `--trace run.jsonl` resumes
  recorded work and replays completed runs without repeating model calls or tool effects.
* **Plain JavaScript where it matters.** Fences are native JavaScript on Node.js with top-level
  `await`. The standard library, your own `.js` modules and npm packages are one `import` away.
* **Checked model output.** `ask`/`think` generate values without tools; `fmt`, `schema`,
  `repairs` and `assert` check what comes back. Types are built in JavaScript
  (`struct`, `enumOf`, `list`, `typedef`) and carry annotations for the model to read.
* **Guards you can see.** `agent` calls and blockquotes can act; `restrict` limits their files,
  network, commands and MCP tools. Prompt guidance (`enforce`, `forbid`) is kept separate from validation.
* **A library, not a language.** The same functions work in any Node.js program:
  `import { ask, struct } from 'spl-lang'`.

Try [typed-data.md](lang/examples/typed-data.md) without a model or login. See
[Workflow code](docs-template/Language.md) for the JavaScript rules,
[Types](docs-template/Language.md#types) for the schema builder and
[Schemas and repairs](docs-template/LLM-commands.md#schemas-and-repairs) for typed generation.

## One to one match with markdown


````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Hello, SPL

Prose like this is commentary. Only `js` fences and blockquotes run, top to bottom, in one shared scope.
The library (`ask`, `struct`, `writeFile`, `markdown`, ...) is already imported in every fence.

```js
const Topic = enumOf('recursion', 'closures', 'regular expressions');
const topics = ['recursion', 'closures', 'regular expressions'];

const Card = struct('Card', {
    term: Topic,
    definition: str.annotate({ desc: 'One line about' }),
    description: str.annotate({ desc: 'A paragraph about' }),
});

const cards = await Promise.all(topics.map(topic =>
    ask(`A one-sentence flashcard about ${topic}`, { schema: Card, repairs: 1 })));
```

> Pick the item of @cards whose card a beginner would find hardest. Save that item to @hardest

```js
const doc = markdown.document()
    .heading(hardest.term, 3)
    .paragraph(markdown.bold(hardest.definition))
    .paragraph(hardest.description);

await writeFile('./out/hardest-card.md', doc.toString());
```

````

## Install

```sh
npm install -g spl-lang
spl login openai         # or anthropic / google
spl examples/hi.md
```

Requires Node.js >=24.15.0. Model calls use the official OpenAI, Anthropic and Google clients.
Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` (also
`GOOGLE_API_KEY` / `GEMINI_API_KEY`), or use `spl login <provider>` to save a key and default provider.
Environment keys override saved keys. With multiple providers and no saved default, select one
using `--provider`, `SPL_PROVIDER` or a model such as `--model anthropic/claude-sonnet-4-5`.
Login configures API keys, not subscription OAuth.


## What to know about the JavaScript

* Every fence and blockquote shares one scope. Top-level declarations are visible in later
  fences and to agents; redeclaring a name in a later fence rebinds it, even a `const`.
* The library is already in scope in fences. Always `await` model calls, tools, `human`,
  `restrict` and `codegen`.
* Imports and relative paths resolve against the working directory (`--cwd`), not the workflow
  file. `spl-lang` imported by a helper module is the running copy; no local install is needed.
* `restrict`, traces and pins cover the library's tools, agents and MCP servers. Node.js APIs
  that your code calls directly are neither restricted nor recorded, and helper modules are
  imported again on replay.
* Fences run on the main thread: a long synchronous loop blocks logs and Ctrl+C until it yields.
* `success(value)` ends the run and prints the value. Uncaught exceptions become
  `runtime_error` failures that name the document line.

## Repository

| Folder | Contents |
| --- | --- |
| [lang/](lang/README.md) | The `spl-lang` package: library, runtime, CLI, tests and [examples](lang/examples/) |
| [vscode/](vscode/README.md) | VS Code extension: JavaScript language features in workflow Markdown and `.spl` files, and runnable notebooks |
| [docs-template/](docs-template/Introduction.md) | Documentation sources |
| [docs/](docs/) | Generated documentation site (GitHub Pages); `index.html` is the starter presentation |

[generate-presentation.md](generate-presentation.md) is a workflow that regenerates the
starter presentation in `presentations/`; `node docs/build.mjs` publishes it as the site's front page.

## Development

```sh
npm --prefix lang install
npm test                 # offline library and runtime tests
npm --prefix vscode test # extension tests
```

Tests never contact a model. The [VS Code extension](vscode/README.md) reuses the TypeScript
language service for `js` and `ts` fences and `{js}` and `{ts}` blocks, with the library declared
as globals, and adds `@name` and `@CTL` support in blockquotes and `{agent}` blocks. Editor analysis is offline and never executes workflows.

## Contributing

PRs and Issues are welcome. The most needed help is in running and testing the toolkit.
There are lots of edge cases to consider, if you found the one please let me know.

I'm also looking for maintainers to discuss ideas, where the project should head next and
more importantly implement use cases.
