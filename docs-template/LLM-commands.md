# Natural language & models

A `---` block is an instruction for a model, written in plain language between lines of code;
`ask` and `agent` call the model from code. This page covers the three block modes, references
and outputs, models and reasoning, and how to check what comes back.

## Blocks

A block holds a header and an instruction; [Workflow code](Language.md#blocks) describes the
syntax. Its `mode` decides how the instruction is carried out.

| Mode | What runs | Tools | Outputs |
| --- | --- | --- | --- |
| `ask` (default) | One prompt, one model call | None | One: `outputVar`, converted with `outputType` |
| `agent` | One agent call that acts until its outputs are saved | Variables, functions, files, web, shell, MCP | Any number: `->[Type] @name` |
| `codegen` | One model call that writes JavaScript functions | None | Functions: `-> @name(params): Type` |

`is-friday.spl`

```spl
//*
# Is it Friday?

`outputType: Bool` makes the answer a real boolean, so code can branch on it.

    spl run examples/is-friday.spl
*//

---
model: gpt-6-luna
---

const today = new Date().toDateString();

---
outputVar: isFriday
outputType: Bool

Today is @today. Is it Friday?
---

if (isFriday) success('Today is Friday!');

---
outputVar: complaint

Complain in an original way that it is not Friday yet.
---

success(complaint);
```

Both blocks are ask blocks. The first converts the answer to a boolean, so `isFriday` has the
TypeScript type `boolean`. The second has no `outputType`, so `complaint` is the reply as text.

## The header

The header is the run of `key: value` lines at the start of a block. Values are YAML, except
`outputType`, which is a TypeScript expression.

| Key | Modes | Value | Meaning |
| --- | --- | --- | --- |
| `mode` | all | `ask`, `agent` or `codegen` | What the block does; `ask` when omitted |
| `model` | all | Model id | Model for this block; `provider/model` selects a provider |
| `reasoning` | all | `none`, `low`, `medium`, `high` or `max` | [Reasoning level](#models-and-reasoning); `medium` by default |
| `enforce` | all | String or list of strings | [Guidance](#guidance-enforce-and-forbid) the model must follow |
| `forbid` | all | String or list of strings | Guidance on what the model must avoid |
| `hide` | all | `true` or `false` | Hide reasoning in logs; responses stay visible |
| `tokens` | all | Positive integer | Maximum generated tokens per model turn |
| `restrict` | agent | A folder, a list of folders, or a map with `fs`, `exec`, `net`, `mcp` | [Restrictions](Safety.md#restrictions) for this block |
| `outputVar` | ask | A variable name, or `=name` | The output; required in ask blocks |
| `outputType` | ask | Type expression | The type the answer is converted to; `Str` by default |
| `repairs` | ask | Integer `0` to `5` | Retries when the answer cannot be converted to `outputType` |
| `seed` | ask | Integer `0` to `2147483647` | [Sampling](#sampling) seed |
| `temperature` | ask | Number `0` to `2` | Sampling temperature |
| `topP` | ask | Number `0` to `1` | Nucleus sampling |

A key used in a mode it does not apply to is an error, for example
`` `outputVar` applies only to ask blocks `` or `` `restrict` applies only to agent blocks ``.
`model`, `reasoning`, `enforce`, `forbid`, `hide` and `tokens` can also be
[file defaults](Language.md#file-defaults).

A list value continues on indented lines:

```spl
---
outputVar: translations
outputType: Dict
enforce:
  - Keep the Markdown structure, URLs, e-mail addresses and `code spans` exactly as in the source
  - Use the product's informal, friendly tone and localize UI paths such as menu names

Translate the Markdown in @source into every language code in @languages.
Return an object that maps each language code to its translated Markdown.
---
```

## References

`@name` in an instruction refers to a variable, a function or a type of the surrounding code.

| Written | Meaning |
| --- | --- |
| `@notes` | The variable, function or type `notes` |
| `@invoice.total` | A property: an identifier followed by `.identifier` parts |
| `@env.NAME` | The environment variable `NAME` |
| `@args` | The script arguments |
| `@@` | A literal `@` |
| `user@example.com` | Literal text: a reference starts a word |

* **Inputs.** Every `@name` that is not an output of the same block is an input. An input that
  does not exist is TypeScript's `Cannot find name` error on its line in `spl check`, and a
  `runtime_error` when the block runs.
* **No interpolation.** There is no `${...}` in instructions. A reference is the only way a
  value enters a block, and how it reaches the model depends on the mode.
* **In an ask block**, referenced values are inlined into the prompt as JSON, each labelled with
  its name. The instruction keeps its `@name` text.
* **In an agent block**, the prompt names each input and its kind, and the agent reads values and
  calls functions through [tools](#agent-tools).
* **In a codegen block**, referenced values are shown to the model as JSON and are in scope for
  the generated code under their names.

`env.spl`

```spl
//*
# Environment variables and arguments

In a block, `@env.NAME` reads an environment variable and `@args` reads the arguments.
Code reads `env` and `args` directly.

    lhs=2 rhs=40 spl run examples/env.spl --arg first --arg second
*//

---
model: gpt-6-luna
---

---
outputVar: sum
outputType: Int

Calculate the sum of @env.lhs and @env.rhs
---

const [first, second] = args;

log(first, second);
log(`HOME is ${env.HOME ?? env.USERPROFILE}`);

success(sum);
```

For this block the model receives the instruction followed by the values:

```text
Calculate the sum of @env.lhs and @env.rhs

Values referenced above, as JSON:
@env.lhs = "2"
@env.rhs = "40"
```

| Referenced value | Inlined in an ask block as |
| --- | --- |
| Data | Its JSON |
| A function | Its signature, such as `"function fib(n)"` |
| A type | Its JSON Schema |
| `undefined`, such as a missing environment variable | `null` |

## Ask blocks

An ask block is one prompt and one model call. It has no tools: the model cannot read files,
browse or run commands.

```spl
---
outputVar: invoice
outputType: Invoice
forbid: filling in values that are not printed on the invoice
repairs: 1

Extract the invoice in @text. Dates are ISO `YYYY-MM-DD`, currency is an ISO 4217 code,
and there is one entry per line item. Convert printed monetary amounts to integer cents
(for example, 12.50 becomes 1250).
---
```

* **Exactly one output.** `outputVar` names it. A block without it is an error:
  `` ask block needs outputVar: name the variable that receives the answer, such as `outputVar: summary` ``.
  Writing `->` in an ask block is an error too:
  `` ask block needs outputVar: `->` declares outputs only in agent and codegen blocks ``.
* **`outputType` is a type expression** such as `Int`, `List(Str)`, `Nullable(Invoice)` or the
  name of a type declared in code. The output has the matching TypeScript type.
* **Without `outputType`, or with `Str`,** the output is the reply as trimmed text.
* **With any other type,** the model is asked for JSON and given the type's JSON Schema. The
  reply is parsed as JSON, after one enclosing code fence is removed, and passed to
  [`Type.coerce`](Language.md#parse-and-coerce).
* **A bad answer fails the block.** A reply that is not JSON raises `invalid_format`; a value
  that does not fit raises `validation_failed` with the path of the bad field. `repairs: n`
  lets the model try again up to `n` times; see [Types, schemas and repairs](#types-schemas-and-repairs).

The block above comes from [extract-invoice.spl](../lang/examples/extract-invoice.spl).

## Agent blocks

An agent block is one agent call over the whole block. The model works through the
instruction with tools: it reads the inputs, calls functions, acts on files, the web and the
shell, and saves each output.

`code-review.spl`

```spl
//*
# Review the riskiest source files

An agent picks and reviews three files inside `./src`, an ask block turns its notes into typed
findings, and plain code decides whether the run fails.

    spl run examples/code-review.spl
*//

---
model: gpt-6-luna
---

const Severity = Enum('low', 'medium', 'high');

const Item = Struct('Item', {
    severity: Severity,
    title: Str,
    location: Str.describe('File path and line'),
    fix: Str,
});

const Review = Struct('Review', { findings: List(Item) });

---
mode: agent
restrict: { fs: ./src, exec: git }
forbid: suggesting purely stylistic changes

List source files with `git ls-files src`.
Then read the 3 files that are most likely to contain security problems or correctness bugs,
and review only those. List each finding with its location, why it matters and a suggested fix -> @notes
---

---
outputVar: review
outputType: Review

Convert these review notes into structured findings: @notes
---

const groups = Object.groupBy(review.findings, finding => finding.severity);
const high = groups.high ?? [];

---
mode: agent
restrict: { fs: ./reports }
model: gpt-6.1-sol

Convert @groups to a Markdown report and write it to './reports/review.md'
---

if (high.length > 0) fail(`${high.length} high severity finding(s), see ./reports/review.md`);

success(review.findings.map(finding => `${finding.severity}: ${finding.title} (${finding.location})`).join('\n'));
```

Outputs are declared inline, where the instruction talks about them:

| Written | Declares |
| --- | --- |
| `->[Int] @count` | A constant `count` of type `Int` |
| `-> @notes` | An untyped output: any JSON value, typed `unknown` in TypeScript |
| `->[List(Union(Str, Int))] @tags` | A type expression may contain balanced brackets |
| `-> [Str]  @name` | Spaces between `->`, `[Type]` and `@name` are optional |
| `->[Int] @=count` | An assignment to the existing variable `count` |

* **The arrow may appear anywhere in a line.** The rest of the line stays instruction text, and
  an arrow that is not followed by `@name` is plain text.
* **An output is declared once.** Declaring it again reports `output @notes is declared twice in this block`.
  Later mentions of `@notes` in the same block refer to that output.
* **A block may have no outputs**, like the report writer above, which only acts.
* **The model is told what to produce.** The prompt lists each input with its kind (a function
  signature, a type name, `list of 3`, `object`, `string`) and each output with its type and
  JSON Schema. Values of inputs are not in the prompt; the agent loads what it needs.
* **Agent blocks take `restrict`**, and `model`, `reasoning`, `enforce`, `forbid`, `hide` and
  `tokens` like every block. They have no `repairs` and no sampling keys.

### Agent tools

| Tool | Purpose |
| --- | --- |
| `loadVariable(name)` | Read an input of the block. A type returns its complete JSON Schema |
| `saveVariable(name, value)` | Save an output as a JSON value that fits its declared type |
| `callFunction(name, args)` | Call an input that is a function, with positional JSON arguments, and return its result |
| `getEnv(name)` | Read one environment variable; a missing variable is `null` |
| `askHuman(question)` | Ask a person and return the answer |
| `setGuidance(kind, text)` | Add `enforce` or `forbid` guidance to the model calls made by functions called later in the block |
| `readFile`, `writeFile`, `webFetch`, `webSearch`, `shell` | The [exact tools](Language.md#exact-tools), within the active restrictions |
| `mcp0Search`, ... | [MCP tools](CLI.md#mcp-servers), named `mcp<Index><Tool>` |

* **An agent reaches only what the block mentions.** `loadVariable` and `callFunction` accept
  the names referenced in the instruction and nothing else:
  `@secret is not referenced in this block; an agent reaches only the names its instruction mentions`.
  The exact tools and MCP tools are always available, within restrictions.
* **An agent saves only declared outputs.** Anything else stops the block with
  `agent tried to save @total, which is not an output of this block (outputs: @count); declare it with -> @total`.
* **Tools run at once.** Each call executes immediately and returns its real result to the same
  agent session. Completed actions are never repeated.
* **A tool error stops the block,** with its own status code. The model cannot retry a failed
  call. The one exception is a rejected save, described next.
* **Functions keep their failures.** An error thrown by a function the agent called is reported
  with that function's line.

### Outputs and corrections

A saved value is passed to [`Type.coerce`](Language.md#parse-and-coerce) of the output's type.

* **An invalid save goes back to the agent** with the path of the problem, for example
  `fib10: expected Int, got "fifty-five"`. The agent may correct the value and save again, up
  to 2 times per output. After that the block fails with `validation_failed`:
  `@fib10 is still invalid after 2 corrections: ...`.
* **Every output must be saved.** A block that finishes without one fails with
  `agent did not produce @fib10`, also `validation_failed`. A prose reply saves nothing.
* **Untyped outputs are not checked.** Code decides what to make of them:

`answer.spl`

```spl
//*
# Check an untyped answer in code

An output without a type is saved as plain JSON, typed `unknown`: code decides what to make of it.

    spl run examples/answer.spl
*//

---
model: gpt-6-luna
reasoning: low
---

---
mode: agent

Give an answer to everything as an integer -> @response
---

if (Int.is(response)) {
    success('Everything works as planned');
} else {
    fail('Response is not an integer');
}
```

An agent asks a person with `askHuman` when the instruction says so, as in
[color-poem.spl](../lang/examples/color-poem.spl). See [Human in the loop](Safety.md#human-in-the-loop).

## Codegen blocks

A codegen block asks the model for JavaScript functions and declares them as constants.

```spl
---
mode: codegen

Sieve of Eratosthenes that returns the primes up to a given number -> @sieve(limit: number): number[]
Slug of a title: lower case, words joined by single dashes -> @slugify(title: string): string
---

log(sieve(30), slugify('Hello, World'));
```

* **Each `->` declares a function.** `-> @slugify(title: string): string` gives its name and
  its TypeScript signature. The signature is given to the model and becomes the function's type.
  It is optional: `-> @slugify` is typed as a function of any arguments, and a signature without
  a result type returns `any`.
* **One model call.** Several `->` lines are generated together.
* **A codegen block needs a function.** Without one it reports
  `` codegen block needs a function to generate, such as `-> @slugify(text: string): string` ``.
  Generated functions are always new constants, so `@=name` is an error here.
* **Only function declarations are accepted.** The reply must contain function declarations and
  nothing else; helpers are allowed. One enclosing code fence is removed. Imports, exports and
  other top-level statements are rejected with `invalid_format`, as is a reply that does not
  declare a requested function.
* **Generated code sees the library** and the values the block references. Nothing runs until
  the workflow calls a function.

Generated code is cached beside the workflow:

* **The file is `<workflow>.<function>.js`**, such as `codegen.sieve.js`, named after the first
  function of the block. Its first line is a comment with the SHA-256 hash of the block's text.
* **Later runs reuse it.** A run looks for a sibling `<workflow>.*.js` file whose first line
  matches the block's text and uses it without a model call.
* **A new description gets a new file.** If the name is taken by code for another description,
  twelve digits of the hash are added to the name instead of overwriting the file.
* **The files are editable JavaScript.** Review generated code before trusting it. To generate
  again, change the description or delete the file. A matching file that does not hold the
  requested functions fails; it is not silently regenerated.
* **A trace records the code.** Replaying a [trace](CLI.md#traces-and-replay) uses the recorded
  code, whatever happened to the cache files since.

In code, `await codegen(description, options?)` generates from a description and resolves to
its first function. Options are `model`, `reasoning`, `hide` and `tokens`, and a type argument
gives the function its type, as [codegen.spl](../lang/examples/codegen.spl) shows.

## New or updated variables

An output declares a new `const` in the enclosing scope. To assign an existing `let` instead,
put `=` before the name: `outputVar: =result` in an ask block, `->[Int] @=count` in an agent block.

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

* **The variable must exist** and accept the output's type. TypeScript checks both in `spl check`.
* **An assigned variable can also be read.** It has a value before the block runs, so
  `Increment the number @i by one ->[Int] @=i` passes `i` in and assigns the result.
* **Loops need it.** A `const` declared by a block inside a loop body is gone when the iteration
  ends. Assign a variable declared outside to keep the value, as `response` is here.

## Calls in code: ask and agent

`await ask(prompt)` returns the model's answer and `await agent(prompt)` lets the model act
first. Use them where a prompt is built by code: in a loop, in a helper function, in a module.

```ts
const draft = await readFile('./draft.md');
const title = await ask(`Suggest a title for: ${draft}`);
const tagline = await ask`A tagline for ${title}`;
const report = await restrict({ fs: './src', exec: 'npm' }, () =>
    agent('Run the tests, fix the failing source file, and describe the fix'));
```

* **Each call starts a fresh conversation.** Pass context explicitly, usually through a template
  literal. The tagged-template form takes no options; interpolated objects are rendered as JSON.
* **`ask` has no tools.** It cannot read files, browse or run commands.
* **`agent` acts with the exact tools** (`readFile`, `writeFile`, `webFetch`, `webSearch`,
  `shell`) and any configured MCP tools, within active restrictions. It has no access to
  variables; that is what an agent block adds. A tool error is returned to the model, which may
  try something else, but a blocked action stops the call with `restriction_violation`.
* **Agents never use repairs,** so a failed check never repeats their actions.

Model responses stream into the terminal view while the model is working, including available
reasoning. `hide: true` suppresses reasoning, not responses. These are previews: JSON parsing,
conversion and repairs use the completed response, never partial chunks. Traces keep complete
responses rather than streaming chunks.

## Options

`ask` and `agent` take an options object as the second argument. Values are validated before
the call; an unknown name or an invalid value is a `runtime_error` and no model is contacted.

| Option | Values | Effect |
| --- | --- | --- |
| `len` | `'word'` `'sentence'` `'paragraph'` `'long'` | Length hint (guidance only) |
| `fmt` | see [Output formats](#output-formats) | Parse and check the answer |
| `schema` | A [type](Language.md#types) or JSON Schema draft-07 | Convert or validate the answer; implies JSON |
| `repairs` | `0` to `5` | Extra attempts after a format or validation error; not for `agent` |
| `reasoning` | `'none'` `'low'` `'medium'` `'high'` `'max'` | [Reasoning level](#models-and-reasoning) |
| `hide` | `true` or `false` (default) | Suppress reasoning display when `true`; responses remain visible |
| `model` | Model id | Model for this call |
| `tokens` | Positive safe integer | Maximum generated tokens per model turn, including reasoning |
| `seed` | Integer `0..2147483647` | `ask` only: request repeatable [sampling](#sampling) where supported |
| `temperature` | Number `0..2` | `ask` only: control sampling variability |
| `topP` | Number `0..1` | `ask` only: control nucleus sampling |

```ts
const issue = await readFile('./issue.txt');
const score = await ask(`Rate this issue from 1 to 5: ${issue}`, {
    fmt: 'integer',
    repairs: 1,
    tokens: 2048,
});
```

`tokens` is a hard generation budget, not a length hint or a separate thinking budget.
The same limit applies independently to every repair attempt and every agent turn.
Omitting it keeps provider defaults. It maps to OpenAI `max_output_tokens`
(or `max_completion_tokens` for seeded calls), Anthropic `max_tokens`, and Google `maxOutputTokens`.
On Anthropic models that think with a fixed budget, `tokens` must exceed that budget;
conflicting settings fail rather than silently enlarging the budget.
If the model hits its token limit, the call fails with `llm_error`, not a successful partial
answer, and repairs do not retry the truncated turn. Explicit budgets are part of the recorded
request, so changing a budget cannot silently reuse an old answer during replay.

## Models and reasoning

The model of a call is chosen in this order:

1. `--model` on the command line.
2. `model` in the block header or in the options of the call.
3. `model` in the [file defaults](Language.md#file-defaults).
4. The `model` given to `configure()`, for programs that use the library.
5. The provider's default.

OpenAI, Anthropic and Google are supported through their official clients; use bare model ids
or `provider/model`. See [Models and authentication](CLI.md#models-and-authentication).

`reasoning` sets how much the model thinks before it answers.

| Level | Meaning |
| --- | --- |
| `none` | No reasoning, or the least the model allows |
| `low`, `medium`, `high` | Increasing effort |
| `max` | The strongest effort the model offers |

* **The default is `medium`** for blocks of every mode, `ask()`, `agent()` and `codegen()`.
* **With sampling, the default is `none`.** When `seed`, `temperature` or `topP` is given and
  `reasoning` is not, the call runs without reasoning.
* **Precedence:** the block or call, then the file default, then the default above.
* **An unsupported level falls back** to the nearest level the model supports, with a warning
  that names the level used: `model '<id>' does not support reasoning 'medium'; using 'high'`.
* **A model without reasoning** ignores a requested level with the warning
  `model 'gpt-4.1' does not support reasoning 'high'; using the model default`.

| Provider | `low` to `high` | `max` | `none` |
| --- | --- | --- | --- |
| OpenAI | Reasoning effort | The highest effort the model has | No reasoning, or the lowest effort of models that cannot turn it off |
| Anthropic | Adaptive thinking effort; on older models a thinking budget of 1024, 4096 or 16384 tokens | The `max` effort, or a 32768-token budget | Thinking disabled, or the least thinking the model allows |
| Google | Thinking level; on Gemini 2.5 the same budgets as Anthropic, capped by the model | `high`, or the model's largest budget | A zero budget or the minimum level; Pro models cannot disable thinking |

The effective provider, model and reasoning effort of each call are logged at info level and
kept in traces.

## Sampling

`seed`, `temperature` and `topP` limit randomness. They are header keys of ask blocks and
options of `ask()`; agents and codegen do not accept them.

`randomness.spl`

```spl
//*
# Randomness controls

`seed`, `temperature` and `topP` limit randomness in an ask block. With sampling set, reasoning
defaults to `none`. Sampling is best-effort and does not guarantee identical responses.

    spl run examples/randomness.spl
*//

---
model: gpt-6-luna
---

const recipes: string[] = [];

for (let attempt = 0; attempt < 2; attempt++) {
    ---
    outputVar: recipe
    seed: 13
    temperature: 0
    topP: 0.0001
    tokens: 1024

    <most-frequent>give a recipe for an apple pie</most-frequent>
    ---
    recipes.push(recipe);
}

---
outputVar: similar
outputType: Bool

Are the two recipes in @recipes semantically at least 95% similar?
---

if (!similar) fail('Not similar');
success('It works');
```

Omitted sampling settings use provider and model defaults; no seed, temperature or `topP` is
invented. The same values are reused for every repair attempt.

* **Sampling turns reasoning off by default,** as described above, because most providers do
  not combine the two.
* **Asking for both can fail.** An explicit `reasoning` other than `none`, combined with
  sampling on a provider that rejects the pair, is an `llm_error` when the call is made. It
  names both settings:
  `reasoning 'high' cannot be combined with temperature on openai/gpt-6-luna; drop one of the two settings`.
* **Without explicit reasoning, unsupported settings are dropped** with a warning, and the call
  goes ahead.

Provider notes:

* **OpenAI:** seeded calls use Chat Completions, which accepts `seed`; unseeded calls use the
  Responses API. Chat Completions does not expose reasoning summaries, so they are omitted
  with a warning. Reasoning models accept `temperature` and `topP` only with reasoning `none`,
  and models that cannot turn reasoning off never do.
* **Google:** the Generate Content API receives `seed`, `temperature` and `topP`. A fixed seed
  with low temperature and a small nucleus is best-effort repeatability, not a guarantee.
* **Anthropic:** seeds are unsupported. Temperature is capped at `1` with a warning. Where both
  are accepted, set either temperature or `topP`; if both are supplied, temperature wins.
  Models that are thinking, and the newest models, do not accept either.

The info log of each call shows the settings the provider adapter kept; `null` means the
setting was omitted or unsupported and provider defaults apply. Traces include the requested
sampling settings in the request identity.

Even extreme settings cannot guarantee identical outputs from hosted models. Use
[`--trace`](CLI.md#traces-and-replay) for deterministic replay.

## Output formats

`fmt` is an option of `ask()` and `agent()` for answers that need no type.

| `fmt` | Accepts | JavaScript result |
| --- | --- | --- |
| `'text'` (default) | Trimmed text, no parsing | `string` |
| `'integer'` | JSON number without a fraction | `number` |
| `'float'` | Any finite JSON number | `number` |
| `'boolean'` | JSON `true` or `false` | `boolean` |
| `'array'` | JSON array | `Array` |
| `'object'` | JSON object (not an array) | plain object |
| `'json'` | Any JSON value | any JSON value |

One enclosing code fence is removed; other prose around the JSON is rejected. A malformed or
wrong-typed answer raises `invalid_format`.

## Types, schemas and repairs

`schema` in `ask()` is what `outputType` is in an ask block. It accepts a
[type](Language.md#types) or raw JSON Schema.

```ts
const Label = Enum('bug', 'feature', 'question');
const Triage = Struct('Triage', {
    label: Label,
    reason: Str.describe('One-sentence explanation'),
});

const issues = (await readFile('./issues.txt')).split('\n');
const triage = await ask(`Classify: ${issues[0]}`, { schema: Triage, repairs: 2 });
assert(triage.label !== 'bug' || triage.reason.length > 0, 'bugs need a reason');

const batch = await ask(`Classify each issue: ${JSON.stringify(issues)}`, { schema: List(Triage) });
log(batch.length);
```

* **With a type,** the reply is parsed as JSON and passed to `Type.coerce`: plain objects for
  structs, instances for class types. Struct fields are exact and required, including nullable
  fields. A mismatch raises `validation_failed` with the path of the offending field.
* **Annotations are advice** for the model only; they never reject a value.
* **Raw JSON Schema is validated strictly** with Ajv and returns the JSON value, for when
  constraints such as `minimum` must be enforced:

```ts
const issue = await readFile('./issue.txt');
const rating = await ask(`Rate this issue from 1 to 5: ${issue}`, {
    schema: { type: 'integer', minimum: 1, maximum: 5 },
});
```

`repairs: n`, as a header key or an option, allows up to `n` more attempts. Each sends the
original prompt again, followed by the previous answer and the validation error.

* **Only `invalid_format` and `validation_failed` are repaired.** Transport and tool errors are not.
* **Repairs need a type other than `Str`,** or a `fmt` other than `'text'`: a text answer has
  nothing to check. The combination is a `runtime_error`.
* **Conversion comes first.** `Type.coerce` already accepts numeric strings, JSON text and
  similar near misses without a model. A repair is spent only on answers it cannot convert.
* **Business rules are code.** Put them in `assert`, after the block or the call.

## Guidance: enforce and forbid

Guidance adds instructions to model calls. It shapes prompts; it does not check answers.

`enforce.spl`

```spl
//*
# Guidance in code and in blocks

`enforce()` adds an instruction to every model call made inside its callback.
The `enforce` header key does the same for one block.

    spl run examples/enforce.spl
*//

const answer = await enforce('Answer in Chinese', () =>
    ask('Short office story', { tokens: 256, model: 'gpt-6-luna' }));

---
model: gpt-6-luna
enforce: Answer in Polish
outputVar: polishAnswer

Translate this story: @answer
---

success([answer, polishAnswer]);
```

| Where | Applies to |
| --- | --- |
| `enforce:` and `forbid:` in a block header | That block, and the model calls of functions its agent calls |
| `enforce:` and `forbid:` in the file defaults | Every model call of the file |
| `enforce(text, body)` and `forbid(text, body)` in code | Every model call made while `body` runs, including blocks inside it |
| The agent tool `setGuidance` | Model calls made by functions the agent calls afterwards |

`enforce(text, body)` and `forbid(text, body)` return what `body` returns, and the guidance
follows the call across `await` and into the functions it invokes. `text` is a string or a list
of strings. Guidance from all four places combines.

```ts
const answer = await enforce('Answer in English', () =>
    forbid('jokes', () => ask('Explain recursion', { len: 'sentence' })));
```
