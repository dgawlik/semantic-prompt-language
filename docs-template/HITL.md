# Human in the loop

Pause an SPL workflow for external human review without making the CLI interactive.
A question is durable JSON, not a terminal prompt: SPL exits, your orchestrator
collects an answer, and a later invocation continues without repeating completed
tools or model calls.

## Write a question

`human` is a string-valued expression, distinct from model-only `ask`:

```spl
let feedback = human 'What should change in the release notes?'
assert len(feedback.strip()) > 0 'feedback must not be blank'
success feedback
```

There are no LLM modifiers, schemas, automatic repairs, or scoped model guidance
for human input. The expression returns the exact answer, including whitespace.
Validate it with ordinary code or explicitly ask another question.

Questions work inside functions, loops, nested expressions and policy blocks.
Suspension bypasses `except`; it is not a script failure. Every dynamic question
gets a distinct request ID, even when it comes from the same source line.
Executable scripts containing `human` require checkpoint mode before any effects.
`--check` remains syntax-only. `human` is reserved; rename existing bindings with
that name.

## Start, inspect and answer

Start a run and inspect its pending question:

```bash
spl examples/human-review.spl --checkpoint run.jsonl --silent
spl examples/human-review.spl --resume run.jsonl --silent
```

Both commands exit `3` while waiting and print the same pending request. SPL never
reads stdin, opens an interactive prompt, polls, or leaves a process waiting:

```json
{
  "status": "waiting_for_input",
  "run_id": "run-identifier",
  "request_id": "request-identifier",
  "question": "Review this draft...",
  "checkpoint": "absolute-state-path",
  "line": 9
}
```

Pending inspection does not execute the script, call tools, or require model
authentication. Submit exactly one answer in a later invocation:

```bash
spl examples/human-review.spl --resume run.jsonl --answer-for REQUEST_ID --answer "Make it shorter"
spl examples/human-review.spl --resume run.jsonl --answer-for REQUEST_ID --answer-file feedback.txt
```

These are alternatives, not two submissions. `--answer-for` must match the current
pending request. Stale, missing, duplicate, or mismatched submissions fail with code
`2` without advancing the run. Empty answers are valid protocol values; scripts may
reject them with an assertion. Answer files retain all whitespace, including their
final newline. Neither form reads stdin. Prefer answer files for private or multiline
text rather than putting it in process arguments.

A valid answer is persisted before continuing. A run can ask more questions;
do not automatically reuse an earlier answer for a new request ID.

## Automation protocol

Resumable runs emit one JSON envelope on stdout, including with `--silent`.
Logs and syntax/usage errors remain on stderr. Ordinary runs without checkpoint
mode retain their existing output format.

| Exit code | Meaning |
| --- | --- |
| `0` | Completed successfully. |
| `1` | Script failure. |
| `2` | Syntax, usage, incompatible state, or invalid answer submission. |
| `3` | Waiting for human input, not a script failure. |
| `70` | Internal or checkpoint persistence/infrastructure error. |

Completion uses the same run ID:

```json
{"status":"success","run_id":"run-identifier","has_value":true,"value":"accepted result"}
```

Failures use `{"status":"failure","run_id":"...","failure":{...}}`, where `failure`
is the ordinary [SPL failure payload](Failures.md#failure-payload). A successful
script with no result has `has_value: false` and `value: null`. State I/O failures
never print success-shaped or waiting output. See [CLI options](CLI.md#options)
for flag details.

## Resume guarantees and limits

The `spl-checkpoint` version 1 JSONL journal is separate from trace/record files.
It durably records external-effect intents and outcomes, human questions/answers,
and observed runtime-input fingerprints. On resume, ordinary computation reruns
to reconstruct scopes, closures, collections and loop positions. Completed raw
tools, generation attempts, caught failures, and agent results use recorded
outcomes without executing again. Historical script logs and model transcripts
are suppressed. After the recorded prefix, new operations run live.

This is not a filesystem or interpreter-stack snapshot. Preserve the same workspace,
including earlier agent/tool-produced files. Historical reads return old recorded
text; future reads see current files. The journal does not restore or undo actions.
The guarantee is no repeat of durably recorded completed effects, not universal
exactly-once execution: an interrupted action may have completed externally before
its outcome could be saved. SPL rejects interrupted/uncertain runs for manual
recovery instead of retrying. There is no force-retry or automatic crash recovery.

Resume requires the same script contents, runtime build/Node version, canonical
working directory, and model/MCP configuration. Repeat the original `--model` and
`--mcp` options when applicable. Original `$args` are restored; conflicting `--arg`
overrides fail. If the script has observed `$env`, the entire environment snapshot
must match. SPL stores its fingerprint rather than all environment values in
plaintext. Changed input/configuration and history mismatches fail explicitly.

Only one writer can open a journal. Do not delete a stale `.lock` and retry an
uncertain action. Terminal runs cannot resume. `--checkpoint` and `--resume` are
mutually exclusive and cannot combine with `--trace`, `--record`, `--replay`,
`--store`, or `--store-module`.

Treat journals and answer files as sensitive, trusted control-plane data. Prompts,
tool arguments/results and answers may contain secrets. New journal/lock files use
owner-only permissions where the operating system supports them; do not commit or
publish them. Request IDs prevent accidental stale answers, not unauthorized access.
SPL does not authenticate the answerer or prove they are human.

## GitHub Actions integration

The orchestrator owns question delivery, approval authorization and subsequent
invocation. Use a self-hosted runner or equivalent persistent workspace with a
fixed working directory. A later fresh hosted runner is not supported by simply
uploading the journal: it is not a workspace artifact or portable snapshot.
Do not clean/recheckout away state or produced files between invocations.

In a Bash `run` step, handle exit `3` explicitly rather than treating it as an error
or hiding all failures with `continue-on-error`. Set `RUN_STATE` to an absolute
path in the preserved workspace:

```bash
set +e
spl examples/human-review.spl --checkpoint "$RUN_STATE" --silent > result.json
code=$?
set -e
case "$code" in
  0|3) ;;
  *) cat result.json; exit "$code" ;;
esac
printf 'status=%s\n' "$(jq -r '.status' result.json)" >> "$GITHUB_OUTPUT"
if [ "$code" -eq 3 ]; then
  printf 'request_id=%s\n' "$(jq -r '.request_id' result.json)" >> "$GITHUB_OUTPUT"
fi
```

Publish the question only to an authorized channel. After that system supplies
`REQUEST_ID` and a UTF-8 `ANSWER_FILE`, invoke the following in the same workspace,
with the same exit-code handling. Pass values through quoted environment variables
or files, not interpolated shell source:

```bash
spl examples/human-review.spl --resume "$RUN_STATE" \
  --answer-for "$REQUEST_ID" --answer-file "$ANSWER_FILE" --silent > result.json
```

An answer can lead to another question. Route each new pending request through the
same external approval mechanism. SPL provides the durable handoff, not a built-in
GitHub approval service.

## Example and embedding

The [human review example](Examples.md#human-review) writes a draft once, asks for
feedback without model authentication, and writes the exact accepted answer.
For programmatic use, see [embedding resumable runs](Internals.md#embedding-resumable-runs).
