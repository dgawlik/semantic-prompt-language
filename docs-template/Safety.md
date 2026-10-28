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

The handler gets the failure payload as a dict. Failures do not roll back earlier writes, and syntax
errors are reported before anything runs, so they cannot be caught.

## Human in the loop

`human 'question'` asks a person and returns their exact answer as a string. It never reads the
terminal. Instead the run saves its progress to a checkpoint journal, prints the question as JSON,
and exits with code 3. A later invocation supplies the answer and continues without repeating
completed tool or model calls.

Blockquote agents use the `ask_human` tool for the same workflow. The answer is returned to the
agent on resume, which may then make new model calls and save it to a shared variable. Runtime
actions completed before the question are not repeated, including actions inside invoked functions.

```spl
let feedback = human 'What should change in the release notes?'
assert len(feedback.strip()) > 0 'feedback must not be blank'
```

```bash
spl review.md --checkpoint run.jsonl --silent        # exits 3 and prints the question
spl review.md --resume run.jsonl                      # shows the pending question again
spl review.md --resume run.jsonl --answer-for REQUEST_ID --answer-file feedback.txt
```

The pending question looks like this:

```json
{
  "status": "waiting_for_input",
  "run_id": "run-identifier",
  "request_id": "request-identifier",
  "question": "What should change in the release notes?",
  "checkpoint": "/abs/path/run.jsonl",
  "line": 9
}
```

* Answer with the latest **`request_id`**, not the `run_id`. Each new question gets a new request ID.
* `--answer text` and `--answer-file file` are alternatives; files keep all whitespace.
* Finished runs print `{"status": "success", "run_id": ..., "value": ...}` or a failure envelope.
* Exit codes: `0` success, `1` failure, `2` usage or invalid answer, `3` waiting, `70` journal error.

Resume needs the same workspace, script, runtime, `--model`/`--mcp` options and environment. The
journal is not a snapshot: files changed in between stay changed. If a run was interrupted mid-action,
SPL refuses to guess and asks for manual recovery. Checkpoints cannot be combined with stores or
trace/replay. Journals contain prompts and answers, so keep them private.

In CI, treat exit code 3 as "waiting", publish the question to an authorized channel, and resume in
the same persistent workspace once an answer arrives.
