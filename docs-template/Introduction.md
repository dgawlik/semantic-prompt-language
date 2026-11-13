# Build AI workflows in minutes, not hours

Choose between Markdown and SPL format and turn them into runnable AI workflows: natural-language steps alongside native JavaScript,
checked model output, guards and human approval.

`hi.md`

```spl 
{comment}
Prose like this is commentary. Only {js} and {agent} scopes run,
top to bottom, in one shared scope.
{/comment}

{js}
const topics = [
    'recursion', 
    'closures', 
    'regular expressions'
];

const Topic = enumOf(...topics);

const Card = struct('Card', {
    term: Topic,
    definition: str.annotate({ desc: 'A line with definition of' }),
    description: str.annotate({ desc: 'Several sentences about' }),
});

let cards = [];
for (const topic of topics) {
    let card = await ask(
        `A one-sentence flashcard about ${topic}`, 
        { schema: Card, 
          repairs: 1 
    });
    cards.push(card);
}
    
{/js}

{agent model='gpt-6.1-sol', reasoning='high'}
Pick the item of @cards whose card a beginner would find hardest. 
Save that item to @hardest
{/agent}

{js}
const doc = markdown.document()
    .heading(hardest.term, 3)
    .paragraph(markdown.bold(hardest.definition))
    .paragraph(hardest.description);

await writeFile('./out/hardest-card.md', doc.toString());
{/js}
```

* `js` fences are native JavaScript on Node.js. The `spl-lang` library is already imported, so
  `ask`, `struct`, `writeFile` and `markdown` need no `import`.
* `struct` and `enumOf` describe the data a model must return. Annotations such as `desc` are
  written for the model to read.
* `ask(prompt, { schema: Card, repairs: 1 })` validates each answer against `Card`, allows one
  repair attempt and returns a plain JavaScript object.
* The blockquote is an **agent** command. The model loads `cards` and saves `hardest` with tools;
  the next fence uses `hardest` as an ordinary variable.
* `writeFile` is an exact tool: it never calls a model and obeys [restrictions](Safety.md#restrictions).

## Generate reusable functions

`@CODEGEN` asks the model for JavaScript functions and defines them in the shared scope. Later
fences and blockquotes call them like any other function. In code, `await codegen(description)`
does the same and returns the function.

`codegen.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Generate a function, then use it

`@CODEGEN` asks the model for JavaScript functions and defines them in the shared scope.
With `--trace`, the code is saved next to this file as `codegen.sieve.js` and reused on later runs.

    spl examples/codegen.md --trace sieve.jsonl

> @CODEGEN 'Generate sieve(number) sieve of eratosthenes function that returns primes until given number'

```js
log(sieve(100));

const slugify = await codegen('slugify(title): lowercase, trim, and replace runs of non-alphanumeric characters with single dashes');
success(slugify('  Hello, Generated World!  '));
```
````

With `--trace`, the generated code is also saved beside the workflow, here as `codegen.sieve.js`.
Its first line hashes the description, and later traced runs reuse a matching file without
calling the model:

`codegen.sieve.js`

```js
// @CODEGEN sha256:0bf6d0586753d772a87e4af0b9177236e64e481f18c5345569e6a82e3ff35427
function sieve(number) {
    if (number < 2) return [];
    const flags = new Array(number + 1).fill(true);
    flags[0] = flags[1] = false;
    for (let divisor = 2; divisor * divisor <= number; divisor++) {
        if (!flags[divisor]) continue;
        for (let multiple = divisor * divisor; multiple <= number; multiple += divisor) flags[multiple] = false;
    }
    return flags.flatMap((prime, candidate) => prime ? [candidate] : []);
}
```

See [Code generation](LLM-commands.md#code-generation) for validation and cache rules.

## Types the model can read

Types are ordinary JavaScript values built with library functions. They validate data, turn JSON
into JavaScript objects and render the JSON Schema that is sent to the model, including any
annotations you attach.

`types.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Types

This sample shows how to describe model output with types.

```js
const FloatOrInt = union(float, int).annotate({ description: 'Either float or int' });

const numbers = [];
for (let i = 0; i < 4; i++) {
    numbers.push(await ask('Sample number', { tokens: 128, schema: FloatOrInt }));
}

for (const n of numbers) log(Number.isInteger(n) ? `Integer: ${n}` : `Float: ${n}`);
```

```js
const Person = struct('Person', {
    firstName: str,
    lastName: str,
    age: int.annotate({ desc: 'Age in years' }),
}).methods({
    toString() { return `${this.firstName} ${this.lastName} at age ${this.age}`; },
});

const person = await ask('Sample person JSON with firstName, lastName and int age fields', { schema: Person });

success(person.toString());
```
````

`union(float, int)` accepts either number. `.methods({...})` makes parsed answers instances with
methods, so `person.toString()` works on the model's output. See [Types](Language.md#types).

## Why SPL?

1. **Short loops.** One file, run directly. `--check` validates the document without a model, and
   `--trace run.jsonl` resumes recorded work and replays completed runs.
2. **Plain JavaScript where it matters.** Control flow, arithmetic and I/O are native code on
   Node.js, with the standard library and your own modules one `import` away.
3. **Guards you can see.** `fmt`, `schema` and `assert` check data; `restrict` limits what tools
   and agents may touch. Prompt guidance (`enforce`, `forbid`, `len`) is kept separate from validation.
4. **Readable.** Inputs, prompts, checks and outputs sit in one document, top to bottom.
5. **Typed model output.** Enums, structs, classes and named aliases describe what a model must
   return. Annotations advise the model; assertions check whether the content makes sense.

## How a run works

1. Frontmatter opts the file in. Every fence is compiled first, so syntax errors fail before anything runs.
2. Fences and blockquotes execute in document order in one shared scope.
3. A fence runs as JavaScript with top-level `await`. `ask`, `think` and `agent` call the official
   OpenAI, Anthropic and Google clients, one fresh conversation per call.
4. A blockquote sends its text, the visible bindings and the runtime tools to an agent. The model
   calls tools to load and save shared variables, invoke functions, read environment values and
   ask a person. The `@CODEGEN` form generates function declarations instead.
5. `success(value)` ends the run and prints the value on stdout. Logs go to stderr. An uncaught
   failure prints a JSON payload and exits with code 1.

## Non-goals

* A custom programming language. Workflow code is JavaScript; the earlier SPL syntax is
  [gone](Migration.md).
* A sandbox. `restrict` governs the library's tools, agents and MCP servers, not Node.js APIs
  that your own code calls.
* Reproducible model output. Use [traces](CLI.md#traces-and-replay) and
  [pins](CLI.md#pinned-workflows) to replay a recorded run.

## Where next

* [Getting started](Getting-started.md): install, sign in, run and iterate.
* [Workflow code](Language.md): fences, the shared scope, imports, types and the library.
* [Natural language & models](LLM-commands.md): blockquotes, `ask`, `think`, `agent` and output validation.
* [Guards & failures](Safety.md): restrictions, assertions, failures and human input.
* [CLI & runtime](CLI.md): options, traces, pins, MCP and embedding.
* [API reference](Reference.md): every global, option and blockquote tool on one page.
* [Examples](Examples.md): runnable workflows.
* [Migrating from 1.x](Migration.md): the old syntax and its JavaScript replacement.
