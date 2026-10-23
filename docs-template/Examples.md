# Examples

Start from a working script, adapt one prompt or guard, and run it again. These
examples keep explicit I/O, LLM judgment, and acceptance checks together so you can
scan the workflow and iterate without writing an orchestration layer.

Scripts from `lang/examples/` are synchronized with their executable sources. Most
run from `lang/`; test repair runs against the npm project selected by `--cwd`.
That option controls relative I/O and tool directories, not the script filename.

Authenticate before live generation or agents. Use `--model <id>` to override an unavailable example model. Default tests check every example and documentation snippet offline, including scripted triage and invoice runs. Authenticated Copilot tests require explicit `SPL_LIVE_TESTS=1`.

| Script | Shows |
| --- | --- |
| [`commit-message.spl`](#commit-message) | `shell` under `restrict exec 'git'`, validation helper, retry loop |
| [`mcp.spl`](#search-with-mcp) | Explicit agent using a configured docs/search MCP tool |
| [`triage-issues.spl`](#triage-issues) | Schema-validated classification, bounded generation repair, aggregation |
| [`extract-invoice.spl`](#extract-an-invoice) | Structured extraction cross-checked with arithmetic before it is accepted |
| [`code-review.spl`](#code-review-as-a-ci-gate) | Three-file review, structured findings, restricted report write, `fail` as a CI gate |
| [`release-notes.spl`](#release-notes) | Nested `forbid`/`enforce`, git history to a file inside `./out` |
| [`web-digest.spl`](#web-digest) | `restrict net`, `web_fetch`, catching a blocked second host |
| [`fix-failing-tests.spl`](#fix-failing-tests) | Raw npm test plus explicit repair agent, up to three rounds |
| [`translate-docs.spl`](#translate-docs) | Read once, generate translations, write exact output to script-chosen paths |
| [`journal.spl`](#journal-with-persistent-state) | State across runs with `--store` |
| [`basics`, `hi`, `live`, `restrict-live`, `tools-live`](#feature-tours) | Small feature tours |

## Commit message

Read the staged diff with raw `shell`, restricted to git. Generation itself has no tools. A deterministic validator permits at most three message attempts; it never reruns the shell command.

```bash
cd your-repo && git add -p
spl path/to/commit-message.spl
```

`commit-message.spl`

```spl
# Draft a Conventional Commit message for the staged changes.
#
#   cd your-repo && git add -p
#   spl path/to/commit-message.spl
#
# The script reads the diff with git once; tool-free generation gets at most three attempts.

let TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'perf']

def is_valid(msg) {
    let first = msg.splitlines()[0]
    if len(first) > 72 or ': ' not in first {
        return False
    }
    return first.split(':')[0].split('(')[0] in TYPES
}

let msg = ''
let attempt = 0

restrict exec 'git' {
    let diff = shell('git diff --staged')
    assert len(diff.strip()) > 0 'nothing is staged'
    forbid 'wrapping the message in quotes or code fences' {
        while attempt < 3 {
            attempt += 1
            let msg = ask '''
Write a Conventional Commit message for this diff: a subject line of at most 72 characters
("type(scope): summary", type is one of {TYPES}), then a blank line and a short body.
Reply with ONLY the message.
{diff}'''
            if msg == 'NO_CHANGES' {
                fail 'nothing is staged'
            }
            if is_valid(msg) {
                break
            }
            log("attempt {attempt}: invalid message, retrying")
        }
    }
}

assert is_valid(msg) 'could not produce a valid commit message'
success msg
```

**Pattern: deterministic validator**

The model proposes; `is_valid()` decides. The loop gives it three tries, and the final `assert` makes sure a script never succeeds with an invalid message.

## Triage issues

Classify issues against a strict schema with enum labels/priorities and required reason text. Up to two repairs correct format/schema errors, without retrying transport errors. This generation-only example supports offline record/replay.

`triage-issues.spl`

```spl
# Triage a batch of issues into labels and priorities, with validated JSON and retries.
# Schema repairs retry generation only; transport errors are not retried.

let LABELS = ['bug', 'feature', 'question', 'docs']
let PRIORITIES = ['low', 'medium', 'high']
let Triage = {
    'type': 'object',
    'properties': {
        'label': {'type': 'string', 'enum': LABELS},
        'priority': {'type': 'string', 'enum': PRIORITIES},
        'reason': {'type': 'string', 'minLength': 1},
    },
    'required': ['label', 'priority', 'reason'],
    'additionalProperties': False,
}

let issues = [
    {'id': 101, 'title': 'App crashes on startup', 'body': 'Since 2.3 the app exits with a segfault right after the splash screen on macOS.'},
    {'id': 102, 'title': 'Support dark mode', 'body': 'It would be great to have a dark theme, my eyes hurt at night.'},
    {'id': 103, 'title': 'How do I export to CSV?', 'body': 'I cannot find the export option anywhere in the menus.'},
    {'id': 104, 'title': 'Typo in install guide', 'body': 'The guide says "npm instal", should be "npm install".'},
]

def triage(issue) {
    let r = ask(schema=Triage, reasoning='low', repairs=2) '''
Classify this GitHub issue.
Title: {issue['title']}
Body: {issue['body']}
Give a one-sentence reason.'''
    return {'id': issue['id'], 'title': issue['title'], 'label': r.label, 'priority': r.priority, 'reason': r.reason}
}

let results = []
let counts = {}
for issue in issues {
    let t = triage(issue)
    results.append(t)
    if t['label'] in counts {
        counts[t['label']] += 1
    } else {
        counts[t['label']] = 1
    }
}

let urgent = []
for t in results {
    if t['priority'] == 'high' {
        urgent.append(t['title'])
    }
}

let summary = ask(len='sentence') 'Summarize this triage result for the team channel: {counts}. High priority: {urgent}.'
success {'counts': counts, 'urgent': urgent, 'results': results, 'summary': summary}
```

## Extract an invoice

Validate invoice shape with a nested schema and bounded repair, then independently check arithmetic with assertions. A business-rule failure is not automatically repaired.

`extract-invoice.spl`

```spl
# Extract structured data from messy text and cross-check it with plain arithmetic.
# Schemas validate shape; ordinary assertions validate the business rules.

let document = '''
ACME Industrial Supplies GmbH            Invoice No. INV-2026-0042
Date: 2026-03-14                          Currency: EUR

  3 x Hex bolt M8 (box of 100)        @ 12.50     37.50
  2 x Safety gloves, size L           @  8.90     17.80
  1 x Cordless drill                  @ 119.00   119.00

Subtotal 174.30   VAT 19%  33.12   TOTAL DUE 207.42
'''

let Invoice = {
    'type': 'object',
    'properties': {
        'vendor': {'type': 'string'}, 'number': {'type': 'string'},
        'date': {'type': 'string'}, 'currency': {'type': 'string'},
        'lines': {
            'type': 'array', 'minItems': 1,
            'items': {
                'type': 'object',
                'properties': {
                    'description': {'type': 'string'},
                    'quantity': {'type': 'integer', 'minimum': 1},
                    'unit_price': {'type': 'number', 'minimum': 0},
                },
                'required': ['description', 'quantity', 'unit_price'],
                'additionalProperties': False,
            },
        },
        'subtotal': {'type': 'number'}, 'total': {'type': 'number'},
    },
    'required': ['vendor', 'number', 'date', 'currency', 'lines', 'subtotal', 'total'],
    'additionalProperties': False,
}
let invoice = ask(schema=Invoice, reasoning='high', repairs=2) 'Extract this invoice: {document}'
let computed = 0
for line in invoice.lines {
    computed += line.quantity * line.unit_price
}
assert abs(computed - invoice.subtotal) < 0.01 "lines add up to {round(computed, 2)} but subtotal is {invoice.subtotal}"
assert invoice.total >= invoice.subtotal 'total is smaller than subtotal'
success invoice
```

## Code review as a CI gate

An explicit agent inspects source under filesystem and git restrictions, then tool-free generation structures its findings. The report write is restricted to `./reports`, and high-severity findings fail the CI gate. A request to only review is guidance, not a read-only filesystem capability.

```bash
spl examples/code-review.spl --cwd <project>
```

`code-review.spl`

```spl
@(model='gpt-5.6-luna')
# Two-stage code review that can gate CI: think deeply in prose, then structure the findings.
#
# Run from a project root with a ./src folder:  spl examples/code-review.spl --cwd <project>
# Exit code is 1 (failure payload on stdout) when high-severity findings exist.
# The review phase may only touch ./src; the report is written under ./reports.

let notes = ''

forbid 'suggesting purely stylistic changes' {
    restrict './src', exec 'git' {
        notes = agent(reasoning='high') '''
List source files with `git ls-files src`.
Then read the 3 files that are most likely to contain security problems or correctness bugs, and review only those.
List each finding with its location, why it matters and a suggested fix.'''
    }
}


let Review = {
    'type': 'object',
    'properties': {
        'findings': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'severity': {'type': 'string', 'enum': ['low', 'medium', 'high']},
                    'title': {'type': 'string'}, 'location': {'type': 'string'}, 'fix': {'type': 'string'},
                },
                'required': ['severity', 'title', 'location', 'fix'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['findings'],
    'additionalProperties': False,
}
let review = ask(schema=Review, repairs=2) 'Convert this review into structured findings, using an empty list when there are none: {notes}'

let lines = ["# Review of repository", '']
let high = 0
for f in review.findings {
    assert f.severity in ['low', 'medium', 'high'] "bad severity '{f.severity}'"
    if f.severity == 'high' {
        high += 1
    }
    lines.append("- **{f.severity.upper()}** {f.title} ({f.location})")
    lines.append("  - Fix: {f.fix}")
}
lines.append('')
lines.append("{len(review.findings)} finding(s), {high} high severity")

restrict './reports' {
    write_file('./reports/review.md', '\n'.join(lines))
}

if high > 0 {
    fail "{high} high severity finding(s), see ./reports/review.md"
}
success '\n'.join(lines)
```

## Release notes

Generate release notes from recent git history and save them to `./out/RELEASE_NOTES.md`. The history-reading phase restricts executable names to `git`; the separate file-writing phase restricts filesystem access to `./out`. Note how rules and restrictions nest.

`release-notes.spl`

```spl
# Generate release notes from recent git history and save them to ./out/RELEASE_NOTES.md.
# Raw git reads precede tool-free generation; the final write is restricted to ./out.

let notes = ''

restrict exec 'git' {
    forbid 'inventing changes that are not in the commit list' {
        enforce 'Group entries under: Features, Fixes, Other. Omit empty groups. Plain Markdown, no preamble' {
            let commits = shell('git log --oneline -n 40')
            notes = ask '''
Write release notes for end users from these commits (one per line: hash and subject).
Rewrite technical subjects into clear user-facing sentences and drop merge/chore noise.
{commits}'''
        }
    }
}

assert len(notes) > 20 'release notes are suspiciously short'

restrict './out' {
    write_file('./out/RELEASE_NOTES.md', notes)
}
success notes
```

## Web digest

Summarize a web page with network access limited to a single host — and prove the sandbox holds by catching a blocked request to a second host.

`web-digest.spl`

```spl
# Summarize a web page with network access limited to a single host,
# and prove the sandbox holds by catching a blocked request.

restrict net 'news.ycombinator.com' {
    let page = web_fetch('https://news.ycombinator.com')
    let headlines = ask '''
From this HTML list the 10 top stories as a Markdown bullet list: "- title (domain)".
Reply with ONLY the list.
{page}'''

    let themes = ask(len='paragraph') 'What themes run through these headlines?\n{headlines}'

    try {
        web_fetch('https://example.org')
        fail 'the request to a second host should have been blocked'
    } except err {
        assert err.status_code == 'restriction_violation' "unexpected failure: {err.reason}"
        log("blocked as expected: {err.reason}")
    }
}

success "{headlines}\n\n{themes}"
```

## Fix failing tests

Run raw `npm test` in the project selected by `--cwd`, invoke an explicit repair agent after a failure, and repeat up to three rounds. Files are restricted to the project and executable names to npm. Avoiding test edits is guidance, not a filesystem write prohibition. This workflow intentionally performs actions; review its changes. `--trace` captures its LLM calls, but replay reruns explicit tests without repeating the agent's edits, so it requires suitable external state. Legacy `--record` does not support this workflow.

```bash
spl lang/examples/fix-failing-tests.spl --cwd .
```

`fix-failing-tests.spl`

```spl
@(model='mai-code-1.1-flash')
# Keep failing tests fixed: run the suite, let the LLM repair the source, repeat (at most 3 rounds).
#
#   spl examples/fix-failing-tests.spl --cwd <your npm project>
#
# Raw test runs do not call the model. The repair agent is restricted to the project and npm.
# Avoiding test edits is prompt guidance, not a filesystem write prohibition.

let attempt = 0
let green = False


restrict '.', exec 'npm' {
    forbid 'editing or deleting test files, or weakening assertions' {
        while attempt < 3 and not green {
            attempt += 1
            try {
                shell('npm test')
                green = True
            } except err {
                log("tests failing (round {attempt}): {err.status_code}")
                agent(reasoning='medium') '''
The test run failed with this output:
{err.reason}

Find the bug in the source code (not the tests), fix it with the file tools, and describe the change in one sentence.'''
                }
            }
        }
}

assert green 'tests are still failing after 3 rounds'
success "tests pass after {attempt} run(s)"
```

**Pattern: failure as input**

A failing `npm test` is a `tool_error` whose `reason` contains the test output. Catching it turns the failure into the prompt for the next step.

## Search with MCP

Configure a trusted MCP server named `docs` exposing `search`, then run this explicit agent with `--mcp`. The exact `docs/search` selector narrows MCP access. Services are trusted; scopes limit calls, not their internal I/O. Generation-only calls never start MCP servers.

```bash
spl examples/mcp.spl --mcp mcp/mcp.json
```

`mcp.spl`

```spl
# Configure a docs MCP server exposing search, then run:
# spl examples/mcp.spl --mcp <your-mcp.json> --cwd <project>
# MCP servers are trusted services; scopes limit calls, not their internal I/O.

restrict mcp 'docs/search' {
    let summary = agent 'Use docs/search to find the documentation for this project and summarize it.'
    success summary
}
```

## Translate docs

Read the document once, generate German, Polish, and Japanese translations without tools, and write each exact response to a script-chosen path. Run from `lang/` so the source document resolves correctly. No model is responsible for choosing or confirming the output path.

```bash
spl examples/translate-docs.spl
```

`translate-docs.spl`

```spl
# Translate a document into several languages, one file each, without leaving the project folder.
# The script reads once and writes exact model responses; generation has no tools.

let locales = {'de': 'German', 'pl': 'Polish', 'ja': 'Japanese'}
let written = []

restrict '.' {
    let source = read_file('./examples/data/product-update.md')
    enforce 'Keep Markdown formatting, URLs and code identifiers untranslated' {
        for code, language in items(locales) {
            let translation = ask(reasoning='medium') 'Translate this document to {language}: {source}'
            write_file("./out/translations/product-update.{code}.md", translation)
            written.append("./out/translations/product-update.{code}.md")
        }
    }
}

success written
```

## Journal with persistent state

A rolling journal that remembers previous runs through the variable store. Top-level variables are saved on exit and reloaded on the next run, so state survives between runs.

```bash
spl examples/journal.spl --store journal.json
```

`journal.spl`

```spl
# A rolling journal that remembers previous runs through the variable store:
#
#   spl examples/journal.spl --store journal.json
#
# Top-level variables are saved on exit and reloaded on the next run, so state survives between runs.

def stored_runs() {
    try { return runs } except first_run { return 0 }
}
def stored_history() {
    try { return history } except first_run { return [] }
}
let runs = stored_runs() + 1
let history = stored_history()

let notes = read_file('./examples/data/notes.txt')
let todays = ask(len='sentence') 'Summarize these notes: {notes}'
history.append({'run': runs, 'summary': todays})
if len(history) > 5 {
    history = history[1:]
}

let trend = ''
if len(history) > 1 {
    trend = ask(len='paragraph') '''
Here are my last journal summaries, oldest first: {history}
What is changing from run to run? Be concrete.'''
}

success {'run': runs, 'today': todays, 'trend': trend}
```

## Feature tours

Small scripts that exercise one area each.

### basics.spl — functions, objects and LLM calls

Compare a computed Fibonacci number with an integer model response, then request a structured joke and a pet story. This tour includes LLM calls and requires authentication.

`basics.spl`

```spl
@(model='gpt-6-luna')

def fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}

let fib10 = fib(10)
let modelFib10 = ask(fmt='integer') 'fibonacci of 10 is?'

assert fib10 == modelFib10 'Oops model got it wrong'

let joke = ask(fmt='object') 'A joke about programmers as {{"setup": ..., "punchline": ...}}'

let animal = None
enforce 'Answer in Chinese' {
    forbid 'Mentioning the word cat' {
        animal = ask(len='paragraph') 'Funny story involving a pet animal'
    }
}

success {'fib': fib10, 'modelFib': modelFib10, 'animal': animal, 'joke': joke}
```

### hi.spl — compact end-to-end tour

Use `gpt-5.5` for a structured joke, reasoning and a greeting, then write the deterministic value `fib(10)` under `./out`.

`hi.spl`

```spl
@(model='gpt-5.5')

def fib(n) {
    if n < 2 { return n }
    return fib(n - 1) + fib(n - 2)
}

# an LLM call, validated and parsed as JSON
let joke = ask(len='sentence', fmt='object') 'A joke about programmers. Give setup and punchline.'

# deliberate before answering
let why = think(reasoning='high') 'Why is {joke.setup} funny?'

# Prompt guidance for calls inside the block (not runtime validation).
let hi = None
enforce 'Answer in English' {
    forbid 'profanity' { let hi = ask 'Say hi' }
}

# Raw I/O does not call the model.
restrict './out' {
    write_file('./out/a.txt', '{fib(10)}')
}

try { assert fib(5) == 5 'wrong' } except err { log(err.reason) }
success {'joke': joke, 'why': why, 'hi': hi}
```

### Live tours

* `live.spl` — a quick smoke test of `ask` with `len`/`fmt`, `think`, `enforce`/`forbid` and `assert` against the real model.

* `tools-live.spl` — `read_file`, `write_file` and `think(show=True)` inside `restrict './sandbox'`. Run it after `mkdir sandbox; echo hello world > sandbox/note.txt`.

* `restrict-live.spl` — asks the model to read `secret.txt` outside the sandbox and shows the runtime blocking it, returning a `restriction_violation` payload.
