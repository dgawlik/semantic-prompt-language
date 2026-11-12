# Guards & failures

Model output varies, so SPL makes checks explicit: `restrict` limits actions, `assert` and schemas
check data, failures can be caught, and `human` hands decisions to a person.

## Restrictions

`await restrict(spec, body)` limits what tools and agents may touch while `body` runs, and
resolves to what `body` returns. Outside any restriction, tools and agents are allowed by
default. A blocked action raises `restriction_violation`.

| Spec | Allows |
| --- | --- |
| `restrict('./out', body)` or `restrict({ fs: './out' }, body)` | Files inside the folder only |
| `restrict({ net: 'api.example.com' }, body)` | Only these hosts (`*.example.com` matches subdomains) |
| `restrict({ exec: 'npm,git' }, body)` | Only these executables |
| `restrict({ mcp: 'docs/search' }, body)` | Only these MCP servers (`docs`, `docs/*`) or tools (`docs/search`) |

Each value is a comma-separated string or a list of strings. One object can combine several
kinds. Nested restrictions of the same kind intersect, so a scope can only narrow.

```js
const review = await restrict({ fs: './src', exec: 'git', net: 'docs.example.com' }, () =>
    agent('Review the changes in git diff and check them against the docs'));
```

The restriction follows the call: it applies to everything `body` does, including functions it
calls and code after an `await`, and ends when `body` settles.

What is checked:

* **Files**: paths are resolved against `--cwd`, including `..` and symbolic links, before checking.
* **Network**: every redirect hop is checked. `webSearch` uses `html.duckduckgo.com`, so list that
  host to search inside a `net` restriction.
* **Commands**: every executable in pipelines and chains, plus path-like arguments, URLs and
  redirections. Programs with their own I/O (build tools, package managers) are limited by name
  only; this is not an OS sandbox.
* **MCP**: tools outside the scope are hidden from the agent and rejected if requested.
  MCP servers themselves are trusted and not sandboxed.

Models are told the active restrictions, and the runtime enforces them on every call.
`ask` and `think` have no tools at all.

**Restrictions govern the library, not Node.js.** `readFile`, `writeFile`, `webFetch`,
`webSearch`, `shell`, agents and MCP tools are checked. Code that calls `node:fs`, `fetch` or
`child_process` directly is not: inside `restrict('./out', ...)`, `fs.writeFileSync('/etc/x')`
still runs. Use the library tools wherever a restriction should apply.

For a blockquote, use `@CTL(restrict={fs: ['./src'], exec: ['git']})` at its start.
The runtime applies these restrictions before the agent runs, including to functions it calls
and MCP tools, then restores the previous scope. See [controls](LLM-commands.md#controls).

## Assertions, fail and success

```js
const subtotal = 10;
const total = 12;
assert(total >= subtotal, 'total is smaller than subtotal');
if (total > 1000) fail('needs manual approval');
success(total);
```

* `assert(condition, message?)` raises `assertion_failed` when the condition is falsy.
* `fail(reason)` raises `explicit_failure`.
* `success(value?)` ends the document immediately, even from inside a function. The CLI prints
  the value on stdout: strings as they are, everything else as JSON. A document that finishes
  without `success` succeeds and prints nothing.

All three work by throwing, so the statements after `fail` or `success` do not run.

## Failure payload

Every failure has the same shape. Uncaught failures are printed to stdout and exit with code 1.

```json
{
  "status": "failure",
  "reason": "$.lines[2].quantity: expected int, got \"two\"",
  "command": "const invoice = await ask(prompt, { schema: Invoice });",
  "line": 12,
  "status_code": "validation_failed"
}
```

`line` is the document line that caused the failure and `command` is that line, trimmed. The
line is read from the stack trace: the innermost frame that lies in workflow code. A failure
inside an imported module therefore points at the workflow line that called into it. When no
workflow frame is available, as for an agent's own tool call, the first line of the running
fence or blockquote is reported.

| `status_code` | Cause |
| --- | --- |
| `invalid_format` | Answer is not valid JSON of the requested `fmt`; generated code is not function declarations |
| `validation_failed` | A value does not match its type or schema |
| `assertion_failed` | An `assert` was false; invalid input to the Markdown builder |
| `explicit_failure` | `fail` was called |
| `restriction_violation` | An action was blocked by `restrict` |
| `tool_error` | Missing file, HTTP failure or nonzero shell exit |
| `llm_error` | Authentication, timeout, transport, token limit or model access problem |
| `runtime_error` | An uncaught JavaScript exception, an invalid option or argument, a missing human handler, a replay mismatch of a pinned workflow |

Syntax errors are different: they are found before anything runs, cannot be caught, and exit
with code 2.

## try / catch

Failures are `Failure` objects and can be caught like any exception.

```js
let data = '';
try {
    data = await readFile('optional.txt');
} catch (error) {
    if (!(error instanceof Failure)) throw error;
    log(`${error.statusCode}: ${error.reason}`);
}
success(data);
```

| Property | Value |
| --- | --- |
| `error.statusCode`, `error.status_code` | One of the codes above |
| `error.reason`, `error.message` | The explanation |
| `error.payload()` | The JSON payload |
| `error.line`, `error.command` | The workflow line that raised the failure and its source text; `0` and `''` when the line is unknown |

Three rules keep error handling safe:

* **Rethrow what you do not handle.** `success(value)` ends the run by throwing a signal that is
  not an `Error` and not a `Failure`. A catch-all such as `catch { }` around code that calls
  `success` swallows it and the document continues. Test `error instanceof Failure`, as above,
  and rethrow everything else.
* **Uncaught exceptions become failures.** A `TypeError`, a rejected promise or an error thrown
  by an imported module ends the document as `runtime_error` with the reason `Name: message`
  and the document line that threw.
* **Nothing is rolled back.** Variables assigned and files written before the failure stay as
  they are.

## Human in the loop

`await human(question)` asks a person and resolves to their answer as a string. In normal CLI
runs, the shell prints the question on stderr and reads one line from stdin, preserving
whitespace except the line ending. Execution continues immediately, without a suspension or
repeating completed tool and model calls. Use repeatable `--human <answer>` flags to supply exact
answers in question order and skip prompting. Remaining questions prompt normally, including with
`--silent`; EOF without an answer fails the run.

Blockquote agents use the `ask_human` tool when asked in plain language. There is no special
human marker. The answer is returned to the same agent session, which may then make new model
calls and save it to a shared variable.

```js
const feedback = await human('What should change in the release notes?');
assert(feedback.trim().length > 0, 'feedback must not be blank');
```

```bash
spl review.md                                      # asks directly and continues
spl review.md --human "Make the wording clearer"    # supplies the answer without prompting
```

Embedding hosts pass a `human(question, line)` handler to `run`; without one, `human` fails with
`runtime_error`. Plain Node.js programs that use the library read stdin by default, or call the
`human` option given to `configure`.

### Resuming with a trace

```bash
spl review.md --trace run.jsonl
spl review.md --trace run.jsonl --human "Make the wording clearer"
```

The same `--trace` path automatically replays recorded decisions, tool results and answers,
then continues interrupted work. `--human` answers only questions not yet recorded; other new
questions read stdin. Completed runs replay the same result without prompts or repeating
recorded effects. Choose another JSONL file to restart.

The workspace, source, runtime and model/provider/MCP configuration must match. Arguments and accessed
environment values are retained. External files are not restored: changes made between runs stay changed.
An interrupted side effect with no recorded outcome requires manual recovery rather than an unsafe retry.
See [Traces and replay](CLI.md#traces-and-replay) for corruption handling and privacy considerations.
