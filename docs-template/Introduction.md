# Build AI workflows in minutes, not hours

A `.spl` file is TypeScript with instructions for models and agents written between the lines.
One file holds the code, the prompts, the types that check model output, the guards and the human approval.

`hi.spl`

```spl
//*
# Hello, SPL

A `.spl` file is TypeScript. Markdown comments like this one are commentary, and each `---` block is an
instruction for a model. Everything runs top to bottom, and the library (`ask`, `Struct`, `writeFile`,
`markdown`, ...) needs no import.

    spl run examples/hi.spl
*//

---
model: gpt-6-luna
enforce: Be concise.
---

const topics = ['recursion', 'closures', 'regular expressions'];
const Topic = Enum(...topics);

const Card = Struct('Card', {
    term: Topic,
    definition: Str.describe('One line about the term'),
    description: Str.describe('A paragraph about the term'),
});

const cards = await Promise.all(topics.map(topic =>
    ask(`A one-sentence flashcard about ${topic}`, { schema: Card, repairs: 1 })));

//*
The agent reads `cards` through a tool and must save a value that fits `Card`.
*//

---
mode: agent
reasoning: high

Pick the item of @cards whose card a beginner would find hardest ->[Card] @hardest
---

const doc = markdown.document()
    .heading(hardest.term, 3)
    .paragraph(markdown.bold(hardest.definition))
    .paragraph(hardest.description);

await writeFile('./out/hardest-card.md', doc.toString());
```

* **Code is TypeScript** on Node.js. The library is already in scope, so `ask`, `Struct`,
  `writeFile` and `markdown` need no `import`. Type annotations are erased when the file runs
  and checked by `spl check`.
* **`//* ... *//` is a Markdown comment.** It is commentary for readers, and
  [`spl doc`](CLI.md#spl-doc) turns it into the prose of the generated documentation.
* **The first `---` block has no instruction**, so it sets [file defaults](Language.md#file-defaults):
  the model and guidance for every model call in the file.
* **`Struct` and `Enum` describe the data a model must return.** Descriptions are written for
  the model to read. `ask(prompt, { schema: Card, repairs: 1 })` converts each answer to a
  `Card` and allows one repair attempt.
* **The second `---` block is an instruction for an agent.** `@cards` is an input the agent
  reads with a tool, and `->[Card] @hardest` is an output it must save. After the block,
  `hardest` is an ordinary typed constant.
* **`writeFile` is an exact tool.** It never calls a model and obeys [restrictions](Safety.md#restrictions).

## Three additions to TypeScript

Everything in a `.spl` file is TypeScript except three things.

| Syntax | Meaning |
| --- | --- |
| `//*` ... `*//` | A [Markdown comment](Language.md#markdown-comments): prose for readers and for `spl doc` |
| `---` ... `---` | A [block](Language.md#blocks): an optional header of `key: value` lines, then an instruction for a model |
| `@name`, `->[Type] @name` | Inside a block: a [reference](LLM-commands.md#references) to a variable, and an output the block declares |

A block has one of three modes. An [ask block](LLM-commands.md#ask-blocks) is one prompt and one
model call. An [agent block](LLM-commands.md#agent-blocks) lets the model act with tools until it
has saved every output. A [codegen block](LLM-commands.md#codegen-blocks) generates functions.

## Generate reusable functions

A codegen block asks the model for JavaScript functions and declares them as typed constants.
Later code calls them like any other function. In code, `await codegen(description)` does the
same and returns the function.

`codegen.spl`

```spl
//*
# Generate a function, then use it

A codegen block asks the model for JavaScript functions and declares them as typed constants.
The code is cached next to this file, as `codegen.sieve.js`, and reused on later runs.

    spl run examples/codegen.spl
*//

---
model: gpt-6-luna
---

---
mode: codegen

Sieve of Eratosthenes that returns the primes up to a given number -> @sieve(limit: number): number[]
---

log(sieve(100));

const slugify = await codegen<(title: string) => string>(
    'slugify(title): lowercase, trim, and replace runs of non-alphanumeric characters with single dashes');
success(slugify('  Hello, Generated World!  '));
```

The generated code is saved beside the workflow, here as `codegen.sieve.js`. Its first line
hashes the description, and later runs reuse a matching file without calling the model:

`codegen.sieve.js`

```js
// @CODEGEN sha256:63a8c1402b9798b9c5bddb266580ae8096505425bfb62dee3ef7da257007760f
function sieve(limit) {
    if (typeof limit !== 'number' || limit < 2) {
        return [];
    }
    const isPrime = new Array(limit + 1).fill(true);
    isPrime[0] = false;
    isPrime[1] = false;
    for (let i = 2; i * i <= limit; i++) {
        if (isPrime[i]) {
            for (let j = i * i; j <= limit; j += i) {
                isPrime[j] = false;
            }
        }
    }
    const primes = [];
    for (let i = 2; i <= limit; i++) {
        if (isPrime[i]) primes.push(i);
    }
    return primes;
}
```

See [Codegen blocks](LLM-commands.md#codegen-blocks) for the checks and the cache rules.

## Types the model can read

Types are ordinary values built with library functions. They check data, convert what a model
sends into JavaScript objects and render the JSON Schema that the model receives, including
any descriptions you attach.

`types.spl`

```spl
//*
# Types

This sample shows how to describe model output with types, in a block and in a function call.

    spl run examples/types.spl
*//

---
model: gpt-6-luna
---

const FloatOrInt = Union(Float, Int).describe('Either float or int');

const numbers: number[] = [];
for (let i = 0; i < 4; i++) {
    numbers.push(await ask('Sample number', { tokens: 128, schema: FloatOrInt }));
}

for (const n of numbers) log(Number.isInteger(n) ? `Integer: ${n}` : `Float: ${n}`);

const Person = Struct('Person', {
    firstName: Str,
    lastName: Str,
    age: Int.describe('Age in years'),
}).methods({
    toString() { return `${this.firstName} ${this.lastName} at age ${this.age}`; },
});

---
outputVar: person
outputType: Person

A sample person
---

success(person.toString());
```

`Union(Float, Int)` accepts either number. `.methods({...})` makes converted answers objects
with methods, so `person.toString()` works on the model's output. `outputType: Person` gives
the block's output the TypeScript type of `Person`. See [Types](Language.md#types).

## Why SPL?

1. **Short loops.** One file, run directly with `spl run`. `spl check` type-checks it without a
   model, and `--trace run.jsonl` resumes recorded work and replays completed runs.
2. **Plain TypeScript where it matters.** Control flow, arithmetic and I/O are native code on
   Node.js, with the standard library and your own modules one `import` away.
3. **Prompts without string plumbing.** An instruction is plain text between two `---` lines.
   `@name` passes a value in and `->[Type] @name` takes a typed value out.
4. **Guards you can see.** Types and `assert` check data; `restrict` limits what tools and
   agents may touch. Prompt guidance (`enforce`, `forbid`) is kept separate from validation.
5. **Readable.** Inputs, prompts, checks and outputs sit in one file, top to bottom, and
   `spl doc` renders it as a document.

## How a run works

1. The scanner turns the file into TypeScript: comments become blank lines and each block
   becomes a call on the lines it occupied. Syntax errors stop the run before anything executes.
2. Node.js erases the type annotations and the result runs as an ES module with top-level `await`.
3. Code runs top to bottom. `ask()` and `agent()` call the official OpenAI, Anthropic and
   Google clients, one fresh conversation per call.
4. An ask block sends its instruction with the referenced values as JSON and converts the
   answer to its output type. An agent block gives the model tools to read its inputs, call
   the functions it mentions, use files, the web and the shell, and save its outputs.
5. `success(value)` ends the run and prints the value on stdout. Logs go to stderr. An uncaught
   failure prints a JSON payload and exits with code 1.

## Non-goals

* **A custom programming language.** Workflow code is TypeScript. The Markdown workflows and
  the block tags of SPL 2.x are [gone](Migration.md).
* **A sandbox.** `restrict` governs the library's tools, agents and MCP servers, not the
  Node.js APIs that your own code calls.
* **Reproducible model output.** Use a [trace](CLI.md#traces-and-replay) to replay a recorded run.

## Where next

* [Getting started](Getting-started.md): install, sign in, run and iterate.
* [Workflow code](Language.md): the file format, the TypeScript dialect, imports, types and the library.
* [Natural language & models](LLM-commands.md): blocks, references, `ask`, `agent`, models and reasoning.
* [Guards & failures](Safety.md): restrictions, assertions, failures and human input.
* [CLI & runtime](CLI.md): commands, options, traces, MCP and embedding.
* [API reference](Reference.md): every header key, global, option, tool and error on one page.
* [Examples](Examples.md): runnable workflows, documented by `spl doc`.
* [Migrating from 2.x](Migration.md): each 2.x construct and its 3.0 form.
