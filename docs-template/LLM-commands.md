# Natural language & models

Blockquotes let you write a step in plain language; `ask`, `think` and `agent` call the model from code.
This page covers both, and how to check what comes back.

## Blockquotes

A blockquote is an instruction the model translates into SPL. The model sees the text, the current
bindings and function signatures, active guidance and restrictions, and a preamble that teaches it SPL.
It must submit exactly one program, which the runtime then executes in the shared document scope,
just like a fence.

```markdown
> Summarize @notes in one sentence and save it to @summary
```

The same step written as code:

```spl
let summary = ask(len='sentence') 'Summarize: {notes}'
```

`@name` marks a binding or an operation (`@notes`, `@success`, `@read_file`). Markers are hints
for the model, not text substitution, and plain language works too. The examples use a few
conventions that the model maps onto language features:

| Marker | Becomes |
| --- | --- |
| `@ENFORCE text` / `@FORBID text` | `enforce` / `forbid` guidance around the step |
| `@RESTRICT fs['./src'] exec['git']` | a `restrict` block |
| `@validate[Schema] @retries[2]` | `schema=Schema, repairs=2` |
| `@HUMAN question` | a `human` question (needs `--checkpoint`) |
| `@SUCCESS`, `@fail` | end the document |

Generated code is ordinary SPL: it runs under the same restrictions and validation as handwritten
code, but the translation can be wrong. Before anything runs, the runtime rejects a submission that
declares a marked result with `let` inside a block (where it would vanish), and it reminds the model
once if it replies without submitting. Follow important steps with an `spl` check:

```spl
assert len(summary) < 300 'summary is too long'
```

`--check` validates syntax only; it cannot validate a blockquote's intent. Traces record the
submitted program, and replay executes it without asking the model again. Run only trusted documents.

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
