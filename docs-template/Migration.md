# Migrating from 2.x

SPL 3.0 has one file format: a `.spl` file of TypeScript with Markdown comments and `---` blocks.
Runnable Markdown documents, the block tags of 2.x `.spl` files, control lines and `go()` are
gone. This guide maps each 2.x construct to its 3.0 form and lists the behavior that changed.

Migration is manual: **there is no automatic converter** and no compatibility mode.

* A file that contains 2.x syntax fails with `SPL 2.x syntax; see the migration guide`. The
  scanner reports it for a `{js}`, `{ts}`, `{agent}`, `{codegen}`, `{comment}` or `{lock}` tag,
  for a Markdown code fence, and for the frontmatter keys `extension`, `version` and `preamble`.
* `spl run flow.md` is a usage error: `'flow.md': Markdown workflows are no longer executable; SPL 3.0 runs .spl files. See the migration guide`.
* Recorded traces must be recreated, because the source and the runtime changed. Locked
  workflows cannot be replayed.

## Before and after

A 2.x Markdown workflow:

`journal.md`

````markdown
---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Rolling journal

Reads and writes its state explicitly in `journal.json`.

```js
const previous = JSON.parse(await readFile('./journal.json'));
const runs = previous.runs + 1;
let history = previous.history;
const notes = await readFile('./examples/data/notes.txt');
```

> Summarize @notes in one sentence and save it to @today

```js
history.push({ run: runs, summary: today });
history = history.slice(-5);
let trend = '';
```

> If @history has more than one entry, describe in one paragraph what changes from run to run
> and save it to @trend. Otherwise leave @trend unchanged.

```js
await writeFile('./journal.json', JSON.stringify({ runs, history }));
success({ run: runs, today, trend });
```
````

The same workflow in 3.0:

`journal.spl`

```spl
//*
# Rolling journal

Reads and writes its state explicitly in `journal.json`. Initialize the file once:

    echo '{"runs":0,"history":[]}' > journal.json
    spl run examples/journal.spl --trace journal-run-1.jsonl

Reuse that trace to resume or replay the same run; use a different trace for the next journal entry.
*//

---
model: gpt-6-luna
---

const previous = JSON.parse(await readFile('./journal.json'));
const runs: number = previous.runs + 1;
let history: { run: number; summary: string }[] = previous.history;
const notes = await readFile('./examples/data/notes.txt');

---
outputVar: today

Summarize these notes in one sentence: @notes
---

history.push({ run: runs, summary: today });
history = history.slice(-5);
let trend = '';

if (history.length > 1) {
    ---
    outputVar: =trend

    Describe in one paragraph what changes from run to run in @history
    ---
}

await writeFile('./journal.json', JSON.stringify({ runs, history }));
success({ run: runs, today, trend });
```

* The frontmatter became the file defaults block; `extension` and `version` are gone.
* The heading and the prose moved into a `//* ... *//` comment.
* The fences disappeared: their code is the file. It is TypeScript now, so `runs` and `history`
  can carry types.
* The first blockquote became an ask block. "Save it to @today" is now `outputVar: today`.
* The condition that the second blockquote described in words is an `if` in code, and
  `outputVar: =trend` assigns the existing variable.

A 2.x `.spl` file with tags, control lines and `go()`:

`conditional-workflows.spl` (2.x)

```text
{js}
let cond = args[0]
let i = 0
let result = null
{/js}

if cond == 'color':
    {agent model='gpt-6-luna', reasoning='low'}
    What is your favorite color? Save to -> @result
    {/agent}
else:
    {js}
    go('final')
    {/js}

while i < 2:
    {agent model='gpt-6-luna', reasoning='low'}
    Increment the number @i by one. Save to -> @i
    {/agent}

{js alias="final"}
success({result, i})
{/js}
```

In 3.0:

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

## Files and commands

| SPL 2.x | SPL 3.0 |
| --- | --- |
| `workflow.md` with frontmatter | `workflow.spl` |
| `workflow.spl` with `{js}` and `{agent}` tags | `workflow.spl` with code and `---` blocks |
| `spl workflow.md`, `spl workflow.spl` | `spl run workflow.spl` |
| `spl workflow.md --check` | `spl check workflow.spl`, which now type-checks too |
| `spl workflow.md --pin`, then `spl workflow.locked.md` | `spl run workflow.spl --trace run.jsonl`, twice: a completed trace replays without a model |
| No equivalent | `spl compile workflow.spl`: an importable TypeScript module |
| No equivalent | `spl doc workflow.spl`: the workflow as a document |
| Notebooks in VS Code | Removed; use the Run and Debug commands, or `spl run --debug` |

Every other option of `spl run` is unchanged: `--arg`, `--human`, `--model`, `--provider`,
`--cwd`, `--mcp`, `--timeout`, `--trace`, `--log-level`, `--silent` and `--debug`.

## File structure

| SPL 2.x | SPL 3.0 |
| --- | --- |
| Frontmatter `extension` and `version` | Removed: the file extension identifies a workflow |
| Frontmatter `model: 'gpt-6-luna'` | [File defaults](Language.md#file-defaults) block with `model: gpt-6-luna` |
| Frontmatter `preamble: 'Be concise.'` | File defaults with `enforce: Be concise.` |
| Headings and prose; `{comment}` ... `{/comment}` | A [Markdown comment](Language.md#markdown-comments): `//*` ... `*//` |
| A `js` fence; `{js}` ... `{/js}` | Code, written directly in the file |
| A `ts` fence; `{ts}` ... `{/ts}` | The same: every file is TypeScript |
| A fence marked `ignore` or `no-run`; `{js ignore}` | An indented or fenced listing inside a Markdown comment |
| A blockquote; `{agent}` ... `{/agent}` | An [agent block](LLM-commands.md#agent-blocks), or an [ask block](LLM-commands.md#ask-blocks) when one answer is all it produces |
| `@CTL(...)` at the start of a blockquote; settings in an `{agent ...}` tag | [Header keys](LLM-commands.md#the-header) |
| `@CODEGEN 'description'`; `{codegen}` ... `{/codegen}` | A [codegen block](LLM-commands.md#codegen-blocks) |
| The journal of a locked workflow; `{lock}` | Removed with locked workflows |

## Instructions

| SPL 2.x | SPL 3.0 |
| --- | --- |
| `> Summarize @notes and save it to @summary` | An ask block with `outputVar: summary`, or `-> @summary` in an agent block |
| "Save to @name", `-> @name` as a convention the agent followed | `-> @name` is syntax: it declares the output, and an agent may save only declared outputs |
| `@validate[Invoice] save to @invoice` | `->[Invoice] @invoice` in an agent block; `outputType: Invoice` in an ask block |
| `typedef('Reviews', list(Review))`, then `@validate[Reviews]` | The type is an expression: `->[List(Review)] @reviews` |
| `@CTL(model='gpt-6-luna', reasoning='high')` | `model: gpt-6-luna` and `reasoning: high` |
| `@CTL(restrict={fs: ['./src'], exec: ['git']})` | `restrict: { fs: ./src, exec: git }` |
| `@CTL(enforce='Be concise', forbid='guessing')` | `enforce: Be concise` and `forbid: guessing` |
| `@success` and `@fail` in a blockquote | `success()` and `fail()` in code, after the block has saved what they need |
| The agent tools `success`, `fail` and `restrict` | Removed; use code and the `restrict` header key |
| `@CODEGEN 'Define double(value)'` | A codegen block: `Double a number -> @double(value: number): number` |
| `@env.NAME`, `@args` | Unchanged |
| `@readFile`: a library function as a reference | Not needed: the exact tools are always available to an agent |

```text
> @CTL(forbid='filling in values that are not printed on the invoice')
>
> Extract the invoice in @text. @validate[Invoice] save to @invoice
```

```spl
---
outputVar: invoice
outputType: Invoice
forbid: filling in values that are not printed on the invoice

Extract the invoice in @text.
---
```

## Control flow

| SPL 2.x | SPL 3.0 |
| --- | --- |
| `if condition:`, `elif condition:`, `else:` with indented blocks | `if (condition) { ... } else if (condition) { ... } else { ... }` with blocks inside |
| `while condition:` with indented blocks | `while (condition) { ... }` |
| `{js alias="check"}` and `go('check')` | A loop or a function: `do { ... } while (...)`, `for`, `break`, `continue` |
| A condition described in the instruction | `if` in code around the block |

Blocks are statements in 3.0, so TypeScript control flow replaces control lines and `go()`.
A retry that jumped back with `go()`:

```text
{js}
let error = ""
{/js}

{agent alias="prime"}
What is an answer to everything?
Save to -> @response
If @error is not empty, repair
{/agent}

{js alias="check"}
if (int.is(response)) {
    success(response)
}
error = `Response is not an integer: ${JSON.stringify(response)}`
go('prime')
{/js}
```

becomes a loop:

`goto.spl`

```spl
//*
# Retry until the answer checks out

A plain loop asks, checks the answer in code and tells the model what was wrong.
SPL 2.x needed `go()` for this.

    spl run examples/goto.spl
*//

---
model: gpt-6-luna
---

let error = '';
let response: unknown;

do {
    ---
    mode: agent

    What is the answer to everything? -> @=response
    If @error is not empty, repair your previous answer.
    ---
    error = Int.is(response) ? '' : `Response is not an integer: ${JSON.stringify(response)}`;
} while (error);

success(response);
```

## Library

| SPL 2.x | SPL 3.0 |
| --- | --- |
| `think(prompt, { reasoning: 'high' })` | `ask(prompt, { reasoning: 'high' })` |
| `reasoning`: `low`, `medium`, `high` | `none`, `low`, `medium`, `high`, `max` |
| `go(alias)` | Removed |
| `str`, `int`, `float`, `bool`, `char`, `nil`, `any`, `fn` | `Str`, `Int`, `Float`, `Bool`, `Char`, `Nil`, `Any`, `Fn` |
| `object` | `Dict` |
| `list(T)`, `union(A, B)`, `nullable(T)` | `List(T)`, `Union(A, B)`, `Nullable(T)` |
| `enumOf('a', 'b')` | `Enum('a', 'b')` |
| `struct(...)`, `typedef(...)`, `jsonSchema(...)` | `Struct(...)`, `Typedef(...)`, `JsonSchema(...)` |
| `t.str`, `t.enum`, `t.null`, `t.schema` | `t.Str`, `t.Enum`, `t.Nil`, `t.JsonSchema` |
| Messages such as `expected int, got "x"` | `expected Int, got "x"` |
| No equivalent | `Type.coerce(value)` |
| The option `top_p` as an alias of `topP` | `topP` only |
| Agent tools `read_file`, `write_file`, `web_fetch`, `web_search` | `readFile`, `writeFile`, `webFetch`, `webSearch`, also in logs and traces |
| `load_variable`, `save_variable`, `call_function`, `get_env`, `ask_human`, `set_guidance` | `loadVariable`, `saveVariable`, `callFunction`, `getEnv`, `askHuman`, `setGuidance` |
| `save_variable(name, value, schema)` | `saveVariable(name, value)`: the type comes from the output's declaration |
| MCP tools numbered `mcp_0_0`, `mcp_0_1`, ... | Named after the tool: `mcp<Index><Tool>`, such as `mcp0Search` |

`human`, `enforce`, `forbid`, `restrict`, `success`, `fail`, `assert`, `log`, `codegen`, the
exact tools, `args`, `env`, `markdown`, `validate` and `Failure` keep their names and behavior.

## Behavior differences

* **Types are checked.** `spl check` runs the TypeScript compiler; `--check` only compiled the
  code. `spl run` still erases types without checking them.
* **Normal scoping.** 2.x had one shared scope with REPL rules. Now a `const` cannot be
  reassigned or redeclared, a name declared inside an `if` body is not visible after it, and a
  variable must be declared before a block can assign it with `=name`.
* **Outputs are declared.** A 2.x agent could create any variable by saving it. Now a block
  declares its outputs, they are typed, and saving anything else stops the block.
* **Agents reach only what the block references.** 2.x sent an overview of every shared
  variable with each blockquote. Now the prompt lists the block's inputs and outputs, and the
  agent can load and call only the names the instruction mentions.
* **Ask blocks are new.** A block without `mode` is one model call without tools, with the
  referenced values inlined as JSON. Use it where a 2.x blockquote only produced one answer.
* **Model output is converted.** 2.x validated strictly; 3.0 passes answers and saved values to
  `Type.coerce`, which accepts numeric strings, JSON text and similar near misses.
* **Agents correct invalid saves.** A value that does not fit goes back to the agent up to twice
  per output instead of stopping the block at once. A missing output fails the block.
* **Reasoning defaults to `medium`** for `ask`, as it already did for agents; with `seed`,
  `temperature` or `topP` it defaults to `none`. 2.x `ask` had no default reasoning.
* **No preamble.** Nothing is prepended to prompts for the whole file unless you write
  `enforce` or `forbid` in the file defaults.
* **Imports resolve from the file.** 2.x resolved imports against the working directory.
  Paths given to tools and `restrict` still resolve against `--cwd`.
* **A `.spl` file is a module.** `export` is allowed, another `.spl` file can import it, and
  its default export is the workflow.
* **Generated code is cached without a trace.** A codegen block always saves its functions
  beside the workflow, keyed by its text.
* **Failure payloads changed slightly.** `source` is now a file path and appears only when the
  failure is in another file; `source_version` is gone. A failure of a block reports the line
  of its opening `---`.
* **Stepping and state logs follow the code.** `--debug` stops before each block and each
  top-level statement. State logs cover top-level variables and the outputs of nested blocks;
  changes to locals inside functions are no longer reported.
* **Locked workflows are gone.** `--pin` and `*.locked.*` files are removed. A trace gives the
  same guarantee: a completed trace replays without models, tools or prompts.
* **Notebooks are gone** from the VS Code extension, together with support for Markdown workflows.

## Embedding API

| SPL 2.x | SPL 3.0 |
| --- | --- |
| `parseMarkdown(text)` or `parseSpl(text)`, then `run(workflow, options)` | `run(source, options)` |
| `parse(code)`, `parseInstruction(text)`, `compileCell` | `compile(source)`, `scan(source)` |
| `checkWorkflow(workflow, cwd)` | `check(file)` |
| `ExecutionSession` | Removed |
| `Pin` and the `pin` option | Removed; use `Trace` |
| The `run` options `store`, `source`, `sourceVersion` | Removed; `file` names the workflow |
| The `run` option `beforeBlock` | `beforeStep(step)` |
| `CopilotBackend` | `AiBackend` |
| `request.kind === 'think'`, `request.naturalLanguage` | `request.kind` is `ask` or `agent`; an agent block's request has `runtimeTools` |

See [Embedding](CLI.md#embedding).

## Editor

The VS Code extension no longer treats Markdown files as workflows and no longer has notebooks.
For `.spl` files it colors Markdown comments, block headers and instructions, reports
TypeScript diagnostics, completes and shows hovers, completes `@name` inside blocks, and has
Run and Debug commands that open a terminal. See [Getting started](Getting-started.md#vs-code-extension).

## Checklist

1. Rename `workflow.md` to `workflow.spl`. Turn the frontmatter into a file defaults block and
   the prose into `//* ... *//` comments.
2. Remove the fences and tags around code. Add types where they help, and fix what
   `spl check` reports.
3. Rewrite each blockquote or `{agent}` block as a `---` block. Move `@CTL` settings into the
   header, declare what the block produces with `outputVar` or `-> @name`, and replace
   `@validate[Type]` with `outputType` or `->[Type]`.
4. Replace control lines and `go()` with TypeScript `if`, `while` and loops, and move
   `@success` and `@fail` into code.
5. Replace `think()` with `ask()` and a `reasoning` level.
6. Rename the types: uppercase names, `object` to `Dict`, `enumOf` to `Enum`.
7. Make import paths relative to the file that contains them.
8. Run `spl check workflow.spl`, then `spl run workflow.spl --trace run.jsonl` to record a new trace.
