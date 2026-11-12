# Natural language & models

Blockquotes let you write a step in plain language; `ask`, `think` and `agent` call the model from code.
This page covers both, and how to check what comes back.

## Blockquotes

A blockquote is an agent command, not text that is compiled into code. The model receives the
instruction, a JSON overview of the shared bindings, the active guidance and restrictions, and a
set of tools. It acts directly on the shared scope through tool calls.

```markdown
> Summarize @notes in one sentence and save it to @summary
```

For a simple generation task, the comparable code is:

```js
const summary = await ask(`Summarize: ${notes}`, { len: 'sentence' });
```

Blockquotes have these tools in addition to configured MCP tools:

| Tool | Purpose |
| --- | --- |
| `load_variable(name)` | Read a shared variable, a library value, or the script arguments with the name `args`; a type returns its complete JSON Schema |
| `save_variable(name, value, schema?)` | Create or update a shared variable; `schema` is the name of a type or schema binding, or an inline JSON Schema |
| `call_function(name, args)` | Call a shared function or library function with positional JSON arguments and return its result |
| `get_env(name)` | Read one environment variable; missing variables return `null` |
| `ask_human(question)` | Ask a person and return the answer |
| `read_file`, `write_file`, `web_fetch`, `web_search`, `shell` | The exact runtime tools |
| `restrict(kind, value)` | Narrow restrictions for the rest of the command, including function and MCP calls |
| `set_guidance(kind, text)` | Add `enforce`/`forbid` guidance for this command and its nested model calls |
| `success(value)`, `fail(reason)` | End the whole document |

These shared-scope tools are specific to blockquotes. `agent(...)` calls in code have the runtime
tools and MCP tools only; `ask` and `think` have no tools.

The overview sent with every blockquote contains the current value of each top-level binding:
data as JSON, functions as signatures such as `function add(a, b)`, types as labels such as
`<type Review>`. Keep secrets and very large values out of top-level variables, or read them
inside a function.

`@name` marks a binding or operation; it is a reference for the agent, not text substitution.
Plain language works too.

| Marker | Agent behavior |
| --- | --- |
| `@notes`, `@summarize` | Load or save the shared variable; call the shared function |
| `@validate[Schema]` | Inspect the type `Schema`, then pass its name to `save_variable`; an invalid value stops the command |
| `@success`, `@fail` | End the document with a result or an explicit failure |
| `@env.NAME` | Read one environment variable with `get_env` |
| `@args` | Read the script arguments |

With `@validate[Review]`, the runtime resolves `Review`, validates the JSON value and saves what
`Review.parse` returns: plain objects for structs, instances for [class types](Language.md#classes).
An inline JSON Schema, or the name of a binding holding one, only validates. Name composite
types first, for example `const Reviews = typedef('Reviews', list(Review))`, then write
`@validate[Reviews]`: the tool resolves binding names, not expressions such as `list(Review)`.
A rejected value reports the path from the variable being saved, for example
`invoice.tax: expected Money, got 3312.5`.

`save_variable` refuses to replace a function, a type, an imported name or a library name, and
`call_function` passes JSON values as they are. Each tool call executes immediately and returns its real result
to the same agent session. Any tool error stops the command at once, keeping its own status
code; the model cannot retry, and completed actions are not repeated. A prose reply does not
create variables, so follow important steps with a check:

```js
assert(typeof summary === 'string' && summary.length < 300, 'summary is missing or too long');
```

### Controls

Put optional controls in one `@CTL(...)` block at the start of the blockquote:

```markdown
> @CTL(
>     restrict={fs: ['./src'], exec: ['git'], net: ['docs.example.com'], mcp: ['docs/search']},
>     enforce='Be concise',
>     forbid='Suggesting purely stylistic changes',
>     model='gpt-6-luna',
>     reasoning='high'
> )
>
> Review the source files and save findings to @notes.
```

| Setting | Values | Effect |
| --- | --- | --- |
| `restrict` | A map with `fs`, `exec`, `net` or `mcp` keys; each value is a string or list of strings | Narrow runtime permissions before the first tool call, like [`restrict`](Safety.md#restrictions) in code |
| `enforce`, `forbid` | A string or list of strings | Add prompt guidance for this command and its nested model calls; not validation |
| `model` | A nonempty string | Model for this blockquote; CLI `--model` still takes precedence |
| `reasoning` | `'low'`, `'medium'` or `'high'` | Reasoning effort of this blockquote's agent; defaults to `'medium'` |

Controls are parsed and applied by the runtime, not interpreted by the model. Settings are
literals, never JavaScript expressions: strings use single, double, backtick or triple quotes,
`r'...'` is a raw string, and `${...}` interpolation is rejected. Setting names and restriction
kinds must be unique. Unknown settings, wrong value types and a misplaced or repeated `@CTL` are
syntax errors, also with `--check`. Multiline settings and trailing commas are supported, and the
marker is case-insensitive.

All settings expire at the end of the blockquote. Restrictions intersect with those already
active; guidance is inherited by functions the agent calls and by their model calls. `model` and
`reasoning` select only the blockquote's agent. The former `@Restrict`, `@Enforce`, `@Forbid` and
`@Human` markers are syntax errors: use `@CTL`, and request human input in plain language.

`--check` validates syntax only; it cannot validate a blockquote's intent. `--trace` records the
agent's decisions and tool results, and replay restores shared-variable changes without
contacting the model or MCP. Run only trusted documents.

Human input prompts in the shell and returns the answer to the same agent session; repeat
`--human <answer>` to answer questions in order without prompting.
See [Human in the loop](Safety.md#human-in-the-loop).

## Code generation

`@CODEGEN` generates reusable JavaScript functions instead of running an agent command. In code,
`await codegen(description)` does the same and returns the function.

````markdown
---
extension: semantic-prompt-language
version: 1
---

> @CODEGEN 'Define double(value), returning value multiplied by two'

```js
const result = double(21);
```

> @CTL(model='gpt-6-luna', reasoning='high')
> @CODEGEN '''
> Define addOne(value), returning the input plus one.
> '''

```js
const slugify = await codegen('slugify(title): lowercase words joined with single dashes');
success([addOne(result), slugify('Hello, World')]);
```
````

The marker must start the blockquote, after optional `@CTL(...)` settings, and takes exactly one
nonempty literal string. `codegen(description, { model, reasoning })` accepts the same two
controls. The description syntax is checked by `--check`; generation happens only when running.

The model receives the description, the shared bindings overview, the library function names and
active guidance, with no tools. Its response must contain only function declarations
(`function name(...)` or `async function name(...)`): the requested function first, then any
helpers. One enclosing code fence is unwrapped; imports, exports and other top-level statements
are rejected with `invalid_format`. The functions are defined in the shared scope without being
called, can use the library and shared bindings, and stay available to later fences, blockquotes
and interactive cells.

With `--trace`, generated code is saved beside the workflow as `<workflow>.<function>.js`, such
as `flow.double.js`. Each file starts with `// @CODEGEN sha256:<64 hex digits>`, the SHA-256
hash of the description. If the friendly file name is taken, the hash is added to the name
rather than overwriting the file.

Every new traced run looks for a sibling `<workflow>.*.js` file whose first line matches the
description and uses it without a model call. A matching file that is not valid generated code
fails; it is not silently regenerated. These files are editable JavaScript: review generated
code before trusting it. The hash identifies the description, not the code, model or bindings.
To regenerate, change the description or remove the cached file, then choose a new trace file.

Replaying the same trace uses its recorded code, not the cache files. Without `--trace`, no
cache is read or written. `--pin` embeds the generated code in the locked workflow, which then
replays without the cache files.

## Generation: ask and think

`await ask(prompt)` returns the model's answer. `think` is the same with medium reasoning by
default. Neither has tools: they cannot read files, browse or run commands.

```js
const title = await ask(`Suggest a title for: ${draft}`);
const plan = await think(`Plan the migration of ${service}`, { reasoning: 'high' });
const tagline = await ask`A tagline for ${product}`;
```

Each call starts a fresh conversation. Pass context explicitly, usually through a template
literal. The tagged-template form takes no options; interpolated objects are rendered as JSON.

Model responses stream into the interactive CLI view and notebook cell outputs while the model
is working, including available reasoning by default. `hide: true` suppresses reasoning, not
responses. These are previews: JSON parsing, schema validation and repairs use the completed
response, never partial chunks. Traces retain complete responses rather than streaming chunks.

Embedded integrations can use `LoggerOptions.streamSink` for request-scoped `ModelStreamEvent`
updates. Backend callers can supply `LlmRequest.onStream`. Updates identify a response or
reasoning channel and a message ID: append chunks with `mode: 'append'`, replace content with
`mode: 'replace'`. `LlmResponse.text` is always the authoritative return value.

## Agents

`await agent(prompt)` lets the model act with the runtime tools (`read_file`, `write_file`,
`web_fetch`, `web_search`, `shell`) and any configured MCP tools. Actions are checked against
active restrictions. Agents default to medium reasoning and never use repairs, so a failed check
never repeats their actions.

```js
const report = await restrict({ fs: './src', exec: 'npm' }, () =>
    agent('Run the tests, fix the failing source file, and describe the fix'));
```

## Options

All three calls take an options object as the second argument. Values are validated before the
call; an unknown name or invalid value is a `runtime_error` and no model is contacted.

| Option | Values | Effect |
| --- | --- | --- |
| `len` | `'word'` `'sentence'` `'paragraph'` `'long'` | Length hint (guidance only) |
| `fmt` | see [Output formats](#output-formats) | Parse and check the answer |
| `schema` | A [type](Language.md#types) or JSON Schema draft-07 | Validate the answer; implies JSON |
| `repairs` | `0` to `5` | Extra attempts after a format or schema error; not for `agent` |
| `reasoning` | `'low'` `'medium'` `'high'` | Reasoning effort, if the model supports it |
| `hide` | `true` or `false` (default) | Suppress reasoning display when `true`; responses remain visible |
| `model` | Model ID | Per-call model |
| `tokens` | Positive safe integer | Maximum generated tokens per model turn, including reasoning |
| `seed` | Integer `0..2147483647` | `ask` only: request repeatable sampling where supported |
| `temperature` | Number `0..2` | `ask` only: control sampling variability |
| `topP` | Number `0..1` | `ask` only: control nucleus sampling (`top_p` is accepted as an alias) |

```js
const score = await ask(`Rate this issue from 1 to 5: ${issue}`, {
    fmt: 'integer',
    repairs: 1,
    tokens: 2048,
});
```

`tokens` is a hard generation budget, not a length hint or a separate thinking budget.
The same limit applies independently to every repair attempt and agent tool-continuation turn.
Omitting it keeps provider defaults. It maps to OpenAI `max_output_tokens`
(or `max_completion_tokens` for seeded calls), Anthropic `max_tokens`, and Google `maxOutputTokens`.
Legacy Anthropic manual thinking requires `tokens` to exceed its reasoning budget (`low`: 1024,
`medium`: 4096, `high`: 16384); conflicting settings fail rather than silently enlarging the budget.
If the model hits its token limit, the call fails with `llm_error`, not a successful partial
answer, and repairs do not retry the truncated turn. Explicit budgets are part of the recorded
request, so changing a budget cannot silently reuse an old answer during replay.

Model precedence: CLI `--model`, then the per-call `model`, then frontmatter `model`, then the
provider default. OpenAI, Anthropic and Google are supported through their official clients; use bare
model IDs or `provider/model`. See [Models and authentication](CLI.md#models-and-authentication).

## Randomness controls

Set sampling options directly on `ask`:

```js
const answer = await ask('Answer precisely', { seed: 42, temperature: 0, topP: 0.01 });
const plan = await ask('Plan the migration', { temperature: 0, reasoning: 'high' });
```

Omitted sampling controls use provider/model defaults; no seed, temperature or `topP` is
invented. The same values are reused for every repair attempt. `think`, `agent` and blockquotes
do not accept sampling options.

`ask` has no implicit reasoning effort. An explicit `reasoning` always takes precedence. Models
that cannot disable thinking use the lowest supported thinking setting with a compatibility warning.

Provider limitations are diagnosed with warnings; the runtime keeps supported controls without
changing the model, and preserves explicitly requested reasoning:

* **OpenAI:** seeded calls use Chat Completions, which accepts `seed`; unseeded calls retain
  the Responses API. Chat Completions does not expose reasoning summaries, so requested
  summaries warn and are omitted. Seeds are best-effort and deprecated by the upstream API.
  Models that require reasoning, or calls with explicit reasoning, may remove sampling controls.
* **Google:** the Generate Content API receives `seed`, `temperature` and `topP`. A fixed seed
  with low temperature and a small nucleus is best-effort repeatability, not a guarantee.
* **Anthropic:** seeds are unsupported. Temperature is capped at `1` with a warning. On compatible
  non-thinking models, set either temperature or `topP`; if both are supplied, temperature wins.
  Thinking and newer models may reject sampling altogether; unsupported controls are removed
  with warnings.

The response's `effective.randomness` records the controls actually retained by the provider
adapter; `null` means the control was omitted or unsupported and provider defaults apply.
Traces and pinned workflows include requested sampling controls in the request identity.

Even extreme settings cannot guarantee identical outputs from hosted models. Use
[`--trace`](CLI.md#traces-and-replay) or [`--pin`](CLI.md#pinned-workflows) for deterministic replay.

## Output formats

| `fmt` | Accepts | JavaScript result |
| --- | --- | --- |
| `'text'` (default) | Trimmed text, no parsing | `string` |
| `'integer'` | JSON number without a fraction | `number` |
| `'float'` | Any finite JSON number | `number` |
| `'boolean'` | JSON `true` or `false` | `boolean` |
| `'array'` | JSON array | `Array` |
| `'object'` | JSON object (not an array) | plain object |
| `'json'` | Any JSON value | any JSON value |

Parsing is strict: prose around JSON and Markdown code fences are rejected, and values are never
coerced. A malformed or wrong-typed answer raises `invalid_format`.

## Schemas and repairs

`schema` accepts a [type](Language.md#types) or raw JSON Schema. Both reject invalid output
without coercion, defaults or removal of extra fields. A mismatch raises `validation_failed`
with the path of the offending field.

```js
const Label = enumOf('bug', 'feature', 'question');
const Triage = struct('Triage', {
    label: Label,
    reason: str.annotate({ desc: 'One-sentence explanation' }),
});

const triage = await ask(`Classify: ${issue}`, { schema: Triage, repairs: 2 });
assert(triage.label !== 'bug' || triage.reason.length > 0, 'bugs need a reason');

const batch = await ask(`Classify each issue: ${JSON.stringify(issues)}`, { schema: list(Triage) });
```

With a type, the result is what `Type.parse` returns: plain objects for structs, instances for
class types. Struct fields are exact and required, including nullable fields. Annotations are
advice for the model only. Raw JSON Schema is validated strictly with Ajv and returns the JSON
value, for when constraints such as `minimum` must be enforced:

```js
const rating = await ask(`Rate this issue from 1 to 5: ${issue}`, {
    schema: { type: 'integer', minimum: 1, maximum: 5 },
});
```

`repairs: n` allows up to `n` more attempts. Each sends the original prompt again, followed by
the previous answer and the validation error. Only `invalid_format` and `validation_failed` are
repaired; transport and tool errors are not. Put business rules in `assert`, after the call.
`schema` and `repairs` need JSON output: combining them with `fmt: 'text'`, or using `repairs`
without `fmt` or `schema`, is a `runtime_error`.

## Guidance: enforce and forbid

`enforce(text, body)` and `forbid(text, body)` add instructions to every model call made while
`body` runs, including calls in functions it invokes and across `await`. They return what `body`
returns. `text` is a string or a list of strings; nested guidance combines. Guidance shapes
prompts; it does not check the answer.

```js
const answer = await enforce('Answer in English', () =>
    forbid('jokes', () => ask('Explain recursion', { len: 'sentence' })));
```
