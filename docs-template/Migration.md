# Migrating from 1.x

SPL 2.0 removes the custom SPL language. Workflow code is now native JavaScript in `js` fences,
and everything the language had as syntax is a function of the `spl-lang` library. This guide
maps every 1.x construct to its replacement and lists the behavior that changed.

Migration is manual: there is no compatibility mode and no converter. A `spl` fence is a syntax
error that points here. Blockquotes, frontmatter, CLI options, traces, pins, MCP configuration
and logging work as before; recorded traces and locked workflows must be recreated because
their source changed.

## Before and after

SPL 1.x:

```text
enum Label = 'bug' | 'feature' | 'question'
struct Triage:
    label: Label
    reason: str [desc='One-sentence explanation']

let issue = read_file($args[0])
let triage: Triage = ask(schema=Triage, repairs=2) 'Classify: {issue}'
assert len(triage.reason) > 0 'a reason is required'

restrict './out':
    write_file('./out/triage.json', json_stringify(triage, 2))
success triage
```

SPL 2.0:

```js
const Label = enumOf('bug', 'feature', 'question');
const Triage = struct('Triage', {
    label: Label,
    reason: str.annotate({ desc: 'One-sentence explanation' }),
});

const issue = await readFile(args[0]);
const triage = await ask(`Classify: ${issue}`, { schema: Triage, repairs: 2 });
assert(triage.reason.length > 0, 'a reason is required');

await restrict('./out', () => writeFile('./out/triage.json', JSON.stringify(triage, null, 2)));
success(triage);
```

## Documents and modules

| SPL 1.x | SPL 2.0 |
| --- | --- |
| ` ```spl ` fence | ` ```js ` fence, or ` ```ts ` with erasable types |
| `helpers.spl` module, every top-level name exported | `helpers.js` ES module with explicit `export` |
| `import { double } from './helpers.spl'`, relative to the importing file | `import { double } from './helpers.js'`, relative to the working directory |
| `import * as markdown from 'markdown'` | Nothing: `markdown` is a global (`spl-lang/markdown` in modules) |
| No access to the host platform | `import fs from 'node:fs'` and any package in `node_modules` |
| Top-level `return` ends the document | `success(value)`; top-level `return` is a syntax error |
| `<workflow>.<function>.spl` codegen cache with a `# @CODEGEN sha256:` header | `<workflow>.<function>.js` with a `// @CODEGEN sha256:` header; old caches are ignored |

## Statements

| SPL 1.x | SPL 2.0 |
| --- | --- |
| `let x = 1` | `const x = 1;` or `let x = 1;` |
| `let x: int = 1` | `const x = 1;` (`const x: number = 1;` in a `ts` fence); validate with `int.parse(x)` |
| `def add(a, b):` with `return a + b` | `function add(a, b) { return a + b; }` |
| `lambda x: x * 2` | `x => x * 2` |
| `if` / `elif` / `else` with colon blocks | `if (...) { } else if (...) { } else { }` |
| `for item in items:` | `for (const item of items) { }` |
| `for i in range(3):` | `for (let i = 0; i < 3; i++) { }` |
| `for key, value in items(d):` | `for (const [key, value] of Object.entries(d)) { }` |
| `while cond:`, `break`, `continue` | `while (cond) { }`, `break`, `continue` |
| `pass` | An empty block `{ }` |
| `try:` / `except err:` | `try { } catch (error) { }` |
| `# comment` | `// comment` |
| Block and `if` expressions (`let x = :`) | A conditional expression `c ? a : b`, or a function |

## Values and expressions

| SPL 1.x | SPL 2.0 |
| --- | --- |
| `True`, `False`, `None` | `true`, `false`, `null` (absent values are `undefined`) |
| `and`, `or`, `not` | `&&`, `\|\|`, `!` |
| `a == b` on lists and dictionaries | `===` compares identity; use `isDeepStrictEqual` from `node:util` |
| `a if cond else b` | `cond ? a : b` |
| `a // b` | `Math.floor(a / b)` |
| `x in xs`, `x not in xs` | `xs.includes(x)`, `!xs.includes(x)` |
| `'Hello {name}'` | `` `Hello ${name}` ``; braces in ordinary strings are literal |
| `'Use {{name}}'`, `r'C:\temp'` | `'Use {name}'`, `String.raw` with a template literal |
| `'''multiline'''` | A template literal |
| `object:` block, `object()` | `{ key: value }`, `{}` |
| `len(x)` | `x.length` |
| `xs.append(x)`, `xs[1:4]`, `xs[::-1]` | `xs.push(x)`, `xs.slice(1, 4)`, `xs.toReversed()` |
| `range(n)`, `sum(xs)`, `sorted(xs)` | `Array.from({ length: n }, (_, i) => i)`, `xs.reduce((a, b) => a + b, 0)`, `xs.toSorted()` |
| `keys(d)`, `values(d)`, `items(d)` | `Object.keys(d)`, `Object.values(d)`, `Object.entries(d)` |
| `text.upper()`, `text.strip()`, `text.startswith(p)` | `text.toUpperCase()`, `text.trim()`, `text.startsWith(p)` |
| `', '.join(xs)`, `text.splitlines()` | `xs.join(', ')`, `text.split(/\r?\n/)` |
| `str(x)`, `int(x)`, `float(x)`, `bool(x)` | `String(x)`, `Number(x)`, `Number(x)`, `Boolean(x)` |
| `json_parse(text)`, `json_stringify(value, 2)` | `JSON.parse(text)`, `JSON.stringify(value, null, 2)` |
| `type(x)`, `isinstance(x, T)` | `typeof x`, `T.is(x)` |

## Library calls

| SPL 1.x | SPL 2.0 |
| --- | --- |
| `ask 'Summarize {notes}'` | `` await ask(`Summarize ${notes}`) `` |
| `ask(fmt='integer', repairs=1) 'Rate {x}'` | `` await ask(`Rate ${x}`, { fmt: 'integer', repairs: 1 }) `` |
| `think(reasoning='high') 'Plan'` | `await think('Plan', { reasoning: 'high' })` |
| `agent 'Run the tests'` | `await agent('Run the tests')` |
| Modifiers `hide=True`, `top_p=0.1` | Options `hide: true`, `topP: 0.1` |
| `human 'Approve?'` | `await human('Approve?')` |
| `enforce 'Be brief':` block | `enforce('Be brief', () => ...)` |
| `forbid 'jokes':` block | `forbid('jokes', () => ...)` |
| `restrict './out':` block | `await restrict('./out', () => ...)` |
| `restrict fs './src', exec 'git':` block | `await restrict({ fs: './src', exec: 'git' }, () => ...)` |
| `success value`, `fail 'reason'` | `success(value)`, `fail('reason')` |
| `assert cond 'message'` | `assert(cond, 'message')` |
| `read_file(p)`, `write_file(p, text)` | `await readFile(p)`, `await writeFile(p, text)` |
| `web_fetch(url)`, `web_search(q)`, `shell(cmd)` | `await webFetch(url)`, `await webSearch(q)`, `await shell(cmd)` |
| `$args[0]`, `$env.NAME` | `args[0]`, `env.NAME` |
| `log(level='debug')(value)` | `log.debug(value)` |
| `except err:` with `err.status_code`, `err.reason` | `catch (error)` with `error.statusCode` or `error.status_code`, `error.reason` |

## Types

| SPL 1.x | SPL 2.0 |
| --- | --- |
| `enum Color = 'red' \| 'green'` | `const Color = enumOf('red', 'green');` |
| `struct Card:` with `term: str [desc='Name']` | `const Card = struct('Card', { term: str.annotate({ desc: 'Name' }) });` |
| `type Money = int [minimum=0]` | `const Money = typedef('Money', int, { minimum: 0 });` |
| `list[T]`, `A \| B`, `T \| None` | `list(T)`, `union(A, B)`, `nullable(T)` |
| `fn(str, int) -> str` | `fn`: any callable, without a signature |
| `class Person:` with methods, `hydratable class` | `struct('Person', { ... }).methods({ ... })` or `.class(Person)` |
| `struct(Person)` | `Person.data` |
| `validate(data, T)` | `validate(data, T)` or `T.parse(data)` |
| `object(person)` projection | `Person.data.parse(JSON.parse(JSON.stringify(person)))` |
| `ask(schema=Card) 'prompt'` | `await ask('prompt', { schema: Card })` |
| Annotated bindings, parameters and results | Not enforced; call `T.parse(value)` where a check is needed |

## Blockquotes

Blockquotes are unchanged: the same agent tools, `@name` markers, `@validate[Type]`,
`@CTL(...)` and `@CODEGEN`. Three details differ:

* `call_function` calls JavaScript functions and passes JSON values as they are; arguments are
  no longer decoded against parameter annotations.
* `@CODEGEN` generates JavaScript function declarations, and `codegen(description)` does the
  same from code.
* Script arguments are `@args`; the agent's `load_variable` still accepts the old `$args` name.

## Behavior differences

* **Everything asynchronous needs `await`.** 1.x ran model calls and tools implicitly in
  sequence. In JavaScript they return promises. A `map` over a model call yields promises:
  use `await Promise.all(items.map(item => ask(...)))`, which runs the calls concurrently, or
  a `for` loop to run them one by one.
* **No typed 64-bit integers.** Numbers are JavaScript numbers. `int` accepts safe integers
  (up to 2^53 - 1) and `float` any finite number, including integers. There is no separate
  integer representation, no checked overflow and no exact decoding of larger integer tokens.
* **No static type checker and no persistent contracts.** Annotations on variables and
  parameters do not exist at run time, `--check` does not check types, and a value that passed
  `parse` can be changed freely afterwards. Types check data where you apply them: `schema`,
  `@validate`, `parse`, `is` and `validate`. TypeScript in `ts` fences is erased, not checked,
  when the workflow runs; the VS Code extension reports type errors while editing. The
  `type_error` status code is no longer produced.
* **Annotations are advice.** As before, field and alias annotations describe data to the model
  and never reject a value.
* **`const` is not enforced across fences.** Top-level names live in one shared scope with REPL
  rules: redeclaring a name in a later fence rebinds it, and a top-level `const` can be
  reassigned. Inside functions and blocks, JavaScript's usual `let`/`const` scoping applies.
* **Imports resolve against the working directory.** 1.x resolved `.spl` imports next to the
  importing file. JavaScript imports resolve against `--cwd`, are loaded and cached by Node.js
  and need explicit `export`. Imported names are live, read-only bindings as before.
  `spl-lang` and `spl-lang/markdown` always resolve to the running copy of the package, so
  helper modules need no local install.
* **Helper modules are not recorded.** 1.x captured module source in traces and locked
  workflows. Now helpers are imported from disk again on replay: a locked workflow that imports
  local helpers is not self-contained, an edited helper changes the result and a deleted one fails.
* **`--check` is a syntax check.** It compiles fences, parses controls and verifies static
  relative `import` declarations. It no longer type-checks, and dynamic `import()` calls are not
  verified.
* **Native Node.js APIs are outside the runtime.** In 1.x all I/O went through tools. Now code
  can call `node:fs`, `fetch` or `child_process` directly; such calls are not checked by
  `restrict`, not recorded by `--trace` or `--pin`, and run again on replay.
* **Replay runs your JavaScript again.** Recorded library effects return their recorded
  results, but `Date.now()`, `Math.random()` and direct file reads produce new values. A changed
  value that reaches a prompt or tool argument makes the replay fail with a mismatch.
* **Fences run on the main thread.** They are ordinary JavaScript: a long synchronous loop
  blocks log rendering, timers and Ctrl+C handling until it yields. Add `await` points or move
  heavy work to a worker thread or child process.
* **Truthiness and equality are JavaScript's.** Empty arrays and objects are truthy, `==` on
  arrays and objects compares identity, and a missing argument is `undefined`, not `None`.
  Use `??` for defaults: `args[0] ?? 'world'`.
* **Strings interpolate only in template literals.** `'Hello {name}'` is now a literal string.
  Search migrated prompts for braces inside ordinary quotes.
* **Failures are exceptions.** `catch` receives a `Failure` object rather than a dictionary;
  `line` and `command` are filled in only when the failure ends the document. `success` is
  implemented by throwing, so a catch-all must rethrow what it does not handle. Any other
  uncaught JavaScript exception ends the document as `runtime_error`.
* **Classes need no opt-in.** `hydratable` is gone. A class type hydrates plain data into
  instances without running the constructor, unless the class has a static `fromJSON(data)`.

## Embedding API

| SPL 1.x | SPL 2.0 |
| --- | --- |
| `parse(source)` for SPL source | `parse(code, { language })` for JavaScript or TypeScript |
| `checkProgram`, `loadModules` | `checkWorkflow(workflow, cwd)`; imports are native |
| `encodeJson`, `decodeTypedJson`, `schemaForType`, `validateType`, `validateValue`, `testValue`, `project` | `JSON.stringify`, `Type.parseJson`, `Type.schema`, `Type.parse`, `Type.is`, `Type.data` |
| `run(program, { source })` naming codegen caches | `run(workflow, { file })`; `source` still labels failure payloads |
| Language only available inside workflows | `import { ask, struct, ... } from 'spl-lang'` in any Node.js program |

`parseMarkdown`, `run`, `ExecutionSession`, `Logger`, `AiBackend`, `Trace`, `Pin` and the backend
interfaces keep their shapes. See [Embedding](CLI.md#embedding).

## Editor

The VS Code extension no longer ships an SPL grammar, `.spl` language, snippets for SPL
statements or a Markdown preview highlighter. Fences get JavaScript and TypeScript language
features from the TypeScript language service, and notebook code cells are JavaScript or
TypeScript cells. See the [extension guide](../vscode/README.md).

The `.spl` file extension now names the [block format](Language.md#dedicated-spl-files) for
JavaScript workflows, which the extension colors and completes. It is not the 1.x language: a
1.x script in a `.spl` file is rejected with a syntax error.

## Checklist

1. Change every `spl` fence to `js` and translate its code with the tables above.
2. Add `await` to every model call, tool, `human`, `restrict` and `codegen`.
3. Turn interpolated strings into template literals and `$args`/`$env` into `args`/`env`.
4. Rewrite enums, structs, classes and aliases with the type builder; replace annotations on
   variables with `parse` calls where the check matters.
5. Convert `.spl` modules to `.js` modules with `export`, and make import paths relative to the
   folder you run `spl` from.
6. Run `spl workflow.md --check`, then record new traces and pins.
