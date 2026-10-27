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
| `ask_human(question)` | Pause through checkpoint/resume and return the human's answer |
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
| `@validate[Schema] @retries[2]` | Load `Schema`, save with schema validation, and correct rejected values without repeating actions |
| `@HUMAN question` | Call `ask_human` (needs `--checkpoint`) |
| `@SUCCESS`, `@fail` | End the document |

Each runtime tool call yields control to the interpreter. It executes the action, supplies the
real result or error, and then lets the agent continue. Saving a variable takes effect immediately;
prose replies do not create bindings. Functions retain their normal lexical scope and runtime guards.
Restriction violations and explicit failures stop the command. Other tool failures are logged and
returned to the model for handling; completed external actions are not automatically retried.
Follow important steps with an `spl` check:

```spl
assert len(summary) < 300 'summary is too long'
```

`--check` validates syntax only; it cannot validate a blockquote's intent. `--trace` records the
agent's decisions and runtime tool results. Replay restores shared-variable changes and function
execution without repeating agent-owned external effects or contacting MCP. Generation-only
`--record` cannot record blockquotes. Run only trusted documents.
Old traces containing submitted SPL are incompatible with agent commands; record a new trace.

Human input uses the existing checkpoint workflow, never a terminal prompt. Completed decisions
and effects are replayed from the journal after `--resume`; the agent then receives the human's
answer and continues. It may make new model calls after the answer.

## Generation: ask and think

`ask prompt` returns the model's answer as a value. `think` is the same with medium reasoning by default.
Neither has tools: they cannot read files, browse or run commands.

```spl
let title = ask 'Suggest a title for: {draft}'
let plan = think(reasoning='high') 'Plan the migration of {service}'
```

Each call starts a fresh session. Pass context explicitly, usually through interpolation.

## Agents

`agent prompt` lets the model act with the runtime tools (`read_file`, `write_file`, `web_fetch`,
`web_search`, `shell`) and any configured MCP tools. Actions are checked against active restrictions.
Agents default to medium reasoning and never use repairs, so a failed check never repeats their actions.

```spl
let report = ''
restrict './src', exec 'npm' {
    report = agent 'Run the tests, fix the failing source file, and describe the fix'
}
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
| `show` | `True` `False` | Stream reasoning to the info log |
| `model` | model id | Per-call model |

```spl
let score = ask(
    fmt='integer',
    repairs=1,
) 'Rate this issue from 1 to 5: {issue}'
```

Model precedence: CLI `--model`, then the per-call `model`, then frontmatter `model`, then the SDK default.

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

`enforce text { ... }` and `forbid text { ... }` add instructions to every model call inside the
block, including calls in functions it invokes. Nested guidance combines. Guidance shapes prompts;
it does not check the answer.

```spl
let answer = None
enforce 'Answer in English' {
    forbid 'jokes' {
        answer = ask(len='sentence') 'Explain recursion'
    }
}
```
