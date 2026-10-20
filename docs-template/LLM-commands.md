# Generation, agents & tools

Exact I/O, model generation, and model-directed actions are different operations. SPL makes the boundary explicit so validation and retries cannot silently repeat external actions.

## Generation: `?`

`?` generates a value without runtime tools, built-in Copilot tools, or MCP access. It is a prefix operator: `?'a' + b` means `(?'a') + b`. Pass external information explicitly:

```spl
let notes = read_file('notes.txt')
let summary = ?{len='sentence'} 'Summarize these notes: {notes}'
success summary
```

Each call starts a fresh session; previous answers are not implicit conversation history. Generated text is trimmed; raw tool output is not.

## Composable modifiers

`?`, `think`, and `agent` share these modifiers. Braces are optional. Values are expressions evaluated once; names must be known and unique. Invalid names are syntax errors; invalid values are catchable runtime errors before the model call.

| Modifier | Values | Meaning |
| --- | --- | --- |
| `len` | `'word'`, `'sentence'`, `'paragraph'`, `'long'` | Prompt hint, not a hard length limit. |
| `fmt` | `'integer'`, `'float'`, `'array'`, `'object'`, `'text'`, `'boolean'`, `'json'` | Text by default; JSON when a schema is supplied and no explicit format is given. |
| `reasoning` | `'low'`, `'medium'`, `'high'` | Requested model reasoning effort. Unsupported effort logs a warning and uses the model default. |
| `show` | `True`, `False` (default) | Log available model reasoning at info level. |
| `schema` | JSON Schema dict or boolean | Validate the result; implies JSON output. |
| `repairs` | Integer `0..5`, default `0` | Additional generation attempts for format/schema errors only. Agents require zero. |
| `model` | Nonempty string | Per-call model; CLI override wins, then this modifier, then the header, then the SDK default. |

## Validated structured output

```spl
let Contract = {
    'type': 'object',
    'properties': {
        'label': {'type': 'string', 'enum': ['bug', 'feature']},
        'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
    },
    'required': ['label', 'confidence'],
    'additionalProperties': False,
}
let issue = 'The application crashes at startup.'
let result = ?{schema=Contract, reasoning='high', repairs=2} 'Classify this issue: {issue}'
assert result.confidence >= 0.5 'classification needs manual review'
success result
```

Schemas use synchronous JSON Schema draft-07 with Ajv strict mode. Types, enums, nested properties, required fields, arrays, numeric/string limits, and standard synchronous composition are supported. Unknown keywords, invalid schemas, unresolved remote references, and asynchronous schemas fail before generation. There is no coercion, default insertion, or removal of extra fields. Custom formats/plugins are not installed.

A mismatch raises `validation_failed` with field paths, for example `lines[2].quantity: must be number`. Missing fields and additional properties also identify the offending path. Schemas validate structure; ordinary `assert` statements validate business rules.

### Output formats

| Format | Required response | SPL value |
| --- | --- | --- |
| `'integer'` | A JSON number with no fractional part, such as `55`. | number |
| `'float'` | Any finite JSON number, such as `3.14` or `42`. | number |
| `'array'` | A JSON array, such as `[1, 2, 3]`. | list |
| `'object'` | A JSON object, such as `{"ok": true}`. Arrays are rejected. | dict |
| `'text'` | Plain text, trimmed without JSON parsing. This is the default. | str |
| `'boolean'` | JSON `true` or `false`, not quoted strings or Python spelling. | bool |
| `'json'` | Any JSON value, including scalars and `null`. | Parsed value |

```spl
let fib = ?{fmt='integer'} 'Fibonacci of 10?'
let pi = ?{fmt='float'} 'Pi to five decimal places?'
let colors = ?{fmt='array'} 'Three primary colors'
let joke = ?{fmt='object'} 'A joke with setup and punchline fields'
let greeting = ?{fmt='text'} 'Say hello'
let prime = ?{fmt='boolean'} 'Is 17 prime?'
```

Non-text formats use strict JSON: neither prose nor Markdown fences are extracted, and values are never coerced. Malformed output or the wrong type raises `invalid_format` and can be corrected with `repairs`. An explicit format is checked before any supplied schema. A schema cannot be combined with `fmt='text'`.

**Migration:** `fmt='object'` is now object-only. Scripts expecting lists should use `fmt='array'`, or `fmt='json'` to accept any JSON value.

### Bounded repair, not action retry

`repairs=2` permits at most three model calls: the initial call plus two corrections. Only `invalid_format` and `validation_failed` trigger correction. The next prompt contains the prior answer and validation errors. Prompt/modifier expressions are not reevaluated. Authentication, timeout, transport, tool, and restriction errors are not repaired; assertions outside the call are not repaired either.

Generation has no tools, so repair cannot repeat writes or commands. Agents reject nonzero repairs, even when they also validate their final answer against a schema.

## Think shorthand

`think` is generation-only shorthand with default medium reasoning. It accepts exactly the same modifiers as `?`, so reasoning and structured output no longer require two separate calls.

```spl
let Contract = {'type': 'integer'}
success think{schema=Contract, reasoning='low'} 'What is 6 times 7?'
```

## Explicit agents

`agent` enables model-directed runtime tools and configured MCP tools. It defaults to medium reasoning. Restrict its capabilities deliberately; raw tools and agents are allow-by-default outside restrictions.

```spl
restrict './src', exec 'git', mcp 'docs/search' {
    let review = agent{reasoning='high'} 'Inspect source files and consult docs/search'
}
success review
```

Only agents expose tools to Copilot. Any permission request during generation is rejected and aborts the call. Agent tools still use the runtime restriction checks; unconfigured MCP servers and other Copilot tools are not approved. Agent actions are not transactional. Agents cannot be recorded or replayed.

## Scoped guidance: enforce & forbid

`enforce` adds positive guidance and `forbid` adds negative guidance for every model call inside the block. These are the language's scoped prompt-guidance keywords.

```spl
let answer = None
enforce 'Answer in English' {
    forbid 'jokes' {
        answer = ?{len='sentence'} 'Explain recursion'
    }
}
success answer
```

Guidance applies dynamically to calls made inside the block, including called functions, and unwinds afterward. Each block has a child variable scope, so declare `answer` outside and assign inside when it must remain visible.

**Guidance is not validation**

`enforce`, `forbid`, and `len` influence a prompt; they do not verify compliance. Use schemas and assertions for output guarantees, and [restrict](Restrictions.md) for runtime action checks.

## Exact raw tools

| Function | Result | Restriction |
| --- | --- | --- |
| `read_file(path)` | Exact UTF-8 contents | fs |
| `write_file(path, content)` | Write confirmation text | fs |
| `web_fetch(url)` | HTTP response body text | net |
| `web_search(query)` | Search result text | net |
| `shell(command)` | Combined stdout/stderr; nonzero exit raises tool\_error | exec, plus inspected fs/net arguments |

Arguments are positional, required strings. These functions never invoke a model, never ask it to fill missing arguments, and do not truncate raw results. Agent-facing tool text may be truncated with an explicit marker. Network and shell operations retain their normal external variability; raw means no model interpretation.

```spl
let diff = shell('git diff --staged')
let message = ? 'Draft a commit message from this diff: {diff}'
write_file('commit-message.txt', message)
success message
```

Split side effects from generation when using [record/replay](CLI.md#offline-generation-recordreplay): replay permits local reads but blocks writes, network, shell, agents, and persistent stores.
