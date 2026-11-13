# Workflow code

Workflow code is native JavaScript running on Node.js, with the `spl-lang` library already in
scope. This page covers what is specific to workflows: fences, the shared scope, imports, the
library, types, the Markdown builder, inputs, logging, tools and errors. Workflows are shown as
Markdown; a [.spl file](#dedicated-spl-files) holds the same steps as blocks.

## Fences

A fence whose language is `js`, `javascript` or `mjs` runs as JavaScript. A `ts`, `typescript` or
`mts` fence runs the same way after its type annotations are erased.

```js
const numbers = [3, 1, 2];
const sorted = numbers.toSorted((a, b) => a - b);
log(sorted);
```

* **Module-style code.** Fences run in strict mode with top-level `await`, static `import`,
  dynamic `import()` and `import.meta`. `import.meta.url`, `.filename` and `.dirname` describe
  the workflow file, even though imports and relative tool paths resolve against the working
  directory.
  Top-level `return` is a syntax error; `require`, `module` and `__dirname` do not exist.
  There is nothing to export: `export default` and `export { ... }` are syntax errors.
* **Node.js globals** such as `process`, `fetch`, `URL` and `structuredClone` are available.
  Prefer `log` over `console.log`: stdout is reserved for the result.
* **Everything is compiled first.** A syntax error in any fence, or in a blockquote's `@CTL`
  settings, stops the run with exit code 2 before the first step executes.
* **Type erasure only.** `ts` fences accept syntax that can be removed without changing the
  code: annotations, `interface`, `type`, `import type`. Enums, namespaces and parameter
  properties are syntax errors. Types are not checked at run time; the
  [VS Code extension](../vscode/README.md) reports type errors while you edit.
* **Skipping a fence.** Add `ignore` or `no-run` after the language to show code without running
  it. Fences in other languages are commentary.
* **Results.** The CLI prints only the value passed to [`success`](Safety.md#assertions-fail-and-success).
  The value of a fence's last expression is shown by notebooks and
  [interactive sessions](CLI.md#interactive-sessions), not by the CLI.

## Dedicated .spl files

The same workflow can be written without Markdown, as a `.spl` file made of blocks. A block opens
with a tag on its own line and ends with the matching closing tag on its own line.

`code-review.spl`

````spl
---
model: 'gpt-6-luna'
---

{comment}

An agent picks and reviews three files inside `./src`,
a second step turns its notes into typed findings,
and plain code decides whether the run fails.

{/comment}


{agent restrict={fs: ['./src'],
       exec: ['git']},
       forbid='suggesting purely stylistic changes'}

List source files with `git ls-files src`.
Then read the 3 files that are most likely
to contain security problems or correctness bugs,
and review only those. List each finding with its location,
why it matters and a suggested fix. Save to @notes

{/agent}

{js}

const Severity = enumOf('low', 'medium', 'high');

const Item = struct('Item', {
    severity: Severity,
    title: str,
    location: str.annotate({ desc: 'File path and line' }),
    fix: str,
});

const Review = struct('Review', { findings: list(Item) });

{/js}

{agent}
Convert @notes into structured finding @validate[Review] save to @review
{/agent}

{js}
const groups = Object.groupBy(review.findings, finding => finding.severity);
const high = groups.high ?? [];
{/js}

{agent restrict={fs: ['./reports']}, model='gpt-6.1-sol'}

Convert @groups to a Markdown report and write it to './reports/review.md'

{/agent}

{js}
if (high.length > 0)
    fail(`${high.length} high severity finding(s), see ./reports/review.md`);
success(review.findings.map(
    finding => `${finding.severity}: ${finding.title} (${finding.location})`)
        .join('\n'));
{/js}
````

| Block | In Markdown |
| --- | --- |
| `{js}` ... `{/js}` | A `js` fence |
| `{ts}` ... `{/ts}` | A `ts` fence |
| `{js ignore}`, `{ts no-run}` | A fence marked `ignore` or `no-run`: shown, not run |
| `{agent}` ... `{/agent}` | A blockquote: an [agent command](LLM-commands.md#blockquotes) |
| `{agent restrict={fs: ['./src']}, model='m'}` | A blockquote that opens with [`@CTL(...)`](LLM-commands.md#controls): the same literal settings, written in the tag |
| `{codegen}` ... `{/codegen}` | `@CODEGEN`: the body is the literal description of the [functions to generate](LLM-commands.md#code-generation) |
| `{comment}` ... `{/comment}` | Headings and prose: commentary that never runs |
| `{lock}` ... `{/lock}` | The journal of a [pinned workflow](CLI.md#pinned-workflows) |

* **Same runtime.** Blocks run in document order in one shared scope, with the same library,
  prompts, guards, traces and pins as a Markdown workflow. Everything else in this
  documentation applies unchanged; read "fence" as `{js}` block and "blockquote" as `{agent}` block.
* **Frontmatter is optional.** The file type identifies the workflow, so `extension` and
  `version` are not needed. `model` and `preamble` work as in Markdown.
* **Tags stand alone.** An opening or closing tag takes a whole line and may be indented. A
  closing tag inside a line, for example in a string, is ordinary text, and a block ends only
  with its own closing tag. Tag names are lowercase.
* **Settings live in the tag.** `{agent ...}` and `{codegen ...}` take `restrict`, `enforce`,
  `forbid`, `model` and `reasoning`, separated by commas and written as in `@CTL(...)`. The tag
  may continue over several lines. `@CTL` and `@CODEGEN` markers are errors in a `.spl` file.
* **Everything is in a block.** Text between blocks is a syntax error, which catches a
  mistyped tag; write commentary in `{comment}`. Blocks do not nest, so a `{comment}` can show
  other tags as text.
* **Instructions are plain text.** Common indentation and blank lines around the text of an
  `{agent}` or `{codegen}` block are removed. `@name` references and `@validate[Type]` work as
  in blockquotes.
* **Running.** `spl workflow.spl` accepts every option of the [CLI](CLI.md); `--pin` writes
  `workflow.locked.spl` with the journal in a `{lock}` block.
* **Editing.** The [VS Code extension](../vscode/README.md) colors the whole file and gives
  `{js}` and `{ts}` blocks the JavaScript features of fences, `{agent}` blocks `@name`
  completion and tags completion of their settings.

## One shared scope

All fences and blockquotes of a document share one top-level scope.

````markdown
---
extension: semantic-prompt-language
version: 1
---

```js
const limit = 3;
let seen = [];

function remember(item) {
    seen.push(item);
    return seen.length;
}
```

> Call @remember with the name of each primary color, then save the number of colors to @count

```js
assert(count === limit, `expected ${limit} colors, got ${count}`);
success(`${count} colors: ${seen.join(', ')}`);
```
````

* **Top-level declarations are shared.** `const`, `let`, `var`, `function`, `class` and imported
  names declared at the top level of a fence are visible in every later fence and to blockquote agents.
* **Agents use the same bindings.** A blockquote can load a variable, call a function and save
  a value; a variable saved by an agent is a plain identifier in later fences.
* **Bindings are live.** A function declared in one fence sees later changes to shared variables,
  including changes made by an agent.
* **`const` is not enforced at the top level.** As in a REPL, a top-level `const` can be assigned
  again, and declaring an existing name in a later fence rebinds it. Inside functions and blocks,
  `const` and `let` behave as usual.
* **No temporal dead zone at the top level.** Reading a top-level name before its declaration
  runs yields `undefined`, or the value left by an earlier fence. Assigning to a name that was
  never declared is a `ReferenceError`.
* **Functions are hoisted** within their fence, so a fence can call a function declared further down.
* **Imports are read-only.** As in an ES module, named, default and namespace imports are live
  bindings of their module, and assigning to one is a `TypeError`. A later fence may declare
  the name again, which replaces the import.
* **Nested declarations stay local.** Names declared inside functions, blocks and loops are not shared.
* **Your names shadow the library.** After `const list = [1, 2]`, the library's `list` type
  builder is hidden from later fences. Avoid short library names such as `list`, `object`, `any`,
  `str`, `int`, `t`, `fn`, `env`, `args` and `log` for your own variables.

## Await model calls and tools

`ask`, `think`, `agent`, `human`, `codegen`, `restrict` and the tools return promises. Use `await`
whenever you need the result or the effect to have happened.

```js
const report = await readFile('./report.txt');
const [title, summary] = await Promise.all([
    ask(`Suggest a title for: ${report}`, { len: 'sentence' }),
    ask(`Summarize: ${report}`, { len: 'paragraph' }),
]);
```

A call without `await` keeps running in the background: its result may arrive after the document
has ended, and its failure cannot be caught by the workflow and crashes the process. With `--trace`
or `--pin`, recorded calls run one at a time in call order, so `Promise.all` stays replayable.

Fences run as ordinary JavaScript on the main thread. A long synchronous loop blocks log
rendering, timers and Ctrl+C handling until it yields; give long loops an `await` point, or
move heavy work to a worker thread or child process.

## Imports

Imports work as in any ES module, with one rule: **specifiers resolve against the working
directory** (`--cwd`, by default the folder where `spl` runs), not the folder of the workflow file.

```js
import path from 'node:path';
import { createHash } from 'node:crypto';
import { double, title } from './lib/helpers.js';

log(path.basename(import.meta.filename), double(21));
log(createHash('sha256').update('spl').digest('hex').slice(0, 8));
```

| Import | Resolves to |
| --- | --- |
| `node:fs`, `node:path`, `node:child_process`, ... | The whole Node.js standard library |
| `./helper.js`, `../lib/util.mjs`, `./legacy.cjs` | Your own modules, relative to the working directory |
| `./helper.ts` | TypeScript modules with erasable types |
| `./data.json` with `with { type: 'json' }` | JSON modules |
| `lodash`, `@scope/pkg` | Packages in the working directory's `node_modules` |
| `await import(specifier)` | Any of the above, loaded on demand |

Imported names join the shared scope, so later fences and blockquote agents can use them. To load a module that sits beside
the workflow regardless of the working directory, build the path from `import.meta`:
`await import(new URL('./helper.js', import.meta.url).href)`.

A helper module is ordinary JavaScript. It imports the library explicitly, and its calls take
part in the running workflow: same model, restrictions, guidance, logs and trace.
`spl-lang` and `spl-lang/markdown` always resolve to the running copy of the package, in fences
and in helper modules, on the CLI and in VS Code notebooks. Helpers therefore need no local
install and share the workflow's runtime and `Failure` class. Node.js loads
it by its usual rules; to mark a helper as an ES module without relying on syntax detection,
name it `.mjs` or set `"type": "module"` in the nearest `package.json`.

`lib/helpers.js`

```js
import { ask, assert } from 'spl-lang';

export function double(value) {
    assert(typeof value === 'number', 'double needs a number');
    return value * 2;
}

export async function title(text) {
    return ask(`Suggest a title for: ${text}`, { len: 'sentence' });
}
```

`--check` verifies that static relative `import` declarations point at existing files; dynamic
`import('./x.js')` calls are not checked. Modules are loaded natively by Node.js: they are
cached for the lifetime of the process and their source is not recorded in traces or pins, so
a replay imports them from disk again. [imports/run.md](../lang/examples/imports/run.md) is a
runnable example.

## The library

Every fence can use these names without importing them. Outside a workflow, import them from
`spl-lang`. [API reference](Reference.md) lists every signature and option.

| Group | Names |
| --- | --- |
| Model calls | `ask` `think` `agent` |
| People | `human` |
| Guidance and restrictions | `enforce` `forbid` `restrict` |
| Control | `success` `fail` `assert` `Failure` |
| Exact tools | `readFile` `writeFile` `webFetch` `webSearch` `shell` |
| Code generation | `codegen` |
| Inputs and logging | `args` `env` `log` |
| Types | `str` `int` `float` `bool` `char` `nil` `any` `object` `fn` `list` `union` `nullable` `enumOf` `struct` `typedef` `jsonSchema` `validate` `t` |
| Markdown | `markdown` |

Model calls and guidance are described in [Natural language & models](LLM-commands.md);
restrictions, failures and human input in [Guards & failures](Safety.md).

## Types

A type is a JavaScript value that describes data. It validates values, turns JSON into JavaScript
objects and renders the JSON Schema a model receives. Pass one as `schema` to a model call, name
it in a blockquote with `@validate[Type]`, or use it directly.

```js
const Color = enumOf('red', 'green', 'blue');
const Money = typedef('Money', int, { minimum: 0, desc: 'Amount in cents' });

const LineItem = struct('LineItem', {
    description: str,
    quantity: int.annotate({ minimum: 1 }),
    unitPrice: Money,
});

const Invoice = struct('Invoice', {
    vendor: str.annotate({ minLength: 1 }),
    date: str.describe('ISO date YYYY-MM-DD'),
    note: nullable(str),
    lines: list(LineItem),
    total: Money,
});

const invoice = Invoice.parse({
    vendor: 'Acme', date: '2026-01-31', note: null, total: 2500,
    lines: [{ description: 'Widget', quantity: 2, unitPrice: 1250 }],
});
assert(Invoice.is(invoice) && !Invoice.is({ vendor: 'Acme' }));
log(Invoice.schema());
```

| Builder | Accepts |
| --- | --- |
| `str` | Strings |
| `int` | Safe integers (`Number.isSafeInteger`) |
| `float` | Finite numbers, including integers |
| `bool` | `true` or `false` |
| `char` | Strings of exactly one Unicode character |
| `nil` | `null` |
| `any` | Any JSON value |
| `object` | Any plain object, without a declared shape |
| `fn` | Functions; cannot be described as JSON |
| `list(T)` | Arrays whose items satisfy `T` |
| `union(A, B, ...)` | Values satisfying any member |
| `nullable(T)` | `T` or `null`; a nullable field must still be present |
| `enumOf('a', 'b')` | One of the listed strings |
| `struct(name, fields)` | Exact records: every field required, extra fields rejected |
| `typedef(name, type, annotations?)` | The same values as `type`, under a name |
| `jsonSchema(schema, name?)` | Values valid against raw JSON Schema, constraints enforced |

Every type has the same methods:

| Method | Result |
| --- | --- |
| `Type.parse(value)` | The validated value, or a `validation_failed` failure such as `$.lines[0].quantity: expected int, got 1.5` |
| `Type.parseJson(text)` | Like `parse`, from strict JSON text; malformed text is `invalid_format` |
| `Type.is(value)` | `true` or `false`, without throwing |
| `Type.schema()` | JSON Schema, with annotations in `description` |
| `validate(value, Type)` | Same as `Type.parse(value)`; with raw JSON Schema it checks and returns the value |

Parsing never coerces, fills defaults or drops fields: `int.parse('1')` fails, and a missing
nullable field is an error. `parse` returns a copy for structs and lists.

Error paths start at `$` for `Type.parse`. When an agent saves a variable through a schema, the
variable name is the root instead: `invoice.tax: expected Money, got 3312.5`. A type named
with `typedef` appears under its own name, as `Money` does here.

### Annotations are advice

`.annotate({...})`, `.describe(text)` and the third argument of `typedef` attach arbitrary
metadata for the model. `desc` or `description` becomes the schema description; every other key
is appended as `Model advice (not validation constraints): {"minimum":0}`. Annotations never
reject a value: `Money.parse(-1)` succeeds. Check business rules with `assert`, or use
`jsonSchema({ type: 'integer', minimum: 0 })` when a constraint must be enforced.

Types are immutable: `annotate`, `describe`, `as`, `nullable()`, `list()` and `or(other)` return
new types. `struct('Point').field('x', float, { desc: 'Horizontal' }).field('y', float)` is the
fluent form of a struct.

### Classes

`.methods({...})` gives parsed objects methods; `.class(Constructor)` makes them instances of an
existing class, using its static `fromJSON(data)` when present.

```js
const Person = struct('Person', { firstName: str, age: int }).methods({
    label() { return `${this.firstName} (${this.age})`; },
});
const person = Person.parse({ firstName: 'Ada', age: 36 });
log(person.label());                    // Ada (36)

class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    static fromJSON(data) { return new Point(data.x, data.y); }
    norm() { return Math.hypot(this.x, this.y); }
}
const PointType = struct('Point', { x: float, y: float }).class(Point);
log(PointType.parse({ x: 3, y: 4 }).norm());    // 5
```

For a class type, `is` requires an instance, `parse` accepts plain data or an existing instance,
and `Person.data` is the plain-struct view with the same fields. Instances serialize like plain
objects with `JSON.stringify`.

### TypeScript

In a `ts` fence, `Infer` gives the JavaScript type a builder parses to. Model calls are typed by
their options, so `invoice` below is known to have a numeric `total`.

```ts
import type { Infer } from 'spl-lang';

const Invoice = struct('Invoice', { vendor: str, total: int });
type Invoice = Infer<typeof Invoice>;

function describe(invoice: Invoice): string {
    return `${invoice.vendor}: ${invoice.total}`;
}

const invoice = await ask('Extract the invoice: Acme, 25.00 EUR', { schema: Invoice });
log(describe(invoice));
```

[TYPES.md](../TYPES.md) records the full contract of the type builder.

## Markdown builder

`markdown` builds Markdown text without string concatenation. Every method returns the document,
so calls chain; `toString()` returns the result.

```js
const doc = markdown.document()
    .heading('Build report', 1)
    .paragraph(`${markdown.bold('Results')} from ${markdown.link('CI', 'https://example.com/build')}`)
    .bulletList(['parser', 'runtime'].map(name => `${markdown.escape(name)}: passed`))
    .codeBlock('spl workflow.md --check', 'bash')
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

```js
const [target = 'world', mode] = args;
const home = env.HOME ?? env.USERPROFILE;
log(`Hello ${target}`, { mode, home });
```

With `--trace` or `--pin`, the first use of `env` records the environment so that replay sees
the same values; `process.env` is not recorded. Blockquote agents read `@args` and one
environment variable at a time with `@env.NAME`.

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

See [console formatting](CLI.md#output-and-exit-codes).

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

```js
const diff = await restrict({ exec: 'git' }, () => shell('git diff --cached'));
```

`shell` runs through the platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere).
Agents see the same tools under the names `read_file`, `write_file`, `web_fetch`, `web_search`
and `shell`.

## Errors

Library failures are `Failure` objects: `error.statusCode` (also `error.status_code`) and
`error.reason` say what happened. Catch them with `try`/`catch` and rethrow anything else.

```js
let notes = '';
try {
    notes = await readFile('./optional-notes.txt');
} catch (error) {
    if (!(error instanceof Failure)) throw error;
    log(`${error.statusCode}: ${error.reason}`);
}
```

Any other uncaught exception, such as a `TypeError` in your code or an error thrown by an
imported module, ends the document as a `runtime_error` whose reason is `Name: message` and
whose `line` is the document line that threw. `success(value)` ends the run by throwing a
signal that is not an `Error`; a catch-all must rethrow it. See
[Guards & failures](Safety.md#try--catch).

## What the runtime does not see

The runtime records, replays and restricts **library calls**. Code that reaches the outside
world directly is your own responsibility:

| | Library (`readFile`, `shell`, `webFetch`, `agent`, MCP) | Node.js APIs (`node:fs`, `fetch`, `child_process`) |
| --- | --- | --- |
| Checked by `restrict` | Yes | No |
| Recorded by `--trace` and `--pin` | Yes | No |
| On replay | Recorded result is returned | Runs again |

Values from `Date.now()`, `Math.random()` or a direct file read can differ between a recording
and its replay. If such a value reaches a prompt or a tool argument, the replayed request no
longer matches the recording and the run stops with a mismatch. Use the library tools for
anything a replay must reproduce.

Helper modules are in the same position: they are imported from disk again on every replay, so
a trace or a locked workflow that imports local helpers depends on those files staying as they were.

## The library in Node.js programs

Outside Markdown, the library is a regular package. Calls use a default runtime: provider keys
from the environment or `spl login`, info-level logs on stderr (override with `SPL_LOG_LEVEL`),
the process working directory and stdin for `human`.

```js
import { ask, configure, enumOf, restrict, str, struct, writeFile } from 'spl-lang';

const runtime = configure({ model: 'gpt-6-luna', logLevel: 'error' });

const Triage = struct('Triage', { label: enumOf('bug', 'feature', 'question'), reason: str });
const triage = await ask('Classify: the export button does nothing', { schema: Triage, repairs: 1 });
await restrict('./out', () => writeFile('./out/triage.json', JSON.stringify(triage)));

await runtime.backend.close();
```

`configure(options)` is optional and replaces the default runtime. Options: `model`, `provider`,
`cwd`, `args`, `logLevel` (`silent`, `error`, `info`, `debug`), `logger`, `backend`, `timeoutMs`,
`mcpServers`, `trace` and `human`. Running whole documents from a program is described under
[Embedding](CLI.md#embedding).
