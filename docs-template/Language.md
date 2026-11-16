# Workflow code

A `.spl` file is TypeScript running on Node.js, with the `spl-lang` library already in scope,
Markdown comments and `---` blocks. This page covers the file format, the TypeScript dialect,
imports, the library, types, the Markdown builder, inputs, logging, tools and errors.

## The file format

A `.spl` file is TypeScript with three extensions: Markdown comments, blocks, and references
inside blocks.

`basics.spl`

```spl
//*
# Fibonacci check

This a markdown comment. It is rendered as prose by `spl doc`.

Points:
* one
* two
*//

---
model: gpt-6-luna
---

const Joke = Struct('Joke', { setup: Str, punchline: Str });

function fib(n: number): number {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

function factorial(n: number): number {
    return n === 0 ? 1 : n * factorial(n - 1);
}

---
mode: agent
reasoning: high

Invoke @factorial with 15 as argument ->[Int] @fact15
Invoke @fib with 10 as argument ->[Int] @fib10
Add 2 to @fib10 ->[Int] @fibPlus2
Work out the 10th Fibonacci number yourself, without using @fib ->[Int] @modelFib10
---

assert(fib10 === modelFib10, 'Oops, the model got it wrong');

---
enforce: Answer in Chinese
forbid: Mentioning the word cat
outputVar: joke
outputType: Joke

A joke about programmers with a setup and a punchline.
---

---
outputVar: animal

A paragraph of a funny story about a pet animal.
---

success({ fib: fib10, modelFib: modelFib10, joke, animal });
```

1. The `//* ... *//` comment is Markdown. It never runs.
2. The first block has a header and no instruction, so it sets the model for the whole file.
3. `Joke`, `fib` and `factorial` are plain TypeScript.
4. The agent block is one agent call. It reads `@factorial` and `@fib`, which are functions it
   may call, and declares four `Int` outputs with `->[Int] @name`.
5. `assert` compares the function's result with the model's own.
6. The last two blocks are ask blocks, the default mode: one prompt and one model call each.
   `outputVar` names the constant that receives the answer and `outputType` converts it.
7. `success` ends the run with a result.

### Markdown comments

A Markdown comment starts with a line that begins with `//*` and ends with a line that
contains only `*//`. Leading whitespace is allowed before both markers.

* **Top level only.** A Markdown comment may not stand inside any `{`, `(` or `[`, or inside a
  block. Anywhere else it is an error: ``Markdown comments (`//*`) are only allowed at the top level``.
* **It must be closed.** An unclosed `//*` is an error at its line:
  ``Unclosed Markdown comment: `//*` needs a closing `*//` at the start of a line``.
* **The content is Markdown.** [`spl doc`](CLI.md#spl-doc) copies it as prose, and the
  VS Code extension colors it as Markdown.
* **Ordinary comments stay code.** `//` and `/* */` comments are part of the TypeScript and
  appear inside the code listings of `spl doc`.

### Code

Everything outside Markdown comments and blocks is TypeScript. The scanner skips strings,
template literals, regular expressions and comments, so `---` or `//*` inside them is never
treated as syntax.

```ts
const rule = `
---
`;
const pattern = /---/; // --- neither of these opens a block
```

### Blocks

A line containing only `---` opens a block, and the next such line closes it. Whitespace
around the dashes is allowed.

```spl
---
mode: agent
model: gpt-6.1-sol
restrict: { fs: ./reports }

Convert @groups to a Markdown report and write it to './reports/review.md'
---
```

A block is an optional **header**, then the **instruction**.

* **The header** is the run of leading lines of the form `key: value` whose key is a known
  [header key](LLM-commands.md#the-header). A blank line, or the first line whose key is
  unknown, ends it. The instruction may therefore contain lines such as `Sources: none`.
* **Values are YAML**: strings, numbers, `true` and `false`, lists and maps. A value may
  continue on indented lines, as in a YAML list. `outputType` is the exception: its value is
  TypeScript, taken as written up to the end of the line.
* **A near miss is an error.** A misspelled key such as `modle:` reports
  ``unknown header key `modle`; did you mean `model`?``. A key set twice and a value of the
  wrong kind are errors too.
* **The instruction is plain text.** Its common indentation and the blank lines around it are
  removed. There is no `${...}` interpolation, so backticks, braces and dollar signs need no
  escaping. `@name` is a [reference](LLM-commands.md#references) and `@@` writes a literal `@`.
* **Fences come in pairs.** An odd number of `---` lines is an error that names the unmatched
  opening line: `` Unmatched block opened at line 12: every `---` needs a closing `---` ``.
  A Markdown horizontal rule cannot be written as `---` inside a block; use `***`.
* **A block is never empty.** Two `---` lines with nothing between them report
  ``empty block: write an instruction between the `---` lines``.

The `mode` key selects what the block does:

| Mode | The block is | Outputs |
| --- | --- | --- |
| `ask` (default) | One prompt and one model call, without tools | One, named by `outputVar` |
| `agent` | One agent call: the model acts with tools | Any number, written `->[Type] @name` in the instruction |
| `codegen` | One model call that writes functions | Functions, written `-> @name(params): Type` |

[Natural language & models](LLM-commands.md) describes each mode.

### File defaults

A block that has header lines but no instruction sets defaults for the whole file.

```spl
---
model: gpt-6-luna
reasoning: low
enforce: Be concise.
---
```

* **It comes first.** The defaults block is only allowed as the first item in the file that is
  not a comment. Later it is an error:
  `File defaults must come first: a block without an instruction sets defaults for the whole file`.
* **Six keys can be defaults:** `model`, `reasoning`, `enforce`, `forbid`, `hide` and `tokens`.
  Any other key reports, for example,
  `` `mode` cannot be a file default; it belongs to a block with an instruction ``.
* **They apply to every model call of the file:** its blocks, and the `ask()`, `agent()` and
  `codegen()` calls made while it runs. A block or a call that sets `model`, `reasoning`, `hide`
  or `tokens` itself overrides the default. `enforce` and `forbid` add up.

### Placement and scope

A block is a statement. It may stand wherever a statement may: at the top level, in function
bodies, loops, `if` and `try`.

`conditional-workflows.spl`

```spl
//*
# Conditional workflows

Blocks are statements, so they can sit inside `if` and `while`. An output written as `=name`
assigns an existing variable instead of declaring a new one.

    spl run examples/conditional-workflows.spl --arg color
*//

---
model: gpt-6-luna
reasoning: low
---

const [topic] = args;
let i = 0;
let result: string | null = null;

if (topic === 'color') {
    ---
    outputVar: =result

    What is your favorite color? Answer with one word.
    ---
}

while (i < 2) {
    ---
    mode: agent

    Increment the number @i by one ->[Int] @=i
    ---
}

success({ result, i });
```

* **Not an expression.** A block after `=`, inside a call or in any other expression position
  is an error: ``Blocks are statements: a `---` block cannot be used as an expression``.
* **A block awaits.** At the top level and in `async` functions this just works. In a function
  that is not `async`, `spl check` reports TypeScript's
  `'await' expressions are only allowed within async functions and at the top levels of modules.`
  and `spl run` stops with `invalid TypeScript: await isn't allowed in non-async function`.
* **Outputs are constants of the enclosing scope.** An output is declared as a `const` where
  the block stands and follows normal block scoping: an output of a block inside an `if` body
  is not visible after the `if`. Declaring a name that already exists is TypeScript's
  `Cannot redeclare block-scoped variable` error.
* **`=name` assigns instead.** Write `outputVar: =result` or `->[Int] @=i` to assign an existing
  `let`, as above. See [New or updated variables](LLM-commands.md#new-or-updated-variables).
* **Indentation is free.** The fences and the text of a nested block may be indented with the
  code around them; the indentation is not part of the instruction.

### How a file is compiled

The front scanner turns a `.spl` file into TypeScript. Code is copied as written, a Markdown
comment becomes blank lines, and each block becomes a call to the library on the lines it
occupied. Every construct stays on its original line, so diagnostics and stack traces point at
`.spl` lines without source maps.

The agent block of `basics.spl` becomes roughly this, on lines 25 to 33:

```ts
const { fact15, fib10, fibPlus2, modelFib10 } = await __spl.agent({ line: 25, reasoning: 'high', text: '...' })
    .in('factorial', factorial).out('fact15', Int)
    .in('fib', fib).out('fib10', Int)
    .out('fibPlus2', Int)
    .in('fib', fib).out('modelFib10', Int);
```

The joke block becomes:

```ts
const joke = await __spl.ask({ line: 37, enforce: ['Answer in Chinese'], forbid: ['Mentioning the word cat'],
    output: 'joke', text: 'A joke about programmers with a setup and a punchline.', outputType: Joke });
```

* **References and types are real TypeScript.** Each `@name` becomes `.in('name', name)` and
  each output type becomes an expression, at its position in the source. A reference to a name
  that does not exist is therefore TypeScript's `Cannot find name` error on its line, and an
  output has the TypeScript type of its `Type`.
* **File defaults are not repeated.** They are passed once to the function that wraps the file.
* **The pipeline is short:** scanner, TypeScript, Node.js `module.stripTypeScriptTypes` to erase
  the types, then execution as an ES module. `--debug` adds a stop before each top-level statement.

## The TypeScript dialect

Workflow code is TypeScript that Node.js can run by erasing the types.

* **Erasable syntax only.** Annotations, `interface`, `type`, `import type`, generics and
  `as` are removed without changing the code. Syntax that would have to produce code is rejected
  with a hint:

| Syntax | Error |
| --- | --- |
| `enum Color { ... }` | ``Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum`` |
| `namespace Name { ... }` | ``Unsupported TypeScript syntax: `namespace` cannot be erased; use an ES module or a plain object instead of namespace`` |
| `@decorator` | `Unsupported TypeScript syntax: decorators cannot be erased; call the decorator as a function instead` |
| `constructor(private x: number)` | `Unsupported TypeScript syntax: parameter properties cannot be erased; declare the field and assign it in the constructor` |

* **`spl run` does not type-check.** It strips the types and starts. A type error does not stop
  a run; a syntax error does, with exit code 2, before the first statement executes.
* **`spl check` type-checks** with the TypeScript compiler, using the scanner's TypeScript and
  the library's declarations. It is `strict`, with two relaxations for short scripts:
  `noImplicitAny` is off, so parameters may go without annotations, and `catch (error)` gives
  `error` the type `any`, so `error.reason` needs no cast. See [`spl check`](CLI.md#spl-check).
* **Module code.** The file runs in strict mode with top-level `await`, static `import`, dynamic
  `import()` and `import.meta`. `import.meta.url`, `.filename` and `.dirname` describe the
  `.spl` file. Top-level `return` is a syntax error; `require`, `module` and `__dirname` do not exist.
* **Normal scoping.** Variables are ordinary `const` and `let` bindings. Functions are hoisted,
  so code can call a function declared further down.
* **Node.js globals** such as `process`, `fetch`, `URL` and `structuredClone` are available.
  Prefer `log` over `console.log`: stdout is reserved for the result.
* **Your names shadow the library.** After `const log = 1`, the library's `log` is hidden in
  that scope. Avoid library names such as `args`, `env`, `log`, `t` and the type builders for
  your own variables.

## Await model calls and tools

`ask`, `agent`, `decision`, `human`, `codegen`, `restrict` and the tools return promises. Use `await`
whenever you need the result or the effect to have happened.

```ts
const report = await readFile('./report.txt');
const [title, summary] = await Promise.all([
    ask(`Suggest a title for: ${report}`, { len: 'sentence' }),
    ask(`Summarize: ${report}`, { len: 'paragraph' }),
]);
```

A call without `await` keeps running in the background: its result may arrive after the
workflow has ended, and its failure cannot be caught by the workflow and crashes the process.
With `--trace`, recorded calls run one at a time in call order, so `Promise.all` stays replayable.

Code runs as ordinary JavaScript on the main thread. A long synchronous loop blocks log
rendering, timers and Ctrl+C handling until it yields; give long loops an `await` point, or
move heavy work to a worker thread or child process.

## Imports and modules

Imports work as in any ES module: a relative specifier resolves from the file that contains
the import, not from the working directory.

| Import | Resolves to |
| --- | --- |
| `node:fs`, `node:path`, `node:child_process`, ... | The whole Node.js standard library |
| `./helper.js`, `../lib/util.mjs` | Your own modules, relative to the importing file |
| `./helper.ts` | TypeScript modules with erasable types |
| `./other.spl` | Another workflow, compiled when it is imported |
| `./data.json` with `with { type: 'json' }` | JSON modules |
| `lodash`, `@scope/pkg` | Packages in `node_modules`, found from the importing file upward |
| `await import(specifier)` | Any of the above, loaded on demand |

`imports/run.spl`

```spl
//*
# Import modules, Node.js built-ins and other workflows

Imports resolve from this file, as in any ES module. Another `.spl` file gives its exported
declarations by name and its workflow as the default export.

    spl run examples/imports/run.spl
*//

import os from 'node:os';
import { fib as f, factorial } from './functions.js';
import squares, { square } from './math.spl';

log(f(10));
log(factorial(10));
success({
    fib: f(10), factorial: factorial(10), square: square(7),
    squares: await squares(['2', '3']), platform: os.platform(),
});
```

A helper module is ordinary JavaScript or TypeScript. It imports the library explicitly, and
its calls take part in the running workflow: same model, restrictions, guidance, logs and trace.
`spl-lang` and `spl-lang/markdown` always resolve to the running copy of the package, so
helpers need no local install and share the workflow's runtime and `Failure` class.

`imports/functions.js`

```js
import { assert } from 'spl-lang';

export function fib(n) {
    assert(Number.isInteger(n) && n >= 0, 'fib needs a non-negative integer');
    return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

export function factorial(n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}
```

Modules are loaded natively by Node.js: they are cached for the lifetime of the process and
their source is not recorded in traces, so a replay imports them from disk again.

### What a .spl module exports

A `.spl` file is a module. Its default export is its workflow, and its `export`ed declarations
are its named exports.

`imports/math.spl`

```spl
//*
# A workflow that is also a module

Exported declarations live at module level, so other files can import them.
The rest of the file is the workflow: `await squares(['2', '3'])` runs it with those arguments.

    spl run examples/imports/math.spl --arg 2 --arg 3
*//

export function square(n: number): number {
    return n * n;
}

success(args.map(Number).map(square));
```

* **The default export is a function:** `workflow(args?, options?)`. Calling it runs the body
  of the file with those arguments. It resolves to the value given to `success()`, or to
  `undefined`, and a failure rejects with a [`Failure`](Safety.md#try--catch).
* **Importing does not run the workflow.** Only `import`s and `export`ed declarations are
  evaluated when the module loads. The rest of the file is the workflow body and runs on each call.
* **A called workflow shares the caller's runtime:** the `--model` override, restrictions,
  guidance, logs, trace and human input. It has its own `args` and its own file defaults.
  `success()` inside it ends only that call.
* **Exports live outside the workflow.** An exported declaration that uses a workflow variable
  is an error, for example:
  ``exported `double` uses the workflow variable `base`; exports live outside the workflow, so export `base` too or pass it as a parameter``.
  `export { base }` for a workflow variable and `export default` are errors as well.
* **A failure in another file names it.** The [failure payload](Safety.md#failure-payload) gets a
  `source` field with the path of the imported file.

[`spl check`](CLI.md#spl-check) follows `.spl` imports and checks those files too, and
[`spl compile`](CLI.md#spl-compile) writes a module for each of them.

## The library

A `.spl` file can use these names without importing them. Other modules import them from
`spl-lang`. The [API reference](Reference.md) lists every signature and option.

| Group | Names |
| --- | --- |
| Model calls | `ask` `agent` `decision` |
| People | `human` |
| Guidance and restrictions | `enforce` `forbid` `restrict` |
| Control | `success` `fail` `assert` `Failure` |
| Exact tools | `readFile` `writeFile` `webFetch` `webSearch` `shell` |
| Code generation | `codegen` |
| Inputs and logging | `args` `env` `log` |
| Types | `Str` `Int` `Float` `Bool` `Char` `Nil` `Any` `Dict` `Fn` `List` `Union` `Nullable` `Enum` `Struct` `Typedef` `JsonSchema` `validate` `t` |
| Markdown | `markdown` |

Model calls and guidance are described in [Natural language & models](LLM-commands.md);
restrictions, failures and human input in [Guards & failures](Safety.md).

## Types

A type is a value that describes data. It checks values, converts what a model sends into
JavaScript objects and renders the JSON Schema a model receives. Type names start with an
uppercase letter. Use one as `outputType` in an ask block, in `->[Type] @name` in an agent
block, as `schema` in `ask()`, or directly.

```ts
const Color = Enum('red', 'green', 'blue');
const Money = Typedef('Money', Int, { minimum: 0, desc: 'Amount in cents' });

const LineItem = Struct('LineItem', {
    description: Str,
    quantity: Int.annotate({ minimum: 1 }),
    unitPrice: Money,
    color: Nullable(Color),
});

const Invoice = Struct('Invoice', {
    vendor: Str.annotate({ minLength: 1 }),
    date: Str.describe('ISO date YYYY-MM-DD'),
    lines: List(LineItem),
    total: Money,
});

const invoice = Invoice.parse({
    vendor: 'Acme', date: '2026-01-31', total: 2500,
    lines: [{ description: 'Widget', quantity: 2, unitPrice: 1250, color: null }],
});
assert(Invoice.is(invoice) && !Invoice.is({ vendor: 'Acme' }));
log(Invoice.schema());
```

| Builder | Accepts |
| --- | --- |
| `Str` | Strings |
| `Int` | Safe integers (`Number.isSafeInteger`) |
| `Float` | Finite numbers, including integers |
| `Bool` | `true` or `false` |
| `Char` | Strings of exactly one Unicode character |
| `Nil` | `null` |
| `Any` | Any JSON value |
| `Dict` | Any plain object, without a declared shape |
| `Fn` | Functions; cannot be described as JSON |
| `List(T)` | Arrays whose items satisfy `T` |
| `Union(A, B, ...)` | Values satisfying any member |
| `Nullable(T)` | `T` or `null`; a nullable field must still be present |
| `Enum('a', 'b')` | One of the listed strings |
| `Struct(name, fields)` | Exact records: every field required, extra fields rejected |
| `Typedef(name, type, annotations?)` | The same values as `type`, under a name |
| `JsonSchema(schema, name?)` | Values valid against raw JSON Schema, constraints enforced |

Every type has the same methods:

| Method | Result |
| --- | --- |
| `Type.parse(value)` | The validated value, or a `validation_failed` failure such as `$.lines[0].quantity: expected Int, got 1.5` |
| `Type.coerce(value)` | The value converted to the type, or the same failure |
| `Type.parseJson(text)` | Like `parse`, from strict JSON text; malformed text is `invalid_format` |
| `Type.is(value)` | `true` or `false`, without throwing |
| `Type.schema()` | JSON Schema, with annotations in `description` |
| `validate(value, Type)` | Same as `Type.parse(value)`; with raw JSON Schema it checks and returns the value |

Types are immutable: `annotate`, `describe`, `as`, `nullable()`, `list()` and `or(other)` return
new types. `Struct('Point').field('x', Float, { desc: 'Horizontal' }).field('y', Float)` is the
fluent form of a struct. `t` holds every builder under one name, for code that prefers
`t.Str` and `t.List(t.Int)`.

### Parse and coerce

`parse` validates. It never converts, fills defaults or drops fields: `Int.parse('1')` fails,
and a missing nullable field is an error. It returns a copy for structs and lists.

`coerce` converts a value to the type first, then validates it. It is deterministic and never
calls a model.

| Target | `coerce` accepts in addition |
| --- | --- |
| Any type | A string that holds JSON, where the type expects an object, a list or any value: it is parsed first |
| `Int`, `Float` | Numeric strings. `Int` still requires an exact integer: `'3.0'` gives `3`, but `3.7` fails |
| `Bool` | `1` and `0`, and the strings `'true'`, `'false'`, `'1'` and `'0'` |
| `Str` | Any other JSON value, turned into JSON text: `Str.coerce(42)` is `'42'` |
| `Nil` | The string `'null'` |
| `Struct`, `List` | Fields and items are coerced recursively |
| `Union` | A value that already fits a member is kept as it is; conversion is the fallback |

`Enum` and `Char` values are not converted. A value that still does not fit throws
`validation_failed` with the path of the bad field:

```ts
const Reading = Struct('Reading', { sensor: Str, celsius: Float, ok: Bool });

const reading = Reading.coerce('{"sensor": 7, "celsius": "21.5", "ok": "true"}');
assert(reading.sensor === '7' && reading.celsius === 21.5 && reading.ok === true);

let problem = '';
try {
    Reading.coerce({ sensor: 'a', celsius: 'warm', ok: true });
} catch (error) {
    problem = error.reason;
}
assert(problem === '$.celsius: expected Float, got "warm"');
```

The runtime calls `coerce` wherever a model produces a typed value: the `outputType` of an ask
block, the `schema` of `ask()` and every output an agent saves. Asking the model to try again is
separate: see [`repairs`](LLM-commands.md#types-schemas-and-repairs).

Error paths start at `$`. When an agent saves an output, the output's name is the root instead:
`invoice.tax: expected Money, got 3312.5`. A type named with `Typedef` appears under its own
name, as `Money` does here.

### Annotations are advice

`.annotate({...})`, `.describe(text)` and the third argument of `Typedef` attach arbitrary
metadata for the model. `desc` or `description` becomes the schema description; every other key
is appended as `Model advice (not validation constraints): {"minimum":0}`. Annotations never
reject a value: `Money.parse(-1)` succeeds. Check business rules with `assert`, or use
`JsonSchema({ type: 'integer', minimum: 0 })` when a constraint must be enforced.

### Classes

`.methods({...})` gives parsed objects methods; `.class(Constructor)` makes them instances of an
existing class, using its static `fromJSON(data)` when present.

```ts
const Person = Struct('Person', { firstName: Str, age: Int }).methods({
    label() { return `${this.firstName} (${this.age})`; },
});
const person = Person.parse({ firstName: 'Ada', age: 36 });
log(person.label());                    // Ada (36)

class Point {
    x: number;
    y: number;
    constructor(x: number, y: number) { this.x = x; this.y = y; }
    static fromJSON(data: Record<string, unknown>) { return new Point(Number(data.x), Number(data.y)); }
    norm() { return Math.hypot(this.x, this.y); }
}
const PointType = Struct('Point', { x: Float, y: Float }).class(Point);
log(PointType.parse({ x: 3, y: 4 }).norm());    // 5
```

For a class type, `is` requires an instance, `parse` and `coerce` accept plain data or an
existing instance, and `Person.data` is the plain-struct view with the same fields. Instances
serialize like plain objects with `JSON.stringify`.

### TypeScript types

`Infer` gives the TypeScript type a builder stands for. It is a global in `.spl` files; other
modules import it from `spl-lang`. Blocks and model calls are typed by their types, so
`invoice` below is known to have a numeric `total`.

```spl
const Invoice = Struct('Invoice', { vendor: Str, total: Int });
type Invoice = Infer<typeof Invoice>;

function describe(invoice: Invoice): string {
    return `${invoice.vendor}: ${invoice.total}`;
}

---
outputVar: invoice
outputType: Invoice

Extract the invoice: Acme, 25.00 EUR. The total is in cents.
---

log(describe(invoice));
```

## Markdown builder

`markdown` builds Markdown text without string concatenation. Every method returns the document,
so calls chain; `toString()` returns the result.

```ts
const doc = markdown.document()
    .heading('Build report', 1)
    .paragraph(`${markdown.bold('Results')} from ${markdown.link('CI', 'https://example.com/build')}`)
    .bulletList(['parser', 'runtime'].map(name => `${markdown.escape(name)}: passed`))
    .codeBlock('spl check workflow.spl', 'bash')
    .table(['Suite', 'Status'], [['parser', 'passed'], ['runtime', 'passed']]);
success(doc.toString());
```

| Method | Output |
| --- | --- |
| `heading(text, level = 1)` | Heading with level `1` through `6` |
| `paragraph(text)` | Paragraph containing inline Markdown |
| `bulletList(items)` | Bullet list of strings; multiline items are indented |
| `orderedList(items, start = 1)` | Numbered list |
| `quote(text)` | Blockquote, including multiline text |
| `codeBlock(text, language = '')` | Fenced code block; the fence grows to fit backticks in the text |
| `table(headers, rows)` | GFM table; rows must match the header width |
| `thematicBreak()` | Horizontal rule |
| `raw(text)` | Markdown as written |
| `toString()` | Blocks joined with blank lines and a final newline; `''` for an empty document |

Inline helpers return strings: `markdown.bold(text)`, `italic(text)`, `code(text)`,
`link(label, url)`, `image(alt, url)` and `escape(text)`. Block methods accept Markdown, so use
`escape` for literal dynamic text. Link labels and image alt text are escaped automatically, and
table cells escape `|`. Invalid input, such as a heading level of 7 or a multiline heading,
raises `assertion_failed`. Other modules import the builder from `spl-lang/markdown`;
`new markdown.Document()` is equivalent to `markdown.document()`.

## Inputs: args and env

`args` is the read-only list of `--arg` values. `env` is the read-only process environment.
Missing entries are `undefined`.

```ts
const [target = 'world', mode] = args;
const home = env.HOME ?? env.USERPROFILE;
log(`Hello ${target}`, { mode, home });
```

With `--trace`, the first use of `env` records the environment so that replay sees the same
values; `process.env` is not recorded. In a block, `@args` and `@env.NAME` are
[references](LLM-commands.md#references) to the same values.

## Logging

`log(...values)` writes to the run log on stderr at info level; `log.error(...)` and
`log.debug(...)` select other levels. Debug output appears only with `--log-level debug`, and
`--silent` hides all logs. Objects and arrays are logged as indented JSON:

```text
[info] log: review:
{
  "findings": [],
  "count": 0
}
```

See [Output and exit codes](CLI.md#output-and-exit-codes).

## Exact tools

Tools are ordinary async functions that never call a model. Paths are relative to the working
directory, and every call is checked against active [restrictions](Safety.md#restrictions).

| Function | Result |
| --- | --- |
| `await readFile(path)` | File contents as UTF-8 text |
| `await writeFile(path, content)` | Writes the file, creating parent folders, and returns a confirmation |
| `await webFetch(url)` | Response body as text (30 s timeout, up to 5 redirects) |
| `await webSearch(query)` | Search results as text |
| `await shell(command)` | Combined stdout/stderr; a nonzero exit raises `tool_error` (120 s timeout) |

```ts
const diff = await restrict({ exec: 'git' }, () => shell('git diff --cached'));
```

`shell` runs through the platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere).
Agents see the same tools under the same names.

## Errors

Library failures are `Failure` objects: `error.statusCode` (also `error.status_code`) and
`error.reason` say what happened. Catch them with `try`/`catch` and rethrow anything else.

```ts
let notes = '';
try {
    notes = await readFile('./optional-notes.txt');
} catch (error) {
    if (!(error instanceof Failure)) throw error;
    log(`${error.statusCode}: ${error.reason}`);
}
```

Any other uncaught exception, such as a `TypeError` in your code or an error thrown by an
imported module, ends the workflow as a `runtime_error` whose reason is `Name: message` and
whose `line` is the line that threw. `success(value)` ends the run by throwing a signal that is
not an `Error`; a catch-all must rethrow it. See [Guards & failures](Safety.md#try--catch).

## What the runtime does not see

The runtime records, replays and restricts **library calls**. Code that reaches the outside
world directly is your own responsibility:

| | Library (`readFile`, `shell`, `webFetch`, `agent`, blocks, MCP) | Node.js APIs (`node:fs`, `fetch`, `child_process`) |
| --- | --- | --- |
| Checked by `restrict` | Yes | No |
| Recorded by `--trace` | Yes | No |
| On replay | Recorded result is returned | Runs again |

Values from `Date.now()`, `Math.random()` or a direct file read can differ between a recording
and its replay. If such a value reaches a prompt or a tool argument, the replayed request no
longer matches the recording and the run stops with a mismatch. Use the library tools for
anything a replay must reproduce.

Imported modules are in the same position: they are loaded from disk again on every replay, so
a trace of a workflow that imports local files depends on those files staying as they were.

## The library in Node.js programs

Outside a `.spl` file, the library is a regular package. Calls use a default runtime: provider
keys from the environment or `spl login`, info-level logs on stderr (override with
`SPL_LOG_LEVEL`), the process working directory and stdin for `human`.

```ts
import { ask, configure, Enum, restrict, Str, Struct, writeFile } from 'spl-lang';

const runtime = configure({ model: 'gpt-6-luna', logLevel: 'error' });

const Triage = Struct('Triage', { label: Enum('bug', 'feature', 'question'), reason: Str });
const triage = await ask('Classify: the export button does nothing', { schema: Triage, repairs: 1 });
await restrict('./out', () => writeFile('./out/triage.json', JSON.stringify(triage)));

await runtime.backend.close();
```

`configure(options)` is optional and replaces the default runtime. Options: `model`, `provider`,
`cwd`, `args`, `logLevel` (`silent`, `error`, `info`, `debug`), `logger`, `backend`, `timeoutMs`,
`mcpServers`, `trace` and `human`. Running whole workflows from a program is described under
[Embedding](CLI.md#embedding).
