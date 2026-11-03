# Natural language & models

Blockquotes let you write a step in plain language; `ask`, `think` and `agent` call the model from code.
This page covers both, and how to check what comes back.

## Blockquotes

A blockquote is an agent command, not code to compile into SPL. The model sees the instruction,
visible bindings and function signatures, active guidance and restrictions, and the available tools.
It acts directly on the shared document scope through tool calls.

```markdown
> Summarize @notes in one sentence and save it to @summary
```

For a simple generation task, the comparable code is:

```spl
let summary = ask(len='sentence') 'Summarize: {notes}'
```

Blockquotes have these tools in addition to configured MCP tools:

| Tool | Purpose |
| --- | --- |
| `load_variable(name)` | Read a shared variable or read-only `$args` |
| `save_variable(name, value, schema?)` | Create or update a shared JSON value; optionally validate a JSON Schema before saving |
| `call_function(name, args)` | Invoke an existing SPL function or builtin with positional JSON arguments |
| `get_env(name)` | Read one read-only environment value; missing values return `null` |
| `ask_human(question)` | Ask for human input and return the answer directly |
| `read_file`, `write_file`, `web_fetch`, `web_search`, `shell` | Use the existing exact runtime tools |
| `restrict(kind, value)` | Narrow restrictions for the rest of the command, including function and MCP calls |
| `set_guidance(kind, text)` | Add `enforce`/`forbid` guidance for this command and its nested model calls |
| `success(value)`, `fail(reason)` | End the whole document |

These shared-scope tools are specific to blockquotes. Explicit `agent` expressions retain their
existing runtime/MCP tool set; `ask` and `think` still have no tools.

`@name` marks a binding or operation (`@notes`, `@success`, `@read_file`), not text substitution.
Plain language works too. Common conventions guide the agent's tool choices:

| Marker | Agent behavior |
| --- | --- |
| `@ENFORCE text` / `@FORBID text` | Follow prompt guidance; use `set_guidance` for nested model calls |
| `@RESTRICT fs['./src'] exec['git']` | Narrow the command's restrictions with `restrict` |
| `@validate[Schema]` | Load `Schema` and validate the value before saving; invalid values stop the command |
| `@HUMAN question` | Call `ask_human`; the shell prompts or consumes the next `--human` answer |
| `@SUCCESS`, `@fail` | End the document |

Each runtime tool call executes immediately in the interpreter and returns its real result to the
same agent session. Tools run sequentially, not through a deferred action queue. Saving a variable takes effect immediately;
prose replies do not create bindings. Functions retain their normal lexical scope and runtime guards.
Any runtime or MCP tool error stops the command immediately, preserving the original failure.
The model cannot continue or retry after a failed action; completed external actions are not repeated.
Follow important steps with an `spl` check:

```spl
assert len(summary) < 300 'summary is too long'
```

`--check` validates syntax only; it cannot validate a blockquote's intent. `--trace` records the
agent's decisions and runtime tool results. Replay restores shared-variable changes and function
execution without repeating agent-owned external effects or contacting MCP. Generation-only
`--record` cannot record blockquotes. Run only trusted documents.
Old traces containing submitted SPL are incompatible with agent commands; record a new trace.

Human input prompts directly in the shell and returns the answer to the same agent session.
Repeat `--human <answer>` to answer questions in order without prompting. The explicit
`--checkpoint`/`--resume` workflow remains available for automation: completed decisions and effects
are replayed from the journal after `--resume`, then the agent receives the answer and continues.
See [Human input](Safety.md#human-in-the-loop).

## Generation: ask and think

`ask prompt` returns the model's answer as a value. `think` is the same with medium reasoning by default,
unless prefixed with [`randomness(...)`](#randomness-controls).
Neither has tools: they cannot read files, browse or run commands.

```spl
let title = ask 'Suggest a title for: {draft}'
let plan = think(reasoning='high') 'Plan the migration of {service}'
```

Each call starts a fresh session. Pass context explicitly, usually through interpolation.

Model responses stream into the interactive CLI view and notebook cell outputs while the model
is working, including available reasoning by default. `hide=True` suppresses reasoning, not responses.
These are previews: variables, JSON parsing,
schema validation and repairs use the completed response, never partial chunks. Failures and cancelled
turns do not turn partial output into a successful result. Traces and recordings retain complete
responses rather than streaming chunks; replay does not manufacture token timing.

Embedded integrations can use `LoggerOptions.streamSink` for request-scoped `ModelStreamEvent`
updates and completion/failure notifications. Backend callers can supply `LlmRequest.onStream`.
Updates identify a response or reasoning channel and an SDK message ID: append chunks with
`mode: 'append'`, replace content with `mode: 'replace'`, and reset the preview when the message
ID changes. Ordinary event/string sinks still receive complete transcripts; `LlmResponse.text`
is always the authoritative return value.

## Agents

`agent prompt` lets the model act with the runtime tools (`read_file`, `write_file`, `web_fetch`,
`web_search`, `shell`) and any configured MCP tools. Actions are checked against active restrictions.
Agents default to medium reasoning unless prefixed with [`randomness(...)`](#randomness-controls),
and never use repairs, so a failed check never repeats their actions.

```spl
let report = ''
restrict './src', exec 'npm':
    report = agent 'Run the tests, fix the failing source file, and describe the fix'
```

## Modifiers

All three commands take named modifiers in parentheses before the prompt. Values are expressions,
evaluated once and validated before the call. Unknown or duplicate names are syntax errors.

| Modifier | Values | Effect |
| --- | --- | --- |
| `len` | `word` `sentence` `paragraph` `long` | Length hint (guidance only) |
| `fmt` | see [Output formats](#output-formats) | Parse and check the answer |
| `schema` | JSON Schema draft-07 | Validate the answer; implies JSON |
| `repairs` | `0`–`5` | Extra attempts after a format or schema error |
| `reasoning` | `low` `medium` `high` | Reasoning effort, if the model supports it |
| `hide` | `True` `False` (default) | Suppress reasoning display when `True`; responses remain visible |
| `model` | model id | Per-call model |

The former `show` modifier is no longer accepted. Omit `show=True` (reasoning is now visible
by default), and replace `show=False` with `hide=True`.

```spl
let score = ask(
    fmt='integer',
    repairs=1,
) 'Rate this issue from 1 to 5: {issue}'
```

Model precedence: CLI `--model`, then the per-call `model`, then frontmatter `model`, then the
provider default. OpenAI, Anthropic and Google are supported through Vercel AI SDK; use bare
model IDs or `provider/model`. See [Models and authentication](CLI.md#models-and-authentication).

## Randomness controls

Prefix `ask`, `think` or `agent` with `randomness(...)` to control sampling independently of the
command's existing modifiers:

```spl
let answer = randomness(seed=42, temperature=0, top_p=0.01) ask 'Answer precisely'
let plan = randomness(temperature=0) think(reasoning='high') 'Plan the migration'
let result = randomness(top_p=0.1) agent 'Inspect the project and summarize'
```

Parameters are optional named expressions, evaluated once, left to right, before command modifiers
and the prompt. The same values are reused for every repair attempt and agent tool-continuation turn.
Omitted sampling controls use provider/model defaults; no seed, temperature or `top_p` is invented.
This prefix applies only to its immediately following generation expression,
not to surrounding code or Markdown blockquotes.

The prefix, including `randomness()`, disables thinking by default where the model supports it.
It replaces the implicit medium reasoning of `think` and `agent`; an explicit
`reasoning='low'`, `'medium'` or `'high'` always takes precedence. Models that cannot disable thinking
use the SDK's lowest supported thinking setting with a compatibility warning. Calls without the
prefix retain their existing reasoning behavior.

| Parameter | Accepted values | Meaning |
| --- | --- | --- |
| `seed` | Integer `0..2147483647` | Request repeatable sampling where the provider supports it |
| `temperature` | Finite number `0..2` | Lower values reduce variability; `0` requests greedy sampling where supported |
| `top_p` | Finite number `0..1` | Nucleus sampling; smaller values narrow token choices (`1` does not narrow them) |

Unknown/duplicate names or a prefix not followed by `ask`, `think` or `agent` are syntax errors.
Out-of-range values, booleans, strings and `None` are runtime errors before the model call.
Sampling values belong in `randomness(...)`, not in `ask(...)`/`think(...)`/`agent(...)`.

Provider limitations are diagnosed with warnings; the runtime keeps supported controls without
changing the model or API, and preserves explicitly requested reasoning:

* **OpenAI:** the existing Responses API supports temperature and `top_p` on compatible models,
  but not seeds. Compatible GPT-5.1+ and GPT-6 models accept sampling with reasoning effort `none`.
  Models that require reasoning, or calls with explicit reasoning, may remove sampling controls.
  The provider adapter diagnoses model-specific restrictions.
* **Google:** the Generate Content API receives `seed`, `temperature` and `topP`. A fixed seed
  with low temperature and a small nucleus is best-effort repeatability, not a guarantee.
  Gemini 2.5 Flash supports disabling thinking with a zero budget; Gemini 2.5 Pro and Gemini 3
  models retain their lowest supported thinking setting with a warning.
* **Anthropic:** seeds are unsupported. Temperature is capped at `1` with a warning. On compatible
  non-thinking models, set either temperature or `top_p`; if both are supplied, temperature wins
  and the adapter warns that `top_p` is ignored. Thinking and newer models may reject sampling
  altogether; unsupported controls are removed with warnings.

The response's `effective.randomness` records controls actually retained by the provider adapter.
For sampling controls,
`null` means the control was omitted/unsupported and provider defaults apply, not that a particular
default numeric value was sent.
`effective.reasoningEffort` is `none` when disabling thinking is honored, or `null` when the adapter
cannot honor that setting; `null` does not mean thinking is disabled.
Traces, recordings, checkpoints and pinned workflows include requested
sampling controls in request identity; changing them cannot silently reuse an old response.
Calls without randomness retain compatibility with existing replay files.

Even extreme settings cannot guarantee identical outputs from hosted models. Use
[`--pin`](CLI.md#pinned-workflows) for fully deterministic offline replay.
See the official [OpenAI](https://ai-sdk.dev/providers/ai-sdk-providers/openai),
[Google](https://ai-sdk.dev/providers/ai-sdk-providers/google) and
[Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic) adapter documentation.

## Semantic evaluation

`eval(expected=llm1, actual=llm2, cutoff=0.9)` compares two outputs with an LLM judge.
It is an assertion-style statement, not a function or expression:

```spl
let llm1 = ask 'Describe an apple pie'
let llm2 = ask 'Describe an apple pie in different words'
eval(expected=llm1, actual=llm2, cutoff=0.9)
success 'Similar enough'
```

All three named arguments are required and may appear in any order. Their expressions are
evaluated once, left to right. `expected` is the reference and `actual` is the candidate; both
accept strings or other JSON-compatible values, including structured model outputs.
Functions and non-finite numbers are rejected. `cutoff` must be a finite number from `0` to `1`,
inclusive; booleans and numeric strings are not accepted.

The judge scores shared meaning and details, ignoring wording and formatting differences.
`1` means equivalent content and `0` means unrelated or contradictory content. Missing,
conflicting, or unsupported details lower the score. `0.9` means 90% similarity, not a statistical
percentile. A score equal to the cutoff passes; a score below it raises `assertion_failed` with
the score and cutoff in the failure reason. The score is also logged at info level.

Each evaluation makes one generation-only `ask` call using the current document model or
CLI/embedding model override. It has no tools and does not regenerate either output.
The cutoff is checked locally, not shown to the judge. Invalid JSON or a judge score outside
`0..1` raises `invalid_format`; authentication and transport failures raise `llm_error`.
Evaluation does not retry or convert judge errors into a passing score.

Judge scores are subjective and may vary; this is not a calibrated probability or a deterministic
text metric. Traces and recordings retain the judge response, and replay rechecks the cutoff
without another model call. Pinned workflows and checkpoints also retain evaluations.

## Output formats

| `fmt` | Accepts |
| --- | --- |
| `text` (default) | Trimmed text, no parsing |
| `integer` | JSON number without a fraction |
| `float` | Any finite JSON number |
| `boolean` | JSON `true` or `false` |
| `array` | JSON array (a list) |
| `object` | JSON object (a dict, not an array) |
| `json` | Any JSON value |

Parsing is strict: prose around JSON and Markdown code fences are rejected, and values are never
coerced. A malformed or wrong-typed answer raises `invalid_format`.

## Schemas and repairs

`schema` validates the parsed answer with Ajv in strict mode: no coercion, no defaults, no removal of
extra fields. A mismatch raises `validation_failed` with field paths.

```spl
let Triage = {
    'type': 'object',
    'properties': {
        'label': {'type': 'string', 'enum': ['bug', 'feature', 'question']},
        'reason': {'type': 'string'},
    },
    'required': ['label', 'reason'],
    'additionalProperties': False,
}
let triage = ask(schema=Triage, repairs=2) 'Classify: {issue}'
assert triage.label != 'bug' or len(triage.reason) > 0 'bugs need a reason'
```

`repairs=n` allows up to `n` more attempts, each with the previous answer and the validation errors.
Only `invalid_format` and `validation_failed` are repaired; transport and tool errors are not.
The prompt is not re-evaluated. Put business rules in `assert`, after the call.

## Guidance: enforce and forbid

`enforce text:` and `forbid text:` introduce indented blocks and add instructions to every model
call inside, including calls in functions they invoke. Nested guidance combines. Guidance shapes prompts;
it does not check the answer.

```spl
let answer = None
enforce 'Answer in English':
    forbid 'jokes':
        answer = ask(len='sentence') 'Explain recursion'
```
