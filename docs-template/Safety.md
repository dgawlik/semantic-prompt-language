# Guards & failures

Model output varies, so SPL makes checks explicit: `restrict` limits actions, `assert` and schemas
check data, failures can be caught, and `human` hands decisions to a person.

## Restrictions

`restrict` limits what tools and agents may touch inside its block. Outside any restriction,
tools and agents are allowed by default. A blocked action raises `restriction_violation`.

| Clause | Allows |
| --- | --- |
| `restrict './out'` or `restrict fs './out'` | Files inside the folder only |
| `restrict net 'api.example.com'` | Only these hosts (`*.example.com` matches subdomains) |
| `restrict exec 'npm,git'` | Only these executables |
| `restrict mcp 'docs/search'` | Only these MCP servers (`docs`, `docs/*`) or tools (`docs/search`) |

Values are a comma-separated string or a list of strings. Combine clauses with commas;
nested or repeated clauses of the same kind intersect, so a scope can only narrow.

```spl
restrict './src', exec 'git', net 'docs.example.com':
    let review = agent 'Review the changes in git diff and check them against the docs'
```

What is checked:

* **Files**: paths are resolved against `--cwd`, including `..` and symbolic links, before checking.
* **Network**: every redirect hop is checked. `web_search` uses `html.duckduckgo.com`, so list that
  host to search inside `restrict net`.
* **Commands**: every executable in pipelines and chains, plus path-like arguments, URLs and
  redirections. Programs with their own I/O (build tools, package managers) are limited by name
  only; this is not an OS sandbox.
* **MCP**: tools outside the scope are hidden from the agent and rejected if requested.
  MCP servers themselves are trusted and not sandboxed.

Models are told the active restrictions, and the runtime enforces them on every call.
`ask` and `think` have no tools at all.

## Assertions, fail and success

```spl
let subtotal = 10
let total = 12
assert total >= subtotal 'total is smaller than subtotal'
if total > 1000:
    fail 'needs manual approval'
success total
```

* `assert condition 'message'` raises `assertion_failed` when the condition is false.
* `fail reason` raises `explicit_failure`.
* `success value` ends the document immediately, even from inside a function.
  `return` exits a function, or the document at top level.

## Failure payload

Every failure has the same shape. Uncaught failures are printed to stdout and exit with code 1.

```json
{
  "status": "failure",
  "reason": "lines[2].quantity: must be number",
  "command": "let invoice = ask(schema=Invoice) prompt",
  "line": 12,
  "status_code": "validation_failed"
}
```

| `status_code` | Cause |
| --- | --- |
| `invalid_format` | Answer is not valid JSON of the requested `fmt` |
| `validation_failed` | Answer does not match the schema |
| `type_error` | Known typed violation before execution, or a runtime contract violation |
| `assertion_failed` | An `assert` was false |
| `explicit_failure` | `fail` was executed |
| `restriction_violation` | An action was blocked by `restrict` |
| `tool_error` | Missing file, HTTP failure or nonzero shell exit |
| `llm_error` | Authentication, timeout, transport or replay mismatch |
| `runtime_error` | Undefined name, wrong type, invalid modifier and similar bugs |

## try / except

```spl
let data = ''
try:
    data = read_file('optional.txt')
except err:
    log("{err.status_code} on line {err.line}: {err.reason}")
success data
```

The handler gets the failure payload as a dict. Failures do not roll back earlier writes.
Syntax errors and statically known typed violations are reported before anything runs,
so they cannot be caught. Runtime contract violations can be caught; failed typed bulk
mutations leave the affected value unchanged.

## Human in the loop

`human 'question'` asks a person and returns their answer as a string. In normal CLI runs, the shell
prints the question on stderr and reads one line from stdin, preserving whitespace except the line
ending. Execution continues immediately without a suspension or repeating completed tool/model calls.
Use repeatable `--human <answer>` flags to supply exact answers in question order and skip prompting.
Remaining questions prompt normally, including with `--silent`; EOF without an answer fails the script.

Blockquote agents use the `ask_human` tool for the same workflow (`@HUMAN`). The answer is returned to the
same agent session, which may then make new model calls and save it to a shared variable. Runtime
actions completed before the question are not repeated, including actions inside invoked functions.

```spl
let feedback = human 'What should change in the release notes?'
assert len(feedback.strip()) > 0 'feedback must not be blank'
```

```bash
spl review.md                                      # asks directly and continues
spl review.md --human "Make the wording clearer"    # supplies the answer without prompting
```

### Resuming with a trace

```bash
spl review.md --trace run.jsonl
spl review.md --trace run.jsonl --human "Make the wording clearer"
```

The same `--trace` path automatically replays recorded decisions, external effects and answers,
then continues interrupted work. `--human` answers only questions not yet recorded; other new
questions read stdin. Completed runs replay the same result without prompts or side effects.
Choose another JSONL file to restart. There are no separate checkpoint, resume or answer-ID flags,
JSON suspension envelopes, or waiting exit codes.

The workspace, source, runtime and model/provider/MCP configuration must match. Arguments and accessed
environment values are retained. External files are not restored: changes made between runs stay changed.
An interrupted side effect with no recorded outcome requires manual recovery rather than an unsafe retry.
See [Traces and replay](CLI.md#traces-and-replay) for corruption handling and privacy considerations.
