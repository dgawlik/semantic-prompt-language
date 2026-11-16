# Guards & failures

Model output varies, so SPL makes checks explicit: `restrict` limits actions, types and `assert`
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

```ts
const review = await restrict({ fs: './src', exec: 'git', net: 'docs.example.com' }, () =>
    agent('Review the changes in git diff and check them against the docs'));
```

The restriction follows the call: it applies to everything `body` does, including blocks
inside it, functions it calls and code after an `await`, and ends when `body` settles.

An agent block sets its own restrictions with the `restrict` header key. The value is a
folder, a list of folders, or a map with the same four kinds:

```spl
---
mode: agent
restrict: { fs: ./src, exec: git, net: docs.example.com, mcp: docs/search }

Review the changes in git diff and check them against the docs -> @review
---
```

The runtime applies them before the agent starts, to its tools, to the functions it calls and
to MCP tools, and drops them when the block ends. They intersect with restrictions that are
already active. `restrict` is a key of agent blocks only: ask and codegen blocks have no tools.

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

**Restrictions govern the library, not Node.js.** `readFile`, `writeFile`, `webFetch`,
`webSearch`, `shell`, agents and MCP tools are checked. Code that calls `node:fs`, `fetch` or
`child_process` directly is not: inside `restrict('./out', ...)`, `fs.writeFileSync('/etc/x')`
still runs. Use the library tools wherever a restriction should apply.

## Assertions, fail and success

```ts
const subtotal = 10;
const total = 12;
assert(total >= subtotal, 'total is smaller than subtotal');
if (total > 1000) fail('needs manual approval');
success(total);
```

* `assert(condition, message?)` raises `assertion_failed` when the condition is falsy. In
  TypeScript it also narrows the type of what it tested.
* `fail(reason)` raises `explicit_failure`.
* `success(value?)` ends the workflow immediately, even from inside a function. The CLI prints
  the value on stdout: strings as they are, everything else as JSON. A workflow that finishes
  without `success` succeeds and prints nothing.

All three work by throwing, so the statements after `fail` or `success` do not run.
In a workflow that another file [imported and called](Language.md#what-a-spl-module-exports),
`success` ends that call and `fail` rejects it.

## Failure payload

Every failure has the same shape. Uncaught failures are printed to stdout and exit with code 1.

```json
{
    "status": "failure",
    "reason": "$.lines[2].quantity: expected Int, got \"two\"",
    "command": "Extract the invoice in @text. Dates are ISO `YYYY-MM-DD`, currency is an ISO 4217 code,",
    "line": 37,
    "status_code": "validation_failed"
}
```

| Field | Value |
| --- | --- |
| `status` | Always `failure` |
| `reason` | What went wrong |
| `line` | The line of the `.spl` file that caused the failure |
| `command` | That line, trimmed |
| `status_code` | One of the codes below |
| `source` | The path of the file the failure is in. Present only when it is not the workflow that was run: an imported `.spl` file or generated code |

* **Failures in code** report the innermost line of workflow code on the call stack. A failure
  inside an imported `.js` or `.ts` module therefore points at the workflow line that called
  into it.
* **Failures of a block itself**, such as an answer that does not fit `outputType`, report the
  line of the opening `---` and the first line of the instruction, as above.
* **Failures in a function an agent called** report the line inside that function.

| `status_code` | Cause |
| --- | --- |
| `invalid_format` | An answer is not valid JSON, or not the requested `fmt`; generated code is not function declarations |
| `validation_failed` | A value does not match its type or schema; an agent did not produce an output |
| `assertion_failed` | An `assert` was false; invalid input to the Markdown builder |
| `explicit_failure` | `fail` was called |
| `restriction_violation` | An action was blocked by `restrict` |
| `tool_error` | Missing file, HTTP failure, nonzero shell exit, or an MCP tool error |
| `llm_error` | Authentication, timeout, transport, token limit or model access problem; reasoning combined with sampling that the provider rejects |
| `runtime_error` | An uncaught JavaScript exception, an invalid option or argument, a missing human handler, an agent reaching for a name its block does not mention |

Syntax errors are different: they are found before anything runs, cannot be caught, and exit
with code 2. Type errors are reported by `spl check` only; `spl run` does not look for them.

## try / catch

Failures are `Failure` objects and can be caught like any exception.

```ts
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
  `success` swallows it and the workflow continues. Test `error instanceof Failure`, as above,
  and rethrow everything else.
* **Uncaught exceptions become failures.** A `TypeError`, a rejected promise or an error thrown
  by an imported module ends the workflow as `runtime_error` with the reason `Name: message`
  and the line that threw.
* **Nothing is rolled back.** Variables assigned and files written before the failure stay as
  they are.

A block is a statement, so it can stand inside `try` like any call:

```spl
let summary = '';
try {
    ---
    outputVar: =summary
    tokens: 256

    Summarize @args in one sentence.
    ---
} catch (error) {
    if (!(error instanceof Failure)) throw error;
    summary = `no summary: ${error.reason}`;
}
success(summary);
```

## Checked model output

Each layer checks something different. Use the first that fits and add code for the rest.

| Layer | What it does | When it fails |
| --- | --- | --- |
| `outputType`, `->[Type] @name`, `schema` | Converts the answer with [`Type.coerce`](Language.md#parse-and-coerce) and checks its shape | `validation_failed` with the path of the bad field |
| `repairs` in ask blocks and `ask()` | Sends the answer and the error back to the model, up to 5 times | The last error is raised |
| Corrections in agent blocks | Returns an invalid save to the agent, up to 2 times per output | `validation_failed` |
| `assert` in code | Checks business rules: totals, ranges, cross-references | `assertion_failed` |
| `enforce`, `forbid`, annotations | Advise the model; they check nothing | Never |

Agents get no repairs: a failed check never repeats their actions. A tool error stops an agent
block at once instead of being retried.

## Human in the loop

`await human(question)` asks a person and resolves to their answer as a string.

`human-review.spl`

```spl
//*
# Human review

Drafts an announcement, asks a reviewer directly in the shell, then applies the feedback.
Supply `--human` to answer without prompting:

    spl run examples/human-review.spl
    spl run examples/human-review.spl --human "Make the wording clearer"

To record and automatically resume the same run:

    spl run examples/human-review.spl --trace run.jsonl
    spl run examples/human-review.spl --trace run.jsonl --human "Make the wording clearer"

Completed runs replay without prompts or side effects. Choose another JSONL file to restart.
*//

---
model: gpt-6-luna
---

const changes = await readFile('./examples/data/product-update.md');

---
outputVar: draft

Draft a two-sentence English release announcement for these changes: @changes
---

await restrict('./out', () => writeFile('./out/review-draft.txt', draft));
const feedback = await human(`Reply "ok" to accept this draft, or describe what to change:\n\n${draft}`);
let final = draft;

if (feedback.trim().toLowerCase() !== 'ok') {
    ---
    outputVar: =final

    Rewrite @draft applying this feedback: @feedback
    ---
}

await restrict('./out', () => writeFile('./out/announcement.txt', final));
success({ draft, feedback, final });
```

* **In a terminal,** the question appears in the status box of the
  [terminal view](CLI.md#terminal-view) and you type the answer there.
* **With redirected logs,** the shell prints the question on stderr and reads one line from
  stdin, preserving whitespace except the line ending.
* **`--human <answer>`** supplies exact answers in question order and skips prompting.
  Remaining questions prompt normally, including with `--silent`. Reaching the end of stdin
  without an answer fails the run.
* **Agents ask with the `askHuman` tool** when the instruction says so, as in
  `Ask the human "Apply these labels? (yes/no)" ->[Str] @approved`. The answer is returned to
  the same agent session. An agent is told never to invent an answer.

Execution continues immediately after an answer, without a suspension and without repeating
completed tool and model calls.

Programs that [embed the runtime](CLI.md#embedding) pass a `human(question, line)` handler to
`run`; without one, `human` fails with `runtime_error`. Node.js programs that use the library
read stdin by default, or call the `human` option given to `configure`.

### Resuming with a trace

```bash
spl run review.spl --trace run.jsonl
spl run review.spl --trace run.jsonl --human "Make the wording clearer"
```

The same `--trace` path automatically replays recorded decisions, tool results and answers,
then continues interrupted work. `--human` answers only questions not yet recorded; other new
questions are asked as usual. Completed runs replay the same result without prompts or
repeating recorded effects. Choose another JSONL file to restart.

The working directory, source, runtime and model/provider/MCP configuration must match. Arguments
and accessed environment values are retained. External files are not restored: changes made
between runs stay changed. An interrupted side effect with no recorded outcome requires manual
recovery rather than an unsafe retry. See [Traces and replay](CLI.md#traces-and-replay) for
corruption handling and privacy considerations.
